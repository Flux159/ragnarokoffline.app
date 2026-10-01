/**
 * Graphics+: grass and ferns on the ground that is grass. Clumps go on the cells whose
 * top texture's name matches one of the patterns given, but only where the cell is open ground: not under a
 * building, a wall or a platform, not in water. On the GPU each clump looks
 * at the ground already drawn under its root and only grows where that is
 * green, so the dirt and stone a grassy tile also shows stay bare, and a
 * clump whose root a model covers is not drawn.
 *
 * A clump is three painted cards that face the camera like the game's own
 * sprites. They take their colour from the ground under them, sway in the
 * wind, and leave no depth behind them, so a monster or player walking
 * through is never cut off. Drawn by a map hook (api.graphics.hook) after the map's models.
 */

import SceneCopy from './scene-copy.js';

const VERTEX = `#version 300 es
precision highp float;
in vec3 aBlade;       // x across the clump -0.5..0.5, y up 0..1, z which of the three crossed planes
in vec4 aInstance;    // xyz the root on the ground, w a random number for this clump
in vec4 aUv;          // xy the tile in the ground atlas, zw in the lightmap
uniform mat4 uModelViewMat;
uniform mat4 uProjectionMat;
uniform float uTime;
uniform float uHeight;
uniform float uWidth;
uniform float uWind;
uniform float uFadeFar;
// The scene so far (ground and models): a clump whose root is covered by a
// model -- a porch, a wall, a tree -- is not drawn.
uniform bool uHasDepth;
uniform sampler2D uSceneDepth;
uniform vec2 uScreen;
uniform vec2 uProj;
uniform sampler2D uSceneColor;
out vec3 vGround;
out float vFern;
out vec2 vTex;
out float vY;
out float vRand;
out float vFade;
out vec4 vUv;
void main() {
	float r = aInstance.w;
	// Three cards per clump, each facing the camera like the game's own
	// sprites, turned a little and set a little apart, so a clump is full
	// from any angle the camera takes.
	float card = aBlade.z - 1.0;
	vFern = step(0.88, fract(r * 91.7));
	float big = fract(r * 13.7);
	float scale = (0.5 + 1.1 * big * big) * (0.85 + 0.3 * fract(r * 29.3 + card * 0.31));
	float turn = card * 0.38 + (fract(r * 3.7) - 0.5) * 0.3;
	float sway = sin(uTime * 1.3 + aInstance.x * 0.3 + aInstance.z * 0.25 + r * 6.0 + card) * uWind * 0.12 * aBlade.y * aBlade.y;
	vec2 local = vec2(aBlade.x * uWidth * (1.0 + 0.35 * vFern), aBlade.y * uHeight * (1.0 - 0.2 * vFern)) * scale;
	local = vec2(local.x * cos(turn) - local.y * sin(turn), local.x * sin(turn) + local.y * cos(turn));
	local.x += sway;
	vec3 offset = vec3(cos(r * 40.0 + card * 2.1), 0.0, sin(r * 40.0 + card * 2.1)) * 0.35 * abs(card);
	vec4 rootEye0 = uModelViewMat * vec4(aInstance.xyz + offset, 1.0);
	vec4 eye = rootEye0 + vec4(local, 0.0, 0.0);
	gl_Position = uProjectionMat * eye;
	float u = fract(r * 7.1 + card * 0.5) > 0.5 ? 0.5 - aBlade.x : aBlade.x + 0.5;
	vTex = vec2((clamp(u, 0.01, 0.99) + vFern) * 0.5, 1.0 - aBlade.y);
	vY = aBlade.y;
	vRand = fract(r + card * 0.37);
	vUv = aUv;
	vFade = 1.0 - smoothstep(uFadeFar * 0.6, uFadeFar, -eye.z);
	vGround = vec3(0.3, 0.45, 0.2);
	if (uHasDepth) {
		vec4 rootEye = uModelViewMat * vec4(aInstance.xyz, 1.0);
		vec4 root = uProjectionMat * rootEye;
		vec2 at = root.xy / root.w * 0.5 + 0.5;
		float zn = textureLod(uSceneDepth, at, 0.0).r * 2.0 - 1.0;
		float covering = uProj.y / (zn + uProj.x);
		if (covering < -rootEye.z - 0.08) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
		// Grass only grows where the ground under it is green: not on the
		// dirt or the stone a grassy tile also shows.
		vec3 c = textureLod(uSceneColor, at, 0.0).rgb;
		float greenness = smoothstep(0.95, 1.0, c.g / max(c.r, 0.01)) * step(1.45, c.g / max(c.b, 0.01));
		if (greenness < 0.05) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
		else gl_Position = uProjectionMat * (rootEye0 + vec4(local * mix(0.5, 1.0, greenness), 0.0, 0.0));
		vGround = c;
	} else {
		vGround = vec3(0.3, 0.45, 0.2);
	}
}`;
const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vTex;
in float vY;
in float vRand;
in float vFade;
in vec4 vUv;
in vec3 vGround;
in float vFern;
out vec4 fragColor;
uniform sampler2D uAtlas;
uniform sampler2D uLightmap;
uniform sampler2D uBlades;
uniform bool uLightMapUse;
uniform vec3 uLightAmbient;
uniform vec3 uLightDiffuse;
uniform vec3 uTint;
uniform bool uFogUse;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uFogColor;
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
	vec4 blade = texture(uBlades, vTex);
	if (blade.a < 0.45) discard;
	if (vY < 0.18 && vY / 0.18 < hash(gl_FragCoord.x * 1.7 + gl_FragCoord.y * 0.63 + vRand * 31.0)) discard;
	if (vFade < hash(gl_FragCoord.x * 0.37 + gl_FragCoord.y * 1.31)) discard;
	// The colour of the ground it grows from, lit as the ground is, a
	// little richer: the clump belongs to the painting under it.
	vec3 rich = clamp(mix(vec3(dot(vGround, vec3(0.299, 0.587, 0.114))), vGround, 1.35), 0.0, 1.0);
	float hueSeed = fract(vRand * 5.3 + blade.g * 0.7);
	vec3 own = mix(vec3(0.24, 0.38, 0.15), vec3(0.45, 0.58, 0.26), hueSeed);
	vec3 base = mix(rich, own, 0.5) * uTint;
	float lit = blade.r;
	float tone = 0.72 + 0.45 * fract(vRand * 17.1);  // some clumps in light, some in shade
	vec3 color = base * tone * mix(0.28, 1.3, lit);
	color += vec3(0.05, 0.06, 0.0) * smoothstep(0.8, 1.0, lit);
	if (blade.b > 0.5) {
		// Ferns: a slightly deeper, cooler green than the grass around them.
		color *= vec3(0.86, 0.98, 0.9);
	}
	fragColor = vec4(color, 1.0);
	if (uFogUse) {
		float depth = gl_FragCoord.z / gl_FragCoord.w;
		fragColor.rgb = mix(fragColor.rgb, uFogColor, smoothstep(uFogNear, uFogFar, depth));
	}
}`;
// Three cards, two triangles each: x across, y up, which card.
const BLADES = new Float32Array([
	-.5, 0, 0, .5, 0, 0, .5, 1, 0, -.5, 0, 0, .5, 1, 0, -.5, 1, 0,
	-.5, 0, 1, .5, 0, 1, .5, 1, 1, -.5, 0, 1, .5, 1, 1, -.5, 1, 1,
	-.5, 0, 2, .5, 0, 2, .5, 1, 2, -.5, 0, 2, .5, 1, 2, -.5, 1, 2
]);

let _program = null;
let _bladeBuffer = null;
let _bladeTexture = null;
let _instanceBuffer = null;
let _uvBuffer = null;
let _count = 0;
let _data = null;
let _builtFor = null;
let _alt = null;
let _settings = null;
let _createProgram = null;

/** Texture names come from the map as CP949 bytes in a binary string. */
function decodeName(name) {
	try {
		return new TextDecoder("euc-kr").decode(Uint8Array.from(name, (c) => c.charCodeAt(0) & 255)).toLowerCase();
	} catch {
		return String(name).toLowerCase();
	}
}
/** A repeatable random number for cell i, clump k. */
function random(i, k) {
	const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
	return x - Math.floor(x);
}
/**
 * The plants, painted once into a texture: a clump of grass blades (left)
 * and a fern (right). R is how lit the paint is, G a per-blade number for
 * hue, B marks the fern, A coverage. Each blade is two soft strokes, a shaded
 * side and a lit one, like RO's own painted foliage.
 */
function bladeTexture(gl) {
	const size = 128;
	const canvas = document.createElement("canvas");
	canvas.width = size * 2;
	canvas.height = size;
	const g = canvas.getContext("2d");
	let seed = 11;
	const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
	const paint = (r, id, fern) => `rgb(${Math.max(0, Math.min(255, Math.round(r)))},${Math.round(id * 255)},${fern ? 255 : 0})`;
	g.lineJoin = "round";
	// Grass.
	const blades = [];
	for (let b = 0; b < 15; b++) blades.push({ base: size * (.5 + (rnd() - .5) * .45), lean: (rnd() - .5) * size * .85, tall: size * (.45 + rnd() * .52), width: size * (.045 + rnd() * .04), shade: .7 + rnd() * .3, id: rnd() });
	blades.sort((a, b) => a.tall - b.tall);
	g.filter = "blur(0.7px)";
	const stroke = (blade, side, from, to) => {
		const tipX = blade.base + blade.lean, tipY = size - blade.tall;
		const ctrlX = blade.base + blade.lean * .1, ctrlY = size - blade.tall * .65;
		g.beginPath();
		if (side <= 0) {
			g.moveTo(blade.base - blade.width, size);
			g.quadraticCurveTo(ctrlX - blade.width * .6, ctrlY, tipX, tipY);
			g.quadraticCurveTo(ctrlX, ctrlY, blade.base, size);
		} else {
			g.moveTo(blade.base, size);
			g.quadraticCurveTo(ctrlX, ctrlY, tipX, tipY);
			g.quadraticCurveTo(ctrlX + blade.width * .6, ctrlY, blade.base + blade.width, size);
		}
		g.closePath();
		const grad = g.createLinearGradient(0, size, 0, tipY);
		const id = Math.round(blade.id * 255);
		grad.addColorStop(0, `rgb(${Math.round(from * .25 * blade.shade)},${id},0)`);
		grad.addColorStop(.5, `rgb(${Math.round(from * blade.shade)},${id},0)`);
		grad.addColorStop(1, `rgb(${Math.round(to * blade.shade)},${id},0)`);
		g.fillStyle = grad;
		g.fill();
	};
	for (const blade of blades) {
		const lit = blade.lean < 0 ? 1 : -1;  // the side toward the light
		stroke(blade, -lit, 120, 170);
		stroke(blade, lit, 190, 255);
	}
	// A fern.
	g.save();
	g.translate(size, 0);
	const fronds = [];
	for (let f = 0; f < 7; f++) fronds.push({ angle: (f / 6 - .5) * 2.3 + (rnd() - .5) * .25, length: size * (.55 + rnd() * .4), shade: .7 + rnd() * .3, id: rnd() });
	fronds.sort((a, b) => Math.abs(b.angle) - Math.abs(a.angle));
	for (const frond of fronds) {
		const root = [size * .5, size * .98];
		const dir = [Math.sin(frond.angle), -Math.cos(frond.angle)];
		// The frond arches: up and out, then droops.
		const at = (t) => [root[0] + dir[0] * frond.length * t, root[1] + dir[1] * frond.length * t + frond.length * .45 * t * t * Math.abs(dir[0])];
		for (let t = .08; t < 1; t += .075) {
			const p = at(t), q = at(Math.min(1, t + .01));
			const tangent = Math.atan2(q[1] - p[1], q[0] - p[0]);
			const len = size * .12 * (1 - t * .8) + 2;
			for (const s of [-1, 1]) {
				g.save();
				g.translate(p[0], p[1]);
				g.rotate(tangent + s * 1.05);
				g.beginPath();
				g.ellipse(len * .5, 0, len * .55, len * .2, 0, 0, Math.PI * 2);
				const lg = g.createLinearGradient(0, 0, len, 0);
				lg.addColorStop(0, paint(60 * frond.shade, frond.id, true));
				lg.addColorStop(1, paint((120 + 110 * t) * frond.shade, frond.id, true));
				g.fillStyle = lg;
				g.fill();
				g.strokeStyle = paint(6, frond.id, true);
				g.lineWidth = .7;
				g.stroke();
				g.restore();
			}
		}
		g.beginPath();
		g.moveTo(root[0], root[1]);
		for (let t = .05; t <= 1; t += .05) g.lineTo(...at(t));
		g.strokeStyle = paint(50 * frond.shade, frond.id, true);
		g.lineWidth = 1.2;
		g.stroke();
	}
	g.restore();
	const texture = gl.createTexture();
	const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
	const premultiply = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL);
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
	gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
	gl.generateMipmap(gl.TEXTURE_2D);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip);
	gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
	return texture;
}
/**
 * Where the clumps go, for these settings: grass tiles, on open ground.
 */
function build(gl, settings) {
	_count = 0;
	if (!_data || !settings) return;
	// The walk data comes with the map; until it has, try again next frame.
	if (!_alt.width()) return;
	_builtFor = settings;
	const patterns = (Array.isArray(settings.textures) ? settings.textures : []).map((p) => String(p).toLowerCase()).filter(Boolean);
	if (!patterns.length) return;
	const grassy = _data.textureNames.map((name) => {
		const decoded = decodeName(name);
		return patterns.some((pattern) => decoded.includes(pattern));
	});
	const density = settings.density ?? .5;
	const perCell = Math.max(1, Math.round(density * 24));
	const { width, height, cellTexture, cellHeights, cellUv } = _data;
	const instances = [];
	const uvs = [];
	for (let y = 0; y < height; ++y) for (let x = 0; x < width; ++x) {
		const i = x + y * width;
		const texture = cellTexture[i];
		if (texture < 0 || !grassy[texture]) continue;
		const h = cellHeights.subarray(i * 4, i * 4 + 4);
		for (let k = 0; k < perCell; ++k) {
			const fx = random(i, k * 2);
			const fy = random(i, k * 2 + 1);
			const gx = (x + fx) * 2, gz = (y + fy) * 2;
			const type = _alt.cellType(Math.floor(gx), Math.floor(gz));
			if (!(type & _alt.TYPE.WALKABLE) || type & _alt.TYPE.WATER) continue;
			const ground = h[0] * (1 - fx) * (1 - fy) + h[1] * fx * (1 - fy) + h[2] * (1 - fx) * fy + h[3] * fx * fy;
			if (Math.abs(-_alt.cellHeight(gx - .5, gz - .5) - ground) > .6) continue;
			instances.push(gx, ground, gz, random(i, k + 97));
			uvs.push(cellUv[i * 4], cellUv[i * 4 + 1], cellUv[i * 4 + 2], cellUv[i * 4 + 3]);
		}
	}
	_count = instances.length / 4;
	if (!_count) return;
	if (!_program) _program = _createProgram(VERTEX, FRAGMENT);
	if (!_bladeTexture) _bladeTexture = bladeTexture(gl);
	if (!_bladeBuffer) {
		_bladeBuffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, _bladeBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, BLADES, gl.STATIC_DRAW);
	}
	_instanceBuffer = _instanceBuffer || gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, _instanceBuffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(instances), gl.STATIC_DRAW);
	_uvBuffer = _uvBuffer || gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, _uvBuffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uvs), gl.STATIC_DRAW);
}
function render(ctx) {
	const { gl, modelView, projection, fog, light, tick } = ctx;
	const lightmapOn = ctx.lightmap;
	const settings = _settings;
	if (!settings || !_data || typeof WebGL2RenderingContext === "undefined" || !(gl instanceof WebGL2RenderingContext)) return;
	_createProgram = ctx.createProgram;
	if (settings !== _builtFor) {
		try {
			build(gl, settings);
		} catch (error) {
			// Never take the rest of the frame down: no grass on this map.
			console.error('[Grass] could not build, grass is off for this map', error);
			_builtFor = settings;
			_count = 0;
		}
	}
	if (!_count || !_program) return;
	const textures = _data.groundTextures();
	const uniform = _program.uniform;
	const attribute = _program.attribute;
	gl.useProgram(_program);
	gl.uniformMatrix4fv(uniform.uModelViewMat, false, modelView);
	gl.uniformMatrix4fv(uniform.uProjectionMat, false, projection);
	gl.uniform1f(uniform.uTime, tick / 1e3);
	gl.uniform1f(uniform.uHeight, settings.height ?? 1.25);
	gl.uniform1f(uniform.uWidth, settings.width ?? 1.6);
	gl.uniform1f(uniform.uWind, settings.wind ?? .25);
	gl.uniform1f(uniform.uFadeFar, settings.distance ?? 400);
	const tint = Array.isArray(settings.tint) && settings.tint.length === 3 ? settings.tint : [1, 1, 1];
	gl.uniform3fv(uniform.uTint, tint);
	gl.uniform3fv(uniform.uLightAmbient, light.ambient);
	gl.uniform3fv(uniform.uLightDiffuse, light.diffuse);
	gl.uniform1i(uniform.uLightMapUse, lightmapOn ? 1 : 0);
	gl.uniform1i(uniform.uFogUse, fog.use && fog.exist);
	gl.uniform1f(uniform.uFogNear, fog.near);
	gl.uniform1f(uniform.uFogFar, fog.far);
	gl.uniform3fv(uniform.uFogColor, fog.color);
	gl.activeTexture(gl.TEXTURE0);
	gl.bindTexture(gl.TEXTURE_2D, textures.atlas);
	gl.uniform1i(uniform.uAtlas, 0);
	gl.activeTexture(gl.TEXTURE1);
	gl.bindTexture(gl.TEXTURE_2D, textures.lightmap);
	gl.uniform1i(uniform.uLightmap, 1);
	gl.activeTexture(gl.TEXTURE2);
	gl.bindTexture(gl.TEXTURE_2D, _bladeTexture);
	gl.uniform1i(uniform.uBlades, 2);
	const current = gl.getParameter(gl.FRAMEBUFFER_BINDING);
	const saved = current ? SceneCopy.depth(gl) : null;
	const color = current ? SceneCopy.color(gl) : null;
	gl.activeTexture(gl.TEXTURE4);
	gl.bindTexture(gl.TEXTURE_2D, color);
	gl.uniform1i(uniform.uSceneColor, 4);
	gl.activeTexture(gl.TEXTURE3);
	gl.bindTexture(gl.TEXTURE_2D, saved);
	gl.uniform1i(uniform.uSceneDepth, 3);
	gl.uniform1i(uniform.uHasDepth, saved ? 1 : 0);
	const vp0 = gl.getParameter(gl.VIEWPORT);
	gl.uniform2f(uniform.uScreen, vp0[2], vp0[3]);
	gl.uniform2f(uniform.uProj, projection[10], projection[14]);
	gl.activeTexture(gl.TEXTURE0);
	gl.bindBuffer(gl.ARRAY_BUFFER, _bladeBuffer);
	gl.enableVertexAttribArray(attribute.aBlade);
	gl.vertexAttribPointer(attribute.aBlade, 3, gl.FLOAT, false, 0, 0);
	gl.vertexAttribDivisor(attribute.aBlade, 0);
	gl.bindBuffer(gl.ARRAY_BUFFER, _instanceBuffer);
	gl.enableVertexAttribArray(attribute.aInstance);
	gl.vertexAttribPointer(attribute.aInstance, 4, gl.FLOAT, false, 0, 0);
	gl.vertexAttribDivisor(attribute.aInstance, 1);
	gl.bindBuffer(gl.ARRAY_BUFFER, _uvBuffer);
	gl.enableVertexAttribArray(attribute.aUv);
	gl.vertexAttribPointer(attribute.aUv, 4, gl.FLOAT, false, 0, 0);
	gl.vertexAttribDivisor(attribute.aUv, 1);
	// Grass writes no depth. Sprites drawn after it are tested against the
	// depth buffer, and a sprite "behind" a blade is drawn as a faded
	// silhouette -- grass must never do that to a player or monster. Models
	// in front still hide it: the clump's root is tested against the scene's
	// depth in the vertex shader.
	const cull = gl.isEnabled(gl.CULL_FACE);
	gl.disable(gl.CULL_FACE);
	gl.depthMask(false);
	gl.drawArraysInstanced(gl.TRIANGLES, 0, 18, _count);
	gl.depthMask(true);
	if (cull) {
		gl.enable(gl.CULL_FACE);
	}
	gl.vertexAttribDivisor(attribute.aInstance, 0);
	gl.vertexAttribDivisor(attribute.aUv, 0);
	gl.disableVertexAttribArray(attribute.aBlade);
	gl.disableVertexAttribArray(attribute.aInstance);
	gl.disableVertexAttribArray(attribute.aUv);
}
function free(gl) {
	for (const buffer of [_instanceBuffer, _uvBuffer, _bladeBuffer]) {
		if (buffer) gl.deleteBuffer(buffer);
	}
	if (_bladeTexture) gl.deleteTexture(_bladeTexture);
	if (_program) gl.deleteProgram(_program);
	_instanceBuffer = _uvBuffer = _bladeBuffer = _bladeTexture = _program = null;
	_data = _alt = null;
	_builtFor = null;
	_count = 0;
	SceneCopy.free(gl);
}

/**
 * The grass as a map hook. settings: { textures, density, height, width,
 * wind, distance, tint } (textures: substrings of the ground texture names
 * that are grass).
 */
export function grassHook(settings) {
	_settings = settings;
	return {
		name: 'Grass',
		init(gl, map) {
			_data = map && map.cellTexture ? map : null;
			_alt = map ? map.altitude : null;
			_builtFor = null;
			_count = 0;
		},
		render(stage, ctx) {
			if (stage === 'models') render(ctx);
		},
		free,
	};
}
