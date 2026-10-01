/**
 * Graphics+: real-time shadows from the map's sun. The static models
 * (buildings, trees, walls) are drawn from the light's direction into a
 * depth texture around the player; then, once the ground is drawn and
 * before anything else is, every ground pixel the sun cannot see is
 * darkened. RO bakes soft shadows into each map's lightmap already, so these
 * are a moderate, sharper layer on top. Two map hook stages: 'begin' draws
 * the shadow map, 'models' applies it -- with contact shadows (ambient
 * occlusion from the depth) where walls meet the ground.
 */

import SceneCopy from './scene-copy.js';
import { invert } from './reflection.js';

const SIZE = 2048;     // shadow map, texels
const EXTENT = 56;     // half the width of the shadowed area, in cells
const DEPTH = 400;

const VERTEX = `#version 300 es
precision highp float;
in vec3 aPosition;
in vec2 aTextureCoord;
uniform mat4 uLightMat;
out vec2 vUv;
void main() {
	vUv = aTextureCoord;
	gl_Position = uLightMat * vec4(aPosition, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uDiffuse;
out vec4 fragColor;
void main() {
	// Leaves and fences cast the shape of what is drawn, not of their quad.
	if (texture(uDiffuse, vUv).a < 0.5) discard;
	fragColor = vec4(1.0);
}`;

let _fbo = null;
let _program = null;
let _current = null;
let _apply = null;
let _occlusion = 0;
let _drawn = null;   // the light view the shadow map holds
let _radius = 4.0;
let _quad = null;

function lookAt(eye, center, up) {
	let z = [eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]];
	let l = Math.hypot(z[0], z[1], z[2]) || 1;
	z = z.map(v => v / l);
	let x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
	l = Math.hypot(x[0], x[1], x[2]) || 1;
	x = x.map(v => v / l);
	const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
	const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}

function multiply(a, b) {
	const out = new Float32Array(16);
	for (let col = 0; col < 4; col++) {
		for (let row = 0; row < 4; row++) {
			let sum = 0;
			for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
			out[col * 4 + row] = sum;
		}
	}
	return out;
}

function ensure(gl, createProgram) {
	if (_fbo) return true;
	const texture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SIZE, SIZE, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	const framebuffer = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, texture, 0);
	gl.drawBuffers([gl.NONE]);
	gl.readBuffer(gl.NONE);
	const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	if (!ok) {
		gl.deleteFramebuffer(framebuffer);
		gl.deleteTexture(texture);
		return false;
	}
	_fbo = { framebuffer, texture };
	return true;
}

/**
 * The light's view of the area around `center` (world space): an orthographic
 * box along the sun's direction, snapped to the shadow map's texel grid so
 * shadow edges don't shimmer as the player walks.
 */
function lightMatrix(direction, center) {
	const d = direction;
	const l = Math.hypot(d[0], d[1], d[2]) || 1;
	const toward = [d[0] / l, d[1] / l, d[2] / l];
	const up = Math.abs(toward[1]) > 0.95 ? [0, 0, 1] : [0, -1, 0];
	const texel = (2 * EXTENT) / SIZE;
	const snapped = [Math.round(center[0] / texel) * texel, center[1], Math.round(center[2] / texel) * texel];
	const eye = [snapped[0] + toward[0] * DEPTH / 2, snapped[1] + toward[1] * DEPTH / 2, snapped[2] + toward[2] * DEPTH / 2];
	const view = lookAt(eye, snapped, up);
	const r = EXTENT, near = 1, far = DEPTH;
	const ortho = [1 / r, 0, 0, 0, 0, 1 / r, 0, 0, 0, 0, -2 / (far - near), 0, 0, 0, -(far + near) / (far - near), 1];
	return multiply(ortho, view);
}


