/**
 * Graphics+: the water, drawn in the client's place (a map hook that
 * replaces the 'water' stage). The map's own water texture and waves, with:
 * a reflection of what stands above it (reflection.js), darkened and cooled,
 * deep navy where nothing does; the scene's depth (scene-copy.js) for how
 * deep the water is -- a teal glow along the shore, the rock fading into it;
 * a slow swell bending the reflection.
 */

import SceneCopy from './scene-copy.js';
import * as Reflection from './reflection.js';

const VERTEX = `#version 300 es
precision highp float;

in vec3 aPosition;
in vec2 aTextureCoord;

out vec2 vTextureCoord;
out vec3 vEye;
out vec3 vWorld;

uniform mat4 uModelViewMat;
uniform mat4 uProjectionMat;

uniform float uWaveHeight;
uniform float uWavePitch;
uniform float uWaterOffset;

const float PI = 3.14159265358979323846264;

void main(void) {
    float x       = mod( aPosition.x, 2.0);
    float y       = mod( aPosition.z, 2.0);
    float diff    = x < 1.0 ? y < 1.0 ? 1.0 : -1.0 : 0.0;
    float Height  = sin((PI / 180.0) * (uWaterOffset + 0.5 * uWavePitch * (aPosition.x + aPosition.z + diff))) * uWaveHeight;

    vec4 eye      = uModelViewMat * vec4( aPosition.x, aPosition.y + Height, aPosition.z, 1.0);
    gl_Position   = uProjectionMat * eye;
    vTextureCoord = aTextureCoord;
    vEye          = eye.xyz;
    vWorld        = aPosition;
}`;

