// Graphics+: one full-screen pass (api.graphics.registerPass) doing several
// effects, each set by its own setting, 0 meaning off. One pass rather than
// one per effect, so turning more of them on costs a few shader instructions,
// not another trip over the whole screen.
//
// What the pass is handed (the frame, its depth, the map's sun and its lights
// already on screen) is described in docs/MODDING.md, "client/".

import { grassHook } from './grass.js';
import { waterHook } from './water.js';
import { shadowsHook } from './shadows.js';
import { groundHdHook } from './ground-hd.js';

const FRAGMENT = `
uniform float uGrade, uGlow, uFog, uTonemap, uVignette, uTilt, uFringe, uDrops;


vec3 aces(vec3 x) {
	return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

float hash(vec2 p) {
	return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
// Water drops on the lens: one possible drop per cell of a grid, a few sizes.
// Returns xy the offset to sample the scene at (a drop is a small lens: it
// shows what is around it, flipped), z how much drop there is here, w its
// highlight.
vec4 drop(vec2 uv, float cells, float seed) {
	vec2 aspect = vec2(uResolution.x / uResolution.y, 1.0);
	vec2 p = uv * aspect * cells;
	// Drops slide down now and then, each on its own clock.
	vec2 cell = floor(p);
	float r = hash(cell + seed);
	float slide = floor(uTime * 0.15 + r * 7.0);
	float alive = step(0.72, hash(cell + seed + slide * 1.7));
	vec2 centre = cell + 0.5 + (vec2(hash(cell + seed + 3.1), hash(cell + seed + 5.7)) - 0.5) * 0.6;
	centre.y -= fract(uTime * 0.15 + r * 7.0) * 0.25 * step(0.8, r);
	float radius = mix(0.08, 0.2, hash(cell + seed + 9.3));
	vec2 d = (p - centre) / radius;
	float dist = length(d);
	if (dist > 1.0 || alive < 0.5) return vec4(0.0);
	float edge = smoothstep(1.0, 0.75, dist);
	// Refraction: sample on the opposite side, magnified.
	vec2 offset = -d * radius * 2.2 / (aspect * cells);
	// A bright glint upper-left, a darker rim lower-right.
	float glint = smoothstep(0.35, 0.0, length(d - vec2(-0.35, 0.4))) * 0.9;
	float rim = smoothstep(0.55, 1.0, dist) * smoothstep(-0.2, 0.6, dot(normalize(d + 1e-4), vec2(0.6, -0.8)));
	return vec4(offset, edge, glint - rim * 0.5);
}

vec3 frame(vec2 uv) {
	if (uFringe <= 0.0) return texture(uTexture, uv).rgb;
	vec2 shift = (uv - 0.5) * uFringe * 0.006;
	return vec3(texture(uTexture, uv + shift).r, texture(uTexture, uv).g, texture(uTexture, uv - shift).b);
}

void main() {
	vec2 uv = vUv;
	vec3 color = frame(uv);
	// Drops gather low on the lens, thinning out towards the middle.
	float lens = uDrops * (1.0 - smoothstep(0.08, 0.45, uv.y));
	if (lens > 0.0) {
		vec4 a = drop(uv, 48.0, 0.0), b = drop(uv, 80.0, 31.0);
		vec4 d = a.z > 0.0 ? a : b;
		if (d.z > 0.0) {
			vec3 seen = frame(uv + d.xy) * 1.05;
			color = mix(color, seen + d.w * 0.35, d.z * lens);
		}
	}

	// Tilt-shift: blur grows away from a band across the middle.
	if (uTilt > 0.0) {
		float amount = smoothstep(0.12, 0.5, abs(uv.y - 0.5)) * uTilt;
		if (amount > 0.001) {
			vec2 stride = amount * 5.0 / uResolution;
			vec3 sum = color;
			float weight = 1.0;
			for (int i = -3; i <= 3; i++) {
				for (int j = -3; j <= 3; j++) {
					if (i == 0 && j == 0) continue;
					sum += frame(uv + vec2(float(i), float(j)) * stride);
					weight += 1.0;
				}
			}
			color = sum / weight;
		}
	}

	// Distance haze, in the map's own light colour.
	if (uFog > 0.0 && uHasDepth) {
		float far = linearDepth(uv);
		float amount = smoothstep(uNear + 60.0, uFar * 0.3, far) * uFog;
		vec3 haze = clamp(mix(uAmbient, uSunColor, 0.5) * 0.85 + 0.15, 0.0, 1.0);
		color = mix(color, haze, clamp(amount, 0.0, 0.8));
	}

	// Lamp glow: a soft additive halo at each of the map's lights.
	if (uGlow > 0.0) {
		vec3 glow = vec3(0.0);
		float aspect = uResolution.x / uResolution.y;
		for (int i = 0; i < ${32}; i++) {
			if (i >= uLightCount) break;
			vec4 light = uLights[i];
			vec2 offset = (uv - light.xy) * vec2(aspect, 1.0);
			float radius = max(light.z, 0.01);
			glow += uLightColors[i] * exp(-dot(offset, offset) / (radius * radius * 0.3));
		}
		color += glow * uGlow * 0.55;
	}

	// Grading: golden light, teal-blue shadows, rich colour and contrast --
	// a painted, late-afternoon look.
	if (uGrade > 0.0) {
		float luma = dot(color, vec3(0.299, 0.587, 0.114));
		vec3 sat = mix(vec3(luma), color, 1.2);
		vec3 warm = sat * vec3(1.08, 1.0, 0.84);
		vec3 cool = sat * vec3(0.86, 0.96, 1.06);
		vec3 graded = mix(cool, warm, smoothstep(0.1, 0.75, luma));
		// A gentle S-curve: richer darks without crushing them.
		graded = clamp(graded, 0.0, 1.0);
		graded = mix(graded, graded * graded * (3.0 - 2.0 * graded), 0.35);
		color = mix(color, graded, uGrade);
	}

	if (uTonemap > 0.0) color = mix(color, aces(color * 1.1), uTonemap);

	if (uVignette > 0.0) color *= mix(1.0, smoothstep(0.9, 0.3, length(uv - 0.5)), uVignette);

	fragColor = vec4(color, 1.0);
}
`;

