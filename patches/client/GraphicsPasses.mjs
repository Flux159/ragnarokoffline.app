// Graphics passes from client plugins (api.graphics.registerPass).
//
// A pass is a full-screen GLSL fragment shader that runs on the finished 3D
// frame, after bloom and blur and before anti-aliasing (the roBrowser fork's
// PostProcess.addExternal). A plugin writes only `void main()`; this module
// supplies everything else -- the frame so far, its depth, the time, the map's
// sun and its point lights already projected onto the screen -- so a colour
// grade, fog, a vignette or a lamp glow is a few lines of GLSL in a mod.
//
// Nothing here can reach past the GPU: a bad shader fails to compile, is
// reported, and stays off.

import PostProcess from 'Renderer/Effects/PostProcess.js';
import MapHooks from 'Renderer/MapHooks.js';
import WebGL from 'Utils/WebGL.js';

export const MAX_LIGHTS = 32;

const VERTEX = `#version 300 es
precision highp float;
in vec2 aPosition;
out vec2 vUv;
void main() {
	vUv = aPosition * 0.5 + 0.5;
	gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

// What every pass's fragment shader starts with. The plugin's source follows,
// numbered from line 1 so its compile errors point at its own lines.
const HEADER = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTexture;      // the frame so far
uniform sampler2D uDepth;        // the scene's depth, 0 near .. 1 far (all 1 without WebGL 2)
uniform bool uHasDepth;          // false when uDepth is that stand-in
uniform vec2 uResolution;        // in pixels
uniform float uTime;             // seconds
uniform float uNear;
uniform float uFar;
uniform vec3 uSunDirection;      // the map's light, world space
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform int uLightCount;
uniform vec4 uLights[${MAX_LIGHTS}];       // xy: on screen (0..1), z: radius (fraction of screen height), w: strength
uniform vec3 uLightColors[${MAX_LIGHTS}];
// Distance from the camera, in world units, of what is drawn at uv.
float linearDepth(vec2 uv) {
	float z = texture(uDepth, uv).r * 2.0 - 1.0;
	return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}
#line 1
`;

const QUAD = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);

// The lights on screen this frame, shared by every pass: computed once per
// PostProcess.scene, which MapRenderer replaces each frame.
let lightsFor = null;
let lightsCache = { count: 0, positions: new Float32Array(MAX_LIGHTS * 4), colors: new Float32Array(MAX_LIGHTS * 3) };

function transform(m, v) {
	return [0, 1, 2, 3].map(r => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]);
}

function screenLights(scene) {
	if (scene === lightsFor) return lightsCache;
	lightsFor = scene;
	const found = [];
	for (const light of scene?.lights || []) {
		if (!light.world) continue;
		const eye = transform(scene.modelView, [...light.world, 1]);
		const clip = transform(scene.projection, eye);
		if (clip[3] <= 0.01) continue;  // behind the camera
		const x = (clip[0] / clip[3] + 1) / 2;
		const y = (clip[1] / clip[3] + 1) / 2;
		// The radius on screen: how far a point light.radius to the side lands.
		const side = transform(scene.projection, [eye[0] + light.radius, eye[1], eye[2], eye[3]]);
		const radius = Math.abs(side[1] / side[3] - clip[1] / clip[3]) / 2 + Math.abs(side[0] / side[3] - clip[0] / clip[3]) / 2;
		if (x < -radius || x > 1 + radius || y < -radius || y > 1 + radius) continue;
		found.push({ x, y, radius, depth: -eye[2], rgb: light.rgb || [1, 1, 1] });
	}
	found.sort((a, b) => a.depth - b.depth);
	const count = Math.min(found.length, MAX_LIGHTS);
	for (let i = 0; i < count; i++) {
		lightsCache.positions.set([found[i].x, found[i].y, found[i].radius, 1], i * 4);
		lightsCache.colors.set(found[i].rgb, i * 3);
	}
	lightsCache.count = count;
	return lightsCache;
}

function setUniform(gl, location, value) {
	if (location == null) return;
	if (typeof value === 'number') gl.uniform1f(location, value);
	else if (typeof value === 'boolean') gl.uniform1i(location, value ? 1 : 0);
	else if (Array.isArray(value) || ArrayBuffer.isView(value)) {
		if (value.length === 2) gl.uniform2fv(location, value);
		else if (value.length === 3) gl.uniform3fv(location, value);
		else if (value.length === 4) gl.uniform4fv(location, value);
		else if (value.length === 16) gl.uniformMatrix4fv(location, false, value);
		else gl.uniform1fv(location, value);
	}
}

/**
 * A PostProcess module for one plugin pass.
 * @param {{name: string, fragment: string, uniforms?: Function, enabled?: Function}} spec
 * @param {Function} report - where compile and runtime errors go
 */