const FRAGMENT = `#version 300 es
precision highp float;

in vec2 vTextureCoord;
in vec3 vEye;
in vec3 vWorld;
out vec4 fragColor;

// Planar reflection (WaterReflection.js), off when uReflect is 0.
uniform float     uReflect;
uniform sampler2D uReflection;
uniform vec2      uScreen;
uniform float     uTime;
uniform vec3      uEyeNormal;
uniform vec3      uEyeSun;
// The scene's depth before the water (Water.js), to know how deep it is here.
uniform bool      uHasDepth;
uniform sampler2D uSceneDepth;
uniform vec2      uProj;   // projection[10], projection[14]
uniform float     uRain;   // 0 dry .. 1 pouring: rings where drops land

uniform sampler2D uDiffuse;

uniform bool  uFogUse;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3  uFogColor;

uniform vec3  uLightAmbient;
uniform vec3  uLightDiffuse;
uniform float uLightOpacity;

uniform float uOpacity;

void main(void) {
    
    vec4 textureSample = texture( uDiffuse,  vTextureCoord.st );
    textureSample.a = uOpacity;
    
    if (textureSample.a == 0.0) {
        discard;
    }
    
    textureSample.a *= uOpacity;

    if (uReflect > 0.0) {
        // Smooth, slow swell: a few long waves across the world, no texture.
        vec2 p = vWorld.xz;
        float t = uTime;
        vec2 swell = vec2(
            sin(p.x * 0.35 + p.y * 0.12 + t * 0.9) + 0.6 * sin(p.x * 0.9 - p.y * 0.55 + t * 1.7) + 0.3 * sin(p.y * 1.9 + t * 2.3),
            cos(p.y * 0.31 - p.x * 0.15 + t * 0.8) + 0.6 * cos(p.y * 0.85 + p.x * 0.6 + t * 1.5) + 0.3 * cos(p.x * 2.1 - t * 2.1));
        vec2 ripple = swell * 0.006;

        // Rain: expanding rings where drops land, a few per cell of a grid
        // in world space, each on its own clock.
        float rings = 0.0;
        vec2 ringSlope = vec2(0.0);
        if (uRain > 0.0) {
            for (int k = 0; k < 2; k++) {
                vec2 q = vWorld.xz * (k == 0 ? 0.3 : 0.45) + float(k) * 17.3;
                vec2 cell = floor(q);
                float seed = fract(sin(dot(cell, vec2(127.1, 311.7))) * 43758.5453);
                float life = fract(t * 0.9 + seed);
                vec2 centre = cell + 0.25 + 0.5 * vec2(fract(seed * 7.3), fract(seed * 13.1));
                vec2 d = q - centre;
                float dist = length(d);
                float radius = life * 0.5;
                float ring = exp(-pow((dist - radius) * 16.0, 2.0)) * (1.0 - life) * step(seed, uRain * 0.9);
                rings += ring;
                ringSlope += normalize(d + 1e-4) * ring;
            }
            ripple += ringSlope * 0.004;
        }

        // How much water the eye looks through here.
        float thick = 40.0;
        if (uHasDepth) {
            float zn = texture(uSceneDepth, gl_FragCoord.xy / uScreen).r * 2.0 - 1.0;
            float behind = uProj.y / (zn + uProj.x);
            thick = max(behind - (-vEye.z), 0.0);
        }
        float clear = exp(-thick * 0.35);           // 1 at the shore, fading out over a few cells

        // Mostly a mirror of what stands above it, darkened, with a deep
        // navy where nothing does; a teal see-through band at the shore.
        vec3 reflection = texture(uReflection, gl_FragCoord.xy / uScreen + ripple).rgb;
        // Water darkens and cools what it reflects; reflected sky reads as
        // deep navy, the way still water looks from above.
        float rl = dot(reflection, vec3(0.299, 0.587, 0.114));
        vec3 mirror = reflection * vec3(0.42, 0.56, 0.62);
        vec3 navy = vec3(0.03, 0.07, 0.15);
        mirror = mix(mirror, navy, smoothstep(0.6, 0.85, rl));
        mirror = mix(navy, mirror, smoothstep(0.0, 0.04, rl));  // nothing above: navy
        vec3 body = vec3(0.03, 0.16, 0.19) * clamp(uLightAmbient + uLightDiffuse, 0.4, 1.2);
        vec3 color = mix(mirror, body, 0.18);
        // Light scattered in the water near the rock: a broad teal glow
        // along the shore, the rock just visible through the narrowest band.
        float glow = exp(-thick * 0.07);
        color = mix(color, vec3(0.12, 0.42, 0.42), glow * 0.5);
        float alpha = mix(0.95, 0.5, clear * clear * (3.0 - 2.0 * clear));
        vec3 view = normalize(-vEye);
        vec3 n = normalize(uEyeNormal + vec3(swell.x, 0.0, swell.y) * 0.08);
        float sun = pow(max(dot(reflect(-normalize(uEyeSun), n), view), 0.0), 60.0);
        color += uLightDiffuse * sun * 0.35;
        color += vec3(0.4, 0.5, 0.55) * rings * 0.5 * uRain;
        color *= mix(1.0, 0.85, uRain);  // overcast
        // A line of light where it meets the shore.
        color += vec3(0.18, 0.24, 0.22) * exp(-thick * 1.2) * (0.75 + 0.25 * sin(t * 2.0 + vWorld.x + vWorld.z));  // a soft lap of light at the edge
        textureSample = vec4(color, mix(textureSample.a, alpha, uReflect));
    }

    fragColor   = textureSample;

    if (uFogUse) {
        float depth     = gl_FragCoord.z / gl_FragCoord.w;
        float fogFactor = smoothstep( uFogNear, uFogFar, depth );
        fragColor    = mix( fragColor, vec4( uFogColor, fragColor.w ), fogFactor );
    }
}`;

let _program = null;
let _reflection = null;   // this frame's reflection texture
let _map = null;
let _settings = { reflection: 0.6 };