// Applying it: a full-screen triangle over the ground only, reading the
// ground's depth back into world space.
const APPLY_VERTEX = `#version 300 es
precision highp float;
in vec2 aPosition;
out vec2 vUv;
void main() {
	vUv = aPosition * 0.5 + 0.5;
	gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const APPLY_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uDepth;
uniform sampler2D uColor;
uniform sampler2D uShadowMap;
uniform mat4 uInverseViewProjection;
uniform mat4 uShadowMat;
uniform vec2 uProj;        // projection[10], projection[14]
uniform vec2 uResolution;
uniform float uTexel;
uniform float uStrength;   // sun shadows, 0 .. 1
uniform float uOcclusion;  // contact shadows, 0 .. 1
uniform bool uHasShadowMap;
uniform mat4 uProjection;
uniform mat4 uInverseProjection;
uniform float uRadius;      // contact-shadow reach, world units
out vec4 fragColor;

vec3 viewPosition(vec2 uv) {
	vec4 p = uInverseProjection * vec4(vec3(uv, texture(uDepth, uv).r) * 2.0 - 1.0, 1.0);
	return p.xyz / p.w;
}

void main() {
	float depth = texture(uDepth, vUv).r;
	if (depth >= 1.0) discard;
	float shade = 1.0;

	// Sun: where the shadow map says the sun is blocked -- but only where
	// the map is not already in shadow (its lightmap baked it in), so the
	// two never stack into black.
	if (uHasShadowMap && uStrength > 0.0) {
		vec4 world = uInverseViewProjection * vec4(vec3(vUv, depth) * 2.0 - 1.0, 1.0);
		world /= world.w;
		vec4 light = uShadowMat * world;
		vec3 p = light.xyz / light.w * 0.5 + 0.5;
		if (p.x > 0.0 && p.x < 1.0 && p.y > 0.0 && p.y < 1.0 && p.z < 1.0) {
			float hidden = 0.0;
			for (int x = -1; x <= 1; x++) {
				for (int y = -1; y <= 1; y++) {
					float closest = texture(uShadowMap, p.xy + vec2(float(x), float(y)) * uTexel).r;
					hidden += p.z - 0.0015 > closest ? 1.0 : 0.0;
				}
			}
			vec3 here = texture(uColor, vUv).rgb;
			float lit = smoothstep(0.25, 0.55, dot(here, vec3(0.299, 0.587, 0.114)));
			shade *= 1.0 - hidden / 9.0 * uStrength * 0.55 * lit;
		}
	}

	// Contact: points in a small hemisphere above the surface here; the
	// share of them that end up inside something is how enclosed it is --
	// the foot of a wall, under eaves, between crates.
	if (uOcclusion > 0.0) {
		vec3 here = viewPosition(vUv);
		vec3 normal = normalize(cross(dFdx(here), dFdy(here)));
		if (dot(normal, here) > 0.0) normal = -normal;   // facing the camera
		float spin = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) * 6.2831;
		vec3 helper = abs(normal.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
		vec3 tangent = normalize(cross(helper, normal));
		vec3 bitangent = cross(normal, tangent);
		float occluded = 0.0;
		const int N = 8;
		for (int i = 0; i < N; i++) {
			float k = (float(i) + 0.5) / float(N);
			float a = float(i) * 2.39996 + spin;
			float r = sqrt(k);
			vec3 dir = tangent * cos(a) * r + bitangent * sin(a) * r + normal * sqrt(max(1.0 - k, 0.0));
			vec3 point = here + dir * uRadius * mix(0.2, 1.0, k * k);
			vec4 clip = uProjection * vec4(point, 1.0);
			vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
			if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;
			float scene = viewPosition(uv).z;
			// Something in front of the sample point (closer to the eye),
			// and near enough to be what encloses it.
			float range = smoothstep(0.0, 1.0, uRadius / max(abs(here.z - scene), 1e-3));
			occluded += (scene >= point.z + 0.02 * uRadius ? 1.0 : 0.0) * range;
		}
		shade *= 1.0 - min(occluded / float(N) * 1.6, 1.0) * uOcclusion * 0.75;
	}

	// Multiplied into what is there (blend DST_COLOR, ZERO).
	fragColor = vec4(vec3(shade), 1.0);
}`;

function drawMap(ctx, strength) {
	const { gl, light } = ctx;
	if (!(strength > 0) || !light || !light.direction || !ctx.player) { _current = null; return false; }
	if (!ensure(gl)) { _current = null; return false; }
	if (!_program) _program = ctx.createProgram(VERTEX, FRAGMENT);
	const p = ctx.player;
	const matrix = lightMatrix(light.direction, [p[0] + 0.5, -p[2], p[1] + 0.5]);
	// The map's models never move, and the view is snapped to the shadow
	// map's texels: unless it has changed, last frame's map is this frame's.
	if (_current && _drawn && matrix.every((v, i) => v === _drawn[i])) {
		_current = { matrix, strength: Math.min(1, strength) };
		return false;
	}
	_drawn = matrix;
	gl.bindFramebuffer(gl.FRAMEBUFFER, _fbo.framebuffer);
	gl.viewport(0, 0, SIZE, SIZE);
	gl.enable(gl.DEPTH_TEST);
	gl.depthMask(true);
	gl.clear(gl.DEPTH_BUFFER_BIT);
	gl.useProgram(_program);
	gl.uniformMatrix4fv(_program.uniform.uLightMat, false, matrix);
	gl.uniform1i(_program.uniform.uDiffuse, 0);
	ctx.drawModelsDepth(_program);
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	_current = { matrix, strength: Math.min(1, strength) };
	return true;
}