const SETTINGS = ['grade', 'glow', 'fog', 'tonemap', 'vignette', 'tilt_shift', 'fringe', 'drops'];
const UNIFORM = { grade: 'uGrade', glow: 'uGlow', fog: 'uFog', tonemap: 'uTonemap', vignette: 'uVignette', tilt_shift: 'uTilt', fringe: 'uFringe', drops: 'uDrops' };

// A setting as 0..1. Read defensively: a missing or odd value is off.
export function strengths(parameters = {}) {
    const out = {};
    for (const key of SETTINGS) {
        const value = Number(parameters?.[key]);
        out[UNIFORM[key]] = Number.isFinite(value) ? Math.min(Math.max(value, 0), 100) / 100 : 0;
    }
    return out;
}

/**
 * The maps with a wet lens, from a list like "um_fild* gef_fild01" (spaces or
 * commas; * matches anything). "*" is everywhere, an empty list nowhere.
 */
function mapPattern(pattern) {
    return new RegExp('^' + pattern.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
}

function mapName(name) {
    return String(name).toLowerCase().replace(/\.(gat|rsw)$/, '');
}

/**
 * How strong a setting is on a map, 0..1: the first entry of a list like
 * "prt_fild*:90 *_dun*:0" whose name matches, else the default.
 */
export function perMap(list, fallback) {
    const entries = String(list ?? '').split(/[\s,]+/).filter(Boolean).map(entry => {
        const [pattern, value] = entry.split(':');
        const amount = Number(value);
        return pattern && Number.isFinite(amount) ? { test: mapPattern(pattern), amount: Math.min(Math.max(amount, 0), 100) / 100 } : null;
    }).filter(Boolean);
    return name => {
        const map = mapName(name);
        const hit = entries.find(entry => entry.test.test(map));
        return hit ? hit.amount : fallback;
    };
}

export function wetMaps(list) {
    const patterns = String(list ?? '').split(/[\s,]+/).filter(Boolean)
        .map(p => new RegExp('^' + p.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));
    return name => {
        const map = String(name).toLowerCase().replace(/\.(gat|rsw)$/, '');
        return patterns.some(p => p.test(map));
    };
}

export default function init(parameters, api) {
    if (api?.version !== 1) throw new Error('graphics-plus requires client API 1');
    if (!api.graphics?.supported()) {
        console.warn('[graphics-plus] this client cannot run graphics passes; nothing to do');
        return;
    }
    const uniforms = strengths(parameters);
    const anything = Object.values(uniforms).some(value => value > 0);
    const percent = key => { const value = Number(parameters?.[key]); return Number.isFinite(value) ? Math.min(Math.max(value, 0), 100) / 100 : 0; };

    // Drawn in the map renderer itself, each by a map hook of its own
    // (grass.js, water.js, shadows.js): only the ones switched on.
    if (percent('shadows') > 0 || percent('occlusion') > 0) api.graphics.hook(shadowsHook(percent('shadows'), percent('occlusion')));
    if (percent('water') > 0) api.graphics.hook(waterHook({
        reflection: percent('water'),
        // The map's own waves on top: on some maps the plain mirror is best
        // (Izlude), on others the waves are what makes the water (Alberta).
        detail: perMap(parameters?.water_detail_maps, percent('water_detail')),
    }));
    // Texture packs' larger ground textures, at their own resolution.
    if (parameters?.hd_ground !== false) api.graphics.hook(groundHdHook());
    if (percent('grass') > 0) api.graphics.hook(grassHook({
        // Ground textures whose names say grass: the client's are Korean
        // (풀 grass, 잔디 lawn, 초원 meadow, 들판 field), a mod's often English.
        textures: ['풀', '잔디', '초원', '들판', 'grass'],
        density: percent('grass'),
        wind: 0.3,
    }));

    // Drops on the lens only on the maps listed as wet.
    const wet = wetMaps(parameters?.drop_maps);
    let raining = false;
    // Warm sunlight: a golden sun and a cooler sky in place of the map's,
    // as strong as the setting says -- or as the map's own entry in
    // "Sunlight per map" says.
    const sunFor = perMap(parameters?.sunlight_maps, percent('sunlight'));
    let sunlight = null;
    const weather = name => {
        raining = !!name && wet(name);
        const sun = name ? sunFor(name) : 0;
        const mix = (a, b) => a.map((v, i) => v + (b[i] - v) * sun);
        sunlight = sun > 0 ? { ambient: mix([0.3, 0.3, 0.3], [0.16, 0.2, 0.3]), diffuse: mix([1, 1, 1], [1.1, 0.92, 0.68]) } : null;
    };
    api.graphics.hook({ name: 'Sunlight', light: () => sunlight });
    api.on('map:enter', ({ name }) => weather(name));
    api.on('map:leave', () => weather(null));
    weather(api.snapshot?.().map);

    const live = { ...uniforms };
    api.graphics.registerPass({
        name: 'Graphics+',
        fragment: FRAGMENT,
        enabled: () => anything,
        uniforms: () => {
            live.uDrops = raining ? uniforms.uDrops : 0;
            return live;
        },
    });
}