function makePass(spec, report) {
	let program = null, buffer = null, white = null;
	const locations = new Map();
	let failed = false;
	const location = (gl, name) => {
		if (!locations.has(name)) locations.set(name, gl.getUniformLocation(program, name));
		return locations.get(name);
	};

	const module = {
		program: () => program,
		isActive() {
			if (!program || failed) return false;
			try { return spec.enabled ? Boolean(spec.enabled()) : true; } catch (error) { report(error); return false; }
		},
		init(gl) {
			try {
				program = WebGL.createShaderProgram(gl, VERTEX, HEADER + spec.fragment);
			} catch (error) {
				program = null;
				report(new Error(`graphics pass "${spec.name}" did not compile: ${error.message || error}`));
				return;
			}
			buffer = gl.createBuffer();
			gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
			gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW);
			// Without a depth texture, depth reads as "far" everywhere.
			white = gl.createTexture();
			gl.bindTexture(gl.TEXTURE_2D, white);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
			locations.clear();
		},
		render(gl, inputTexture, outputFbo) {
			PostProcess.beforeRenderPass(gl, outputFbo);
			gl.useProgram(program);

			gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
			const position = program.attribute.aPosition;
			gl.enableVertexAttribArray(position);
			gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, inputTexture);
			gl.uniform1i(location(gl, 'uTexture'), 0);
			const depth = PostProcess.sceneDepth?.() || null;
			gl.activeTexture(gl.TEXTURE1);
			gl.bindTexture(gl.TEXTURE_2D, depth || white);
			gl.uniform1i(location(gl, 'uDepth'), 1);
			gl.uniform1i(location(gl, 'uHasDepth'), depth ? 1 : 0);
			gl.activeTexture(gl.TEXTURE0);

			const scene = PostProcess.scene || {};
			const width = outputFbo ? outputFbo.width : gl.canvas.width;
			const height = outputFbo ? outputFbo.height : gl.canvas.height;
			setUniform(gl, location(gl, 'uResolution'), [width, height]);
			setUniform(gl, location(gl, 'uTime'), performance.now() / 1000);
			setUniform(gl, location(gl, 'uNear'), scene.near ?? 1);
			setUniform(gl, location(gl, 'uFar'), scene.far ?? 1000);
			const light = scene.light || {};
			setUniform(gl, location(gl, 'uSunDirection'), light.direction || [0, -1, 0]);
			setUniform(gl, location(gl, 'uSunColor'), light.diffuse || [1, 1, 1]);
			setUniform(gl, location(gl, 'uAmbient'), light.ambient || [0.3, 0.3, 0.3]);

			const lights = screenLights(scene);
			gl.uniform1i(location(gl, 'uLightCount'), lights.count);
			const lightsAt = location(gl, 'uLights');
			if (lightsAt) gl.uniform4fv(lightsAt, lights.positions);
			const colorsAt = location(gl, 'uLightColors');
			if (colorsAt) gl.uniform3fv(colorsAt, lights.colors);

			if (typeof spec.uniforms === 'function') {
				try {
					const values = spec.uniforms({ time: performance.now() / 1000, width, height, lights: lights.count });
					for (const [name, value] of Object.entries(values || {})) setUniform(gl, location(gl, name), value);
				} catch (error) {
					failed = true;  // a throwing uniforms() would throw every frame
					report(error);
				}
			}

			gl.drawArrays(gl.TRIANGLES, 0, 6);
			PostProcess.afterRenderPass(gl);
		},
		clean(gl) {
			if (buffer) gl.deleteBuffer(buffer);
			if (white) gl.deleteTexture(white);
			buffer = white = null;
			// The program goes with the context; a later init makes a new one.
			program = null;
			locations.clear();
		},
	};
	return module;
}

/** Whether this client can take plugin passes (the fork's addExternal). */
export function supported() {
	return typeof PostProcess.addExternal === 'function' && typeof MapHooks?.register === 'function';
}

/**
 * Add a pass. Returns a function that removes it.
 * @param {object} spec - checked by ExtensionRuntime: name, fragment, uniforms?, enabled?
 * @param {Function} report
 */
export function registerPass(spec, report) {
	if (!supported()) {
		report(new Error('graphics passes need a newer client (PostProcess.addExternal)'));
		return () => {};
	}
	const module = makePass(spec, report);
	PostProcess.addExternal(module);
	return () => PostProcess.removeExternal(module);
}

/**
 * Add a map hook (the fork's Renderer/MapHooks.js): code that draws in the
 * map renderer -- grass, water, a shadow map. Returns a function that takes
 * it out and frees it.
 * @param {object} hook - checked by ExtensionRuntime
 */
export function hook(spec) {
    return MapHooks.register(spec);
}

/** The map's point lights, for a plugin that wants them itself. */
export function mapLights() {
	const scene = PostProcess.scene;
	return (scene?.lights || []).filter(light => light.world).map(light => ({
		x: light.world[0], y: light.world[2], height: -light.world[1],
		color: [...(light.rgb || [1, 1, 1])], radius: light.radius,
	}));
}