function apply(ctx) {
	if (!_current && !(_occlusion > 0)) return;
	const { gl } = ctx;
	const depth = SceneCopy.depth(gl, ctx.tick + ':models');
	if (!depth) return;
	// What the ground looks like already: no extra shadow where the map has
	// baked one in.
	const color = SceneCopy.color(gl);
	if (!_apply) _apply = ctx.createProgram(APPLY_VERTEX, APPLY_FRAGMENT);
	if (!_quad) {
		_quad = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, _quad);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
	}
	const inverse = invert(multiply(ctx.projection, ctx.modelView));
	if (!inverse) return;
	const uniform = _apply.uniform;
	gl.useProgram(_apply);
	gl.activeTexture(gl.TEXTURE0);
	gl.bindTexture(gl.TEXTURE_2D, depth);
	gl.uniform1i(uniform.uDepth, 0);
	gl.activeTexture(gl.TEXTURE1);
	gl.bindTexture(gl.TEXTURE_2D, _current ? _fbo.texture : null);
	gl.uniform1i(uniform.uShadowMap, 1);
	gl.activeTexture(gl.TEXTURE2);
	gl.bindTexture(gl.TEXTURE_2D, color);
	gl.uniform1i(uniform.uColor, 2);
	gl.activeTexture(gl.TEXTURE0);
	const vp = gl.getParameter(gl.VIEWPORT);
	gl.uniform2f(uniform.uResolution, vp[2], vp[3]);
	gl.uniform2f(uniform.uProj, ctx.projection[10], ctx.projection[14]);
	gl.uniformMatrix4fv(uniform.uProjection, false, ctx.projection);
	const inverseProjection = invert(ctx.projection);
	if (inverseProjection) gl.uniformMatrix4fv(uniform.uInverseProjection, false, inverseProjection);
	gl.uniform1f(uniform.uRadius, _radius);
	gl.uniform1i(uniform.uHasShadowMap, _current ? 1 : 0);
	gl.uniform1f(uniform.uOcclusion, _occlusion);
	gl.uniformMatrix4fv(uniform.uInverseViewProjection, false, inverse);
	gl.uniformMatrix4fv(uniform.uShadowMat, false, _current ? _current.matrix : new Float32Array(16));
	gl.uniform1f(uniform.uTexel, 1 / SIZE);
	gl.uniform1f(uniform.uStrength, _current ? _current.strength : 0);
	gl.bindBuffer(gl.ARRAY_BUFFER, _quad);
	gl.enableVertexAttribArray(_apply.attribute.aPosition);
	gl.vertexAttribPointer(_apply.attribute.aPosition, 2, gl.FLOAT, false, 0, 0);
	const depthTest = gl.isEnabled(gl.DEPTH_TEST);
	const depthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
	const blend = gl.isEnabled(gl.BLEND);
	gl.disable(gl.DEPTH_TEST);
	gl.depthMask(false);
	gl.enable(gl.BLEND);
	gl.blendFunc(gl.DST_COLOR, gl.ZERO);
	gl.drawArrays(gl.TRIANGLES, 0, 3);
	gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
	if (!blend) gl.disable(gl.BLEND);
	gl.depthMask(depthMask);
	if (depthTest) gl.enable(gl.DEPTH_TEST);
	gl.disableVertexAttribArray(_apply.attribute.aPosition);
}

/** Shadows as a map hook. strength: sun shadows 0..1; occlusion: contact shadows 0..1 */
export function shadowsHook(strength, occlusion = 0) {
	_occlusion = occlusion;
	return {
		name: 'Shadows',
		render(stage, ctx) {
			if (stage === 'begin') {
				// Back to the scene's own target only if it was left for ours.
				if (drawMap(ctx, strength)) ctx.restoreTarget();
			} else if (stage === 'models') {
				// After the models: they take shadows and contact shading too.
				apply(ctx);
			}
		},
		free(gl) {
			if (_fbo) {
				gl.deleteFramebuffer(_fbo.framebuffer);
				gl.deleteTexture(_fbo.texture);
				_fbo = null;
			}
			for (const program of [_program, _apply]) if (program) gl.deleteProgram(program);
			if (_quad) gl.deleteBuffer(_quad);
			_program = _apply = _quad = null;
			_current = null;
			_drawn = null;
			SceneCopy.free(gl);
		},
	};
}