function draw(ctx) {
	const water = _map && _map.water();
	if (!water) return;
	const { gl, modelView, projection, fog, light, tick } = ctx;
	if (!_program) _program = ctx.createProgram(VERTEX, FRAGMENT);
	const uniform = _program.uniform;
	const attribute = _program.attribute;
	const frame = tick / (1000 / 60);

	gl.useProgram(_program);
	gl.uniformMatrix4fv(uniform.uModelViewMat, false, modelView);
	gl.uniformMatrix4fv(uniform.uProjectionMat, false, projection);
	gl.uniform1i(uniform.uFogUse, fog.use && fog.exist);
	gl.uniform1f(uniform.uFogNear, fog.near);
	gl.uniform1f(uniform.uFogFar, fog.far);
	gl.uniform3fv(uniform.uFogColor, fog.color);

	gl.enableVertexAttribArray(attribute.aPosition);
	gl.enableVertexAttribArray(attribute.aTextureCoord);
	gl.bindBuffer(gl.ARRAY_BUFFER, water.buffer);
	gl.vertexAttribPointer(attribute.aPosition, 3, gl.FLOAT, false, 5 * 4, 0);
	gl.vertexAttribPointer(attribute.aTextureCoord, 2, gl.FLOAT, false, 5 * 4, 3 * 4);
	gl.activeTexture(gl.TEXTURE0);
	gl.uniform1i(uniform.uDiffuse, 0);

	const reflect = _reflection ? Math.min(1, _settings.reflection) : 0;
	const sceneDepth = reflect > 0 ? SceneCopy.depth(gl) : null;
	gl.uniform1f(uniform.uReflect, reflect);
	if (reflect > 0) {
		const viewport = gl.getParameter(gl.VIEWPORT);
		gl.activeTexture(gl.TEXTURE1);
		gl.bindTexture(gl.TEXTURE_2D, _reflection);
		gl.uniform1i(uniform.uReflection, 1);
		gl.activeTexture(gl.TEXTURE0);
		gl.uniform2f(uniform.uScreen, viewport[2], viewport[3]);
		gl.uniform1f(uniform.uTime, tick / 1000);
		gl.uniform1i(uniform.uHasDepth, sceneDepth ? 1 : 0);
		if (sceneDepth) {
			gl.activeTexture(gl.TEXTURE2);
			gl.bindTexture(gl.TEXTURE_2D, sceneDepth);
			gl.uniform1i(uniform.uSceneDepth, 2);
			gl.activeTexture(gl.TEXTURE0);
		}
		gl.uniform2f(uniform.uProj, projection[10], projection[14]);
		gl.uniform1f(uniform.uRain, 0);
		// Up (-y in RO) and the sun, in eye space.
		const n = [-modelView[4], -modelView[5], -modelView[6]];
		const nl = Math.hypot(n[0], n[1], n[2]) || 1;
		gl.uniform3f(uniform.uEyeNormal, n[0] / nl, n[1] / nl, n[2] / nl);
		const d = light && light.direction ? light.direction : [0, -1, 0];
		gl.uniform3f(uniform.uEyeSun,
			modelView[0] * d[0] + modelView[4] * d[1] + modelView[8] * d[2],
			modelView[1] * d[0] + modelView[5] * d[1] + modelView[9] * d[2],
			modelView[2] * d[0] + modelView[6] * d[1] + modelView[10] * d[2]);
		gl.uniform3fv(uniform.uLightDiffuse, light && light.diffuse ? light.diffuse : [1, 1, 1]);
	}

	gl.uniform1f(uniform.uWaveHeight, water.waveHeight);
	gl.uniform1f(uniform.uOpacity, water.opacity);
	gl.uniform1f(uniform.uWavePitch, water.wavePitch);
	gl.uniform1f(uniform.uWaterOffset, ((frame * water.waveSpeed) % 360) - 180);
	gl.bindTexture(gl.TEXTURE_2D, water.textures[((frame / water.animSpeed) % 32) | 0] || null);

	// As the client draws it: blended, depth tested, writing no depth.
	gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
	const depthTest = gl.isEnabled(gl.DEPTH_TEST);
	const depthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
	gl.enable(gl.DEPTH_TEST);
	gl.depthMask(false);
	gl.drawArrays(gl.TRIANGLES, 0, water.vertCount);
	gl.depthMask(depthMask);
	if (!depthTest) gl.disable(gl.DEPTH_TEST);

	gl.disableVertexAttribArray(attribute.aPosition);
	gl.disableVertexAttribArray(attribute.aTextureCoord);
}

/** The water as a map hook. settings: { reflection: 0..1 } */
export function waterHook(settings) {
	_settings = { reflection: 0.6, ...settings };
	return {
		name: 'Water',
		replaces: ['water'],
		init(gl, map) {
			_map = map;
			_reflection = null;
		},
		render(stage, ctx) {
			if (stage === 'begin') {
				const water = _map && _map.water();
				_reflection = null;
				if (!water || !(_settings.reflection > 0)) return;
				_reflection = Reflection.render(ctx.gl, ctx.modelView, ctx.projection, water.level, ctx.drawScene);
				ctx.restoreTarget();
			} else if (stage === 'water') {
				draw(ctx);
			}
		},
		free(gl) {
			Reflection.free(gl);
			if (_program) gl.deleteProgram(_program);
			_program = null;
			_reflection = null;
			_map = null;
			SceneCopy.free(gl);
		},
	};
}
