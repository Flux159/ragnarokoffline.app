/**
 * Graphics+: real-time shadows from the map's sun. The static models
 * (buildings, trees, walls) are drawn from the light's direction into a
 * depth texture around the player; then, once the ground is drawn and
 * before anything else is, every ground pixel the sun cannot see is
 * darkened. RO bakes soft shadows into each map's lightmap already, so these
 * are a moderate, sharper layer on top. Two map hook stages: 'begin' draws
 * the shadow map, 'ground' applies it.
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
uniform sampler2D uShadowMap;
uniform mat4 uInverseViewProjection;
uniform mat4 uShadowMat;
uniform float uTexel;
uniform float uStrength;
out vec4 fragColor;
void main() {
	float depth = texture(uDepth, vUv).r;
	if (depth >= 1.0) discard;
	vec4 world = uInverseViewProjection * vec4(vec3(vUv, depth) * 2.0 - 1.0, 1.0);
	world /= world.w;
	vec4 light = uShadowMat * world;
	vec3 p = light.xyz / light.w * 0.5 + 0.5;
	if (p.x <= 0.0 || p.x >= 1.0 || p.y <= 0.0 || p.y >= 1.0 || p.z >= 1.0) discard;
	// 0 lit .. 1 hidden from the sun, averaged over 3x3 texels for soft edges.
	float hidden = 0.0;
	for (int x = -1; x <= 1; x++) {
		for (int y = -1; y <= 1; y++) {
			float closest = texture(uShadowMap, p.xy + vec2(float(x), float(y)) * uTexel).r;
			hidden += p.z - 0.0015 > closest ? 1.0 : 0.0;
		}
	}
	float shade = 1.0 - hidden / 9.0 * uStrength * 0.6;
	// Multiplied into what is there (blend DST_COLOR, ZERO).
	fragColor = vec4(vec3(shade), 1.0);
}`;

function drawMap(ctx, strength) {
	const { gl, light } = ctx;
	_current = null;
	if (!(strength > 0) || !light || !light.direction || !ctx.player) return;
	if (!ensure(gl)) return;
	if (!_program) _program = ctx.createProgram(VERTEX, FRAGMENT);
	const p = ctx.player;
	const matrix = lightMatrix(light.direction, [p[0] + 0.5, -p[2], p[1] + 0.5]);
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
}

function apply(ctx) {
	if (!_current) return;
	const { gl } = ctx;
	const depth = SceneCopy.depth(gl);
	if (!depth) return;
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
	gl.bindTexture(gl.TEXTURE_2D, _fbo.texture);
	gl.uniform1i(uniform.uShadowMap, 1);
	gl.activeTexture(gl.TEXTURE0);
	gl.uniformMatrix4fv(uniform.uInverseViewProjection, false, inverse);
	gl.uniformMatrix4fv(uniform.uShadowMat, false, _current.matrix);
	gl.uniform1f(uniform.uTexel, 1 / SIZE);
	gl.uniform1f(uniform.uStrength, _current.strength);
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

/** Shadows as a map hook. strength: 0..1 */
export function shadowsHook(strength) {
	return {
		name: 'Shadows',
		render(stage, ctx) {
			if (stage === 'begin') {
				drawMap(ctx, strength);
				if (_current) ctx.restoreTarget();
			} else if (stage === 'ground') {
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
			SceneCopy.free(gl);
		},
	};
}
