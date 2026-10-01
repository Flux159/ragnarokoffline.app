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
// The ground's own texture: the clump reads the spot it grows from (aUv.xy),
// fixed for the clump, so nothing about it changes as the camera moves.
uniform sampler2D uAtlas;
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
	// The colour of the ground it grows from (the green test was done once,
	// when the clumps were placed).
	vGround = textureLod(uAtlas, aUv.xy, 0.0).rgb;
	// A clump whose root a model covers (a porch, a wall) is not drawn.
	if (uHasDepth) {
		vec4 rootEye = uModelViewMat * vec4(aInstance.xyz, 1.0);
		vec4 root = uProjectionMat * rootEye;
		vec2 at = root.xy / root.w * 0.5 + 0.5;
		float zn = textureLod(uSceneDepth, at, 0.0).r * 2.0 - 1.0;
		float covering = uProj.y / (zn + uProj.x);
		if (covering < -rootEye.z - 0.3) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
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
	// Fades are dithered in the blade's own space: on screen pixels they
	// would crawl as the camera moves.
	if (vY < 0.18 && vY / 0.18 < hash(floor(vTex.x * 64.0) * 1.7 + floor(vTex.y * 64.0) * 0.63 + vRand * 31.0)) discard;
	if (vFade < fract(vRand * 7.31)) discard;
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
/**
 * Each grassy ground texture, small (64x64: the downsampling averages it),
 * as pixels -- to ask, once per map, whether the ground under a clump is
 * green. Null until they have loaded.
 */
let _swatches = null;
let _swatchesFor = null;
function loadSwatches(urls, grassy) {
	_swatchesFor = urls;
	_swatches = null;
	const size = 64;
	Promise.all(urls.map((url, index) => {
		if (!grassy[index] || !url) return null;
		return new Promise(resolve => {
			const image = new Image();
			image.onload = () => {
				const canvas = document.createElement('canvas');
				canvas.width = canvas.height = size;
				const g = canvas.getContext('2d', { willReadFrequently: true });
				g.drawImage(image, 0, 0, size, size);
				resolve(g.getImageData(0, 0, size, size).data);
			};
			image.onerror = () => resolve(null);
			image.src = url;
		});
	})).then(list => { if (_swatchesFor === urls) _swatches = list; });
}

/** 0..1: how green the ground texture is at its own (u, v). */
function greenness(texture, u, v) {
	const px = _swatches && _swatches[texture];
	if (!px) return 1;
	const x = Math.min(63, Math.max(0, Math.floor(u * 64))), y = Math.min(63, Math.max(0, Math.floor(v * 64)));
	const o = (y * 64 + x) * 4;
	const ratio = px[o + 1] / Math.max(px[o], 1);
	return Math.min(Math.max((ratio - 0.9) / 0.07, 0), 1);
}

const CHUNK = 16;   // ground cells per side of a culling chunk
let _chunks = [];   // { first, count, min: [x, y, z], max: [x, y, z] }

/**
 * Where the clumps go, for these settings: grass tiles, on open ground that
 * is green, sorted into chunks so only the ones in view are drawn.
 */
function build(gl, settings) {
	_count = 0;
	_chunks = [];
	if (!_data || !settings) return;
	// The walk data comes with the map, the textures load after it: until
	// both are here, try again next frame.
	if (!_alt.width()) return;
	const patterns = (Array.isArray(settings.textures) ? settings.textures : []).map((p) => String(p).toLowerCase()).filter(Boolean);
	if (!patterns.length) { _builtFor = settings; return; }
	const grassy = _data.textureNames.map((name) => {
		const decoded = decodeName(name);
		return patterns.some((pattern) => decoded.includes(pattern));
	});
	const urls = _data.textureUrls || [];
	if (urls.length && _swatchesFor !== urls) loadSwatches(urls, grassy);
	if (urls.length && !_swatches) return;
	_builtFor = settings;

	const density = settings.density ?? .5;
	const perCell = Math.max(1, Math.round(density * 40));
	const { width, height, cellTexture, cellHeights, cellUv, cellAtlas, cellLight } = _data;
	// The atlas layout (Loaders/Ground.js): to turn atlas coordinates back
	// into the texture's own.
	const cols = Math.round(Math.sqrt(_data.textureNames.length));
	const rows = Math.ceil(Math.sqrt(_data.textureNames.length));
	const factorU = (cols * 258) / 2 ** Math.ceil(Math.log2(cols * 258));
	const factorV = (rows * 258) / 2 ** Math.ceil(Math.log2(rows * 258));
	const local = (a, n, factor) => { const t = (a * n) / factor; return ((t - Math.floor(t)) - 1 / 258) / (1 - 2 / 258); };
	const lerp = (p, q, t) => p + (q - p) * t;

	const chunks = new Map();   // chunk key -> { instances: [], uvs: [], min, max }
	for (let y = 0; y < height; ++y) for (let x = 0; x < width; ++x) {
		const i = x + y * width;
		const texture = cellTexture[i];
		if (texture < 0 || !grassy[texture]) continue;
		const h = cellHeights.subarray(i * 4, i * 4 + 4);
		const key = Math.floor(x / CHUNK) + ',' + Math.floor(y / CHUNK);
		for (let k = 0; k < perCell; ++k) {
			const fx = random(i, k * 2);
			const fy = random(i, k * 2 + 1);
			const gx = (x + fx) * 2, gz = (y + fy) * 2;
			const type = _alt.cellType(Math.floor(gx), Math.floor(gz));
			if (!(type & _alt.TYPE.WALKABLE) || type & _alt.TYPE.WATER) continue;
			const ground = h[0] * (1 - fx) * (1 - fy) + h[1] * fx * (1 - fy) + h[2] * (1 - fx) * fy + h[3] * fx * fy;
			if (Math.abs(-_alt.cellHeight(gx - .5, gz - .5) - ground) > .6) continue;
			let uv;
			if (cellAtlas) {
				// The exact spot in the ground's texture and lightmap, as the
				// ground itself interpolates them: fixed for this clump.
				const a = cellAtlas.subarray(i * 8, i * 8 + 8), l = cellLight.subarray(i * 4, i * 4 + 4);
				uv = [lerp(lerp(a[0], a[2], fx), lerp(a[4], a[6], fx), fy), lerp(lerp(a[1], a[3], fx), lerp(a[5], a[7], fx), fy),
					lerp(l[0], l[2], fx), lerp(l[1], l[3], fy)];
				// Only where the ground is green: not on the dirt or stone a
				// grassy tile also shows. Decided here, once.
				if (greenness(texture, local(uv[0], cols, factorU), local(uv[1], rows, factorV)) < 0.5) continue;
			} else {
				uv = [cellUv[i * 4], cellUv[i * 4 + 1], cellUv[i * 4 + 2], cellUv[i * 4 + 3]];
			}
			let chunk = chunks.get(key);
			if (!chunk) chunks.set(key, chunk = { instances: [], uvs: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
			chunk.instances.push(gx, ground, gz, random(i, k + 97));
			chunk.uvs.push(...uv);
			const p = [gx, ground, gz];
			for (let a = 0; a < 3; a++) { chunk.min[a] = Math.min(chunk.min[a], p[a]); chunk.max[a] = Math.max(chunk.max[a], p[a]); }
		}
	}
	const instances = [], uvs = [];
	for (const chunk of chunks.values()) {
		// Grass rises up to a few units (up is -y).
		chunk.min[1] -= 4;
		_chunks.push({ first: instances.length / 4, count: chunk.instances.length / 4, min: chunk.min, max: chunk.max });
		for (const v of chunk.instances) instances.push(v);
		for (const v of chunk.uvs) uvs.push(v);
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

/** Whether any of a box is inside the view (clip-space test of its corners). */
function inView(m, min, max) {
	let left = 0, right = 0, bottom = 0, top = 0, near = 0, far = 0;
	for (let c = 0; c < 8; c++) {
		const x = c & 1 ? max[0] : min[0], y = c & 2 ? max[1] : min[1], z = c & 4 ? max[2] : min[2];
		const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
		const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
		const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
		const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
		if (cx < -cw) left++; if (cx > cw) right++;
		if (cy < -cw) bottom++; if (cy > cw) top++;
		if (cz < -cw) near++; if (cz > cw) far++;
	}
	return left < 8 && right < 8 && bottom < 8 && top < 8 && near < 8 && far < 8;
}

function multiply(a, b) {
	const out = new Float32Array(16);
	for (let col = 0; col < 4; col++)
		for (let row = 0; row < 4; row++) {
			let sum = 0;
			for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
			out[col * 4 + row] = sum;
		}
	return out;
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
	gl.uniform1f(uniform.uHeight, settings.height ?? 0.8);
	gl.uniform1f(uniform.uWidth, settings.width ?? 1.05);
	gl.uniform1f(uniform.uWind, settings.wind ?? .25);
	gl.uniform1f(uniform.uFadeFar, settings.distance ?? 220);
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
	const saved = current ? SceneCopy.depth(gl, ctx.tick + ':models') : null;
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
	gl.enableVertexAttribArray(attribute.aInstance);
	gl.vertexAttribDivisor(attribute.aInstance, 1);
	gl.enableVertexAttribArray(attribute.aUv);
	gl.vertexAttribDivisor(attribute.aUv, 1);
	// Grass writes no depth. Sprites drawn after it are tested against the
	// depth buffer, and a sprite "behind" a blade is drawn as a faded
	// silhouette -- grass must never do that to a player or monster. Models
	// in front still hide it: the clump's root is tested against the scene's
	// depth in the vertex shader.
	const cull = gl.isEnabled(gl.CULL_FACE);
	gl.disable(gl.CULL_FACE);
	gl.depthMask(false);
	// Only the chunks in view. WebGL 2 has no base instance, so each chunk
	// points the per-clump attributes at its own part of the buffers.
	const viewProjection = multiply(projection, modelView);
	for (const chunk of _chunks) {
		if (!inView(viewProjection, chunk.min, chunk.max)) continue;
		gl.bindBuffer(gl.ARRAY_BUFFER, _instanceBuffer);
		gl.vertexAttribPointer(attribute.aInstance, 4, gl.FLOAT, false, 0, chunk.first * 16);
		gl.bindBuffer(gl.ARRAY_BUFFER, _uvBuffer);
		gl.vertexAttribPointer(attribute.aUv, 4, gl.FLOAT, false, 0, chunk.first * 16);
		gl.drawArraysInstanced(gl.TRIANGLES, 0, 18, chunk.count);
	}
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
	_swatches = _swatchesFor = null;
	_chunks = [];
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
