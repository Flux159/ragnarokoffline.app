// glTF 2.0 models in place of a map's own (api.models.replace).
//
// A mod names map models (RSM files under data/model/) and the .glb or
// .gltf to draw instead. The map loader leaves those models out (the fork's
// MapHooks replacesModels) and hands back every placement; this draws the
// glTF at each one, fitted to the original's size, with the map's sun, fog
// and ambient light, instanced so a field of trees is one draw per material.
//
// Supported: meshes of triangles with POSITION, NORMAL and TEXCOORD_0
// (normals are made if missing), indexed or not, node hierarchies (baked),
// materials' base colour factor and texture, alphaMode OPAQUE/MASK/BLEND.
// Not: skins, morph targets, animation, cameras, lights, extensions.

import MapHooks from 'Renderer/MapHooks.js';

const VERTEX = `#version 300 es
precision highp float;
in vec3 aPosition;
in vec3 aNormal;
in vec2 aUv;
in vec4 aColor;              // COLOR_0, white when the model has none
in mat4 aInstance;          // the model's space to the world, fit included
uniform mat4 uModelViewMat;
uniform mat4 uProjectionMat;
out vec3 vNormal;
out vec2 vUv;
out vec4 vColor;
flat out float vMirrored;
void main() {
	vec4 world = aInstance * vec4(aPosition, 1.0);
	gl_Position = uProjectionMat * uModelViewMat * world;
	// The inverse transpose keeps normals right under non-uniform scale.
	mat3 m = mat3(aInstance);
	vNormal = normalize(transpose(inverse(m)) * aNormal);
	// Turning glTF's +y up into RO's -y up mirrors the model, which swaps
	// which side of each triangle the GPU calls the front.
	vMirrored = determinant(m) < 0.0 ? 1.0 : 0.0;
	vUv = aUv;
	vColor = aColor;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec3 vNormal;
in vec2 vUv;
in vec4 vColor;
flat in float vMirrored;
out vec4 fragColor;
uniform vec4 uBaseColor;
uniform bool uHasTexture;
uniform sampler2D uTexture;
uniform float uAlphaCutoff;   // < 0: no cutoff
uniform bool uFoliage;        // leaves: lit as one soft, rounded canopy
uniform vec3 uLightDirection;
uniform vec3 uLightAmbient;
uniform vec3 uLightDiffuse;
uniform vec3 uLightEnv;
uniform bool uLightMapUse;
uniform bool uFogUse;
uniform float uFogNear;
uniform float uFogFar;
uniform vec3 uFogColor;
void main() {
	vec4 color = uBaseColor * vColor;
	if (uHasTexture) color *= texture(uTexture, vUv);
	if (uAlphaCutoff >= 0.0 && color.a < uAlphaCutoff) discard;
	// Lit exactly as the map's own models are (Models.fs): the sun by the
	// surface's angle to it (full sun with lightmaps off), plus ambient,
	// times the map's light tint. Two-sided: a face seen from behind is lit
	// from behind.
	bool front = gl_FrontFacing != (vMirrored > 0.5);
	float sun;
	if (uFoliage) {
		// The canopy as a whole (its normals point out from its middle),
		// with the light wrapping round to the far side as it does through
		// leaves: lit on the sun's side, never black on the other.
		float wrap = dot(normalize(vNormal), uLightDirection) * 0.5 + 0.5;
		sun = uLightMapUse ? mix(0.35, 1.0, wrap * wrap) : 1.0;
	} else {
		vec3 n = normalize(front ? vNormal : -vNormal);
		sun = uLightMapUse ? max(dot(n, uLightDirection), 0.0) : 1.0;
	}
	color.rgb *= clamp(sun * uLightDiffuse + uLightAmbient, 0.0, 1.0);
	color.rgb *= clamp(uLightEnv, 0.0, 1.0);
	fragColor = color;
	if (uFogUse) {
		float depth = gl_FragCoord.z / gl_FragCoord.w;
		fragColor.rgb = mix(fragColor.rgb, uFogColor, smoothstep(uFogNear, uFogFar, depth));
	}
}`;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const ARRAYS = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };

/** glTF colours are linear; the client draws in sRGB. */
function toSrgb(v) {
	return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
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

function nodeMatrix(node) {
	if (node.matrix) return Float32Array.from(node.matrix);
	const [tx, ty, tz] = node.translation || [0, 0, 0];
	const [x, y, z, w] = node.rotation || [0, 0, 0, 1];
	const [sx, sy, sz] = node.scale || [1, 1, 1];
	return new Float32Array([
		(1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
		2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
		2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
		tx, ty, tz, 1,
	]);
}

/** Parse a .glb, or a .gltf with its buffers beside it. */
async function fetchGltf(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`${url}: ${response.status}`);
	const bytes = await response.arrayBuffer();
	const view = new DataView(bytes);
	if (view.getUint32(0, true) === 0x46546c67) {   // 'glTF'
		let offset = 12, json = null, bin = null;
		while (offset < bytes.byteLength) {
			const length = view.getUint32(offset, true);
			const type = view.getUint32(offset + 4, true);
			const chunk = bytes.slice(offset + 8, offset + 8 + length);
			if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
			else if (type === 0x004e4942) bin = chunk;
			offset += 8 + length;
		}
		if (!json) throw new Error(`${url}: no JSON chunk`);
		const buffers = await Promise.all((json.buffers || []).map((buffer, i) =>
			buffer.uri ? fetch(new URL(buffer.uri, url)).then(r => r.arrayBuffer()) : Promise.resolve(i === 0 ? bin : null)));
		return { json, buffers, base: url };
	}
	const json = JSON.parse(new TextDecoder().decode(bytes));
	const buffers = await Promise.all((json.buffers || []).map(buffer =>
		buffer.uri.startsWith('data:') ? fetch(buffer.uri).then(r => r.arrayBuffer()) : fetch(new URL(buffer.uri, url)).then(r => r.arrayBuffer())));
	return { json, buffers, base: url };
}

function accessorData({ json, buffers }, index) {
	const accessor = json.accessors[index];
	const Type = ARRAYS[accessor.componentType];
	const components = COMPONENTS[accessor.type];
	const out = new Type(accessor.count * components);
	if (accessor.bufferView === undefined) return { data: out, components };   // all zeros
	const viewDef = json.bufferViews[accessor.bufferView];
	const buffer = buffers[viewDef.buffer];
	const start = (viewDef.byteOffset || 0) + (accessor.byteOffset || 0);
	const stride = viewDef.byteStride || components * Type.BYTES_PER_ELEMENT;
	if (stride === components * Type.BYTES_PER_ELEMENT) {
		out.set(new Type(buffer, start, accessor.count * components));
	} else {
		for (let i = 0; i < accessor.count; i++) out.set(new Type(buffer, start + i * stride, components), i * components);
	}
	if (accessor.normalized && Type !== Float32Array) {
		const max = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }[accessor.componentType];
		return { data: Float32Array.from(out, v => Math.max(v / max, -1)), components };
	}
	return { data: out, components };
}

async function loadImage(gltf, index) {
	const image = gltf.json.images[index];
	let url;
	if (image.bufferView !== undefined) {
		const viewDef = gltf.json.bufferViews[image.bufferView];
		const bytes = new Uint8Array(gltf.buffers[viewDef.buffer], viewDef.byteOffset || 0, viewDef.byteLength);
		url = URL.createObjectURL(new Blob([bytes], { type: image.mimeType || 'image/png' }));
	} else {
		url = new URL(image.uri, gltf.base).href;
	}
	const img = new Image();
	img.crossOrigin = 'anonymous';
	await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = url; });
	return img;
}

/**
 * The model flattened: one group per material, positions in the model's
 * own space (node transforms baked in), and its bounds.
 */
async function flatten(gltf) {
	const { json } = gltf;
	const groups = new Map();   // material index -> { positions, normals, uvs, indices }
	const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
	const visit = (nodeIndex, parent) => {
		const node = json.nodes[nodeIndex];
		const matrix = multiply(parent, nodeMatrix(node));
		if (node.mesh !== undefined) {
			for (const primitive of json.meshes[node.mesh].primitives) {
				if ((primitive.mode ?? 4) !== 4 || primitive.attributes.POSITION === undefined) continue;
				const pos = accessorData(gltf, primitive.attributes.POSITION).data;
				const nor = primitive.attributes.NORMAL !== undefined ? accessorData(gltf, primitive.attributes.NORMAL).data : null;
				const uv = primitive.attributes.TEXCOORD_0 !== undefined ? accessorData(gltf, primitive.attributes.TEXCOORD_0).data : null;
				const col = primitive.attributes.COLOR_0 !== undefined ? accessorData(gltf, primitive.attributes.COLOR_0) : null;
				const count = pos.length / 3;
				const indices = primitive.indices !== undefined ? accessorData(gltf, primitive.indices).data : Uint32Array.from({ length: count }, (_, i) => i);
				const key = primitive.material ?? -1;
				if (!groups.has(key)) groups.set(key, { positions: [], normals: [], uvs: [], colors: [], indices: [] });
				const group = groups.get(key);
				const base = group.positions.length / 3;
				for (let i = 0; i < count; i++) {
					const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
					const p = [
						matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
						matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
						matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
					];
					group.positions.push(...p);
					for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[a]); max[a] = Math.max(max[a], p[a]); }
					if (nor) {
						const nx = nor[i * 3], ny = nor[i * 3 + 1], nz = nor[i * 3 + 2];
						const n = [matrix[0] * nx + matrix[4] * ny + matrix[8] * nz, matrix[1] * nx + matrix[5] * ny + matrix[9] * nz, matrix[2] * nx + matrix[6] * ny + matrix[10] * nz];
						const l = Math.hypot(...n) || 1;
						group.normals.push(n[0] / l, n[1] / l, n[2] / l);
					}
					group.uvs.push(uv ? uv[i * 2] : 0, uv ? uv[i * 2 + 1] : 0);
					if (col) {
						const c = col.data, k = col.components;
						const scale = c instanceof Uint8Array ? 1 / 255 : c instanceof Uint16Array ? 1 / 65535 : 1;
						group.colors.push(c[i * k] * scale, c[i * k + 1] * scale, c[i * k + 2] * scale, k === 4 ? c[i * k + 3] * scale : 1);
					} else {
						group.colors.push(1, 1, 1, 1);
					}
				}
				for (const index of indices) group.indices.push(base + index);
				if (!nor) group.flat = true;
			}
		}
		for (const child of node.children || []) visit(child, matrix);
	};
	const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
	const scene = json.scenes ? json.scenes[json.scene ?? 0] : { nodes: json.nodes.map((_, i) => i) };
	scene.nodes.forEach(n => visit(n, identity));

	const out = [];
	for (const [materialIndex, group] of groups) {
		if (group.flat) {
			// No normals given: face normals.
			group.normals = new Array(group.positions.length).fill(0);
			for (let i = 0; i < group.indices.length; i += 3) {
				const [a, b, c] = [group.indices[i], group.indices[i + 1], group.indices[i + 2]];
				const P = k => group.positions.slice(k * 3, k * 3 + 3);
				const [pa, pb, pc] = [P(a), P(b), P(c)];
				const u = pb.map((v, j) => v - pa[j]), v = pc.map((w, j) => w - pa[j]);
				const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
				for (const k of [a, b, c]) for (let j = 0; j < 3; j++) group.normals[k * 3 + j] += n[j];
			}
		}
		const material = materialIndex >= 0 ? json.materials[materialIndex] : {};
		const pbr = material.pbrMetallicRoughness || {};
		// Leaves: cut-out cards (alpha mask) in a material named for them.
		// Lit as one rounded canopy -- normals out from its middle -- not
		// card by card, which leaves most of them facing away from the sun.
		const foliage = material.alphaMode === 'MASK' && /leaf|leaves|foliage|needle|bush|canopy/i.test(material.name || '');
		if (foliage) {
			const n = group.positions.length / 3;
			const mid = [0, 0, 0], lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
			for (let i = 0; i < n; i++) for (let j = 0; j < 3; j++) { const v = group.positions[i * 3 + j]; mid[j] += v / n; lo[j] = Math.min(lo[j], v); hi[j] = Math.max(hi[j], v); }
			mid[1] = lo[1] + (hi[1] - lo[1]) * 0.35;   // a little low: the top is the bright side
			const reach = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 || 1;
			for (let i = 0; i < n; i++) {
				const d = [0, 1, 2].map(j => group.positions[i * 3 + j] - mid[j]);
				const l = Math.hypot(...d) || 1;
				for (let j = 0; j < 3; j++) group.normals[i * 3 + j] = d[j] / l;
				// Depth in the canopy, as painted foliage shows it: darker inside
				// and underneath, lighter at the outer tips and the top.
				const outer = Math.min(l / reach, 1);
				const up = (group.positions[i * 3 + 1] - lo[1]) / ((hi[1] - lo[1]) || 1);
				const shade = 0.5 + 0.35 * outer + 0.25 * up;
				for (let j = 0; j < 3; j++) group.colors[i * 4 + j] *= Math.min(shade, 1.1);
			}
		}
		const factor = pbr.baseColorFactor || [1, 1, 1, 1];
		let image = null, sampler = null;
		if (pbr.baseColorTexture) {
			const texture = json.textures[pbr.baseColorTexture.index];
			image = await loadImage(gltf, texture.source);
			sampler = texture.sampler !== undefined ? json.samplers[texture.sampler] : null;
		}
		out.push({
			positions: new Float32Array(group.positions),
			normals: new Float32Array(group.normals),
			uvs: new Float32Array(group.uvs),
			colors: new Float32Array(group.colors),
			foliage,
			indices: new Uint32Array(group.indices),
			name: material.name || '',
			color: [toSrgb(factor[0]), toSrgb(factor[1]), toSrgb(factor[2]), factor[3]],
			image, sampler,
			alpha: material.alphaMode || 'OPAQUE',
			cutoff: material.alphaCutoff ?? 0.5,
		});
	}
	return { groups: out, min, max };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/**
 * Where an instance of the glTF goes, in the original's own space (standing
 * on the origin, centred, up -y): scaled so its height matches the
 * original's (or by `scale`), turned the right way up, standing on its base.
 */
function fitMatrix(bounds, original, spec) {
	const height = bounds.max[1] - bounds.min[1] || 1;
	const s = Number.isFinite(spec.scale) ? spec.scale : (original.height / height) * (Number.isFinite(spec.size) ? spec.size : 1);
	const cx = (bounds.min[0] + bounds.max[0]) / 2, cz = (bounds.min[2] + bounds.max[2]) / 2;
	// x and z as they are, y flipped (glTF is +y up, RO -y up).
	return new Float32Array([s, 0, 0, 0, 0, -s, 0, 0, 0, 0, s, 0, -cx * s, bounds.min[1] * s, -cz * s, 1]);
}

function createHook(models, report) {
	let program = null;
	const meshes = new Map();   // name -> { groups (GPU), instanceBuffer, count }
	const pending = new Map();  // url -> Promise<flattened>
	let gl = null;

	const load = url => {
		if (!pending.has(url)) pending.set(url, fetchGltf(url).then(flatten));
		return pending.get(url);
	};

	function upload(flat) {
		return flat.groups.map(group => {
			const buffer = gl.createBuffer();
			const data = new Float32Array(group.positions.length / 3 * 12);
			for (let i = 0, n = group.positions.length / 3; i < n; i++) {
				data.set(group.positions.subarray(i * 3, i * 3 + 3), i * 12);
				data.set(group.normals.subarray(i * 3, i * 3 + 3), i * 12 + 3);
				data.set(group.uvs.subarray(i * 2, i * 2 + 2), i * 12 + 6);
				data.set(group.colors.subarray(i * 4, i * 4 + 4), i * 12 + 8);
			}
			gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
			gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
			const index = gl.createBuffer();
			gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index);
			gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, group.indices, gl.STATIC_DRAW);
			let texture = null;
			if (group.image) {
				texture = gl.createTexture();
				gl.bindTexture(gl.TEXTURE_2D, texture);
				gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
				gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, group.image);
				gl.generateMipmap(gl.TEXTURE_2D);
				const wrap = v => v ?? gl.REPEAT;
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap(group.sampler?.wrapS));
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap(group.sampler?.wrapT));
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			}
			return { buffer, index, count: group.indices.length, texture, color: group.color, alpha: group.alpha, cutoff: group.cutoff, name: group.name, foliage: group.foliage };
		});
	}

	function release(entry) {
		for (const group of entry.groups) {
			gl.deleteBuffer(group.buffer);
			gl.deleteBuffer(group.index);
			if (group.texture) gl.deleteTexture(group.texture);
		}
		gl.deleteBuffer(entry.instanceBuffer);
	}

	function drawGroup(group, entry, attribute, uniform) {
		gl.bindBuffer(gl.ARRAY_BUFFER, group.buffer);
		gl.enableVertexAttribArray(attribute.aPosition);
		gl.vertexAttribPointer(attribute.aPosition, 3, gl.FLOAT, false, 48, 0);
		gl.vertexAttribDivisor(attribute.aPosition, 0);
		if (attribute.aNormal >= 0) {
			gl.enableVertexAttribArray(attribute.aNormal);
			gl.vertexAttribPointer(attribute.aNormal, 3, gl.FLOAT, false, 48, 12);
			gl.vertexAttribDivisor(attribute.aNormal, 0);
		}
		if (attribute.aUv >= 0) {
			gl.enableVertexAttribArray(attribute.aUv);
			gl.vertexAttribPointer(attribute.aUv, 2, gl.FLOAT, false, 48, 24);
			gl.vertexAttribDivisor(attribute.aUv, 0);
		}
		if (attribute.aColor >= 0) {
			gl.enableVertexAttribArray(attribute.aColor);
			gl.vertexAttribPointer(attribute.aColor, 4, gl.FLOAT, false, 48, 32);
			gl.vertexAttribDivisor(attribute.aColor, 0);
		}
		gl.bindBuffer(gl.ARRAY_BUFFER, entry.instanceBuffer);
		for (let c = 0; c < 4; c++) {
			const loc = attribute.aInstance + c;
			gl.enableVertexAttribArray(loc);
			gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 64, c * 16);
			gl.vertexAttribDivisor(loc, 1);
		}
		gl.uniform4fv(uniform.uBaseColor, group.color);
		gl.uniform1i(uniform.uHasTexture, group.texture ? 1 : 0);
		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gl.TEXTURE_2D, group.texture);
		gl.uniform1i(uniform.uTexture, 0);
		gl.uniform1f(uniform.uAlphaCutoff, group.alpha === 'MASK' ? group.cutoff : -1);
		gl.uniform1i(uniform.uFoliage, group.foliage ? 1 : 0);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, group.index);
		gl.drawElementsInstanced(gl.TRIANGLES, group.count, gl.UNSIGNED_INT, 0, entry.instances);
		for (let c = 0; c < 4; c++) {
			gl.vertexAttribDivisor(attribute.aInstance + c, 0);
			gl.disableVertexAttribArray(attribute.aInstance + c);
		}
		gl.disableVertexAttribArray(attribute.aPosition);
		if (attribute.aNormal >= 0) gl.disableVertexAttribArray(attribute.aNormal);
		if (attribute.aUv >= 0) gl.disableVertexAttribArray(attribute.aUv);
		if (attribute.aColor >= 0) gl.disableVertexAttribArray(attribute.aColor);
	}

	function draw(ctx, blended) {
		if (!meshes.size) return;
		if (!program) {
			program = ctx.createProgram(VERTEX, FRAGMENT);
			program.attribute.aInstance = gl.getAttribLocation(program, 'aInstance');
		}
		const { modelView, projection, fog, light } = ctx;
		const uniform = program.uniform, attribute = program.attribute;
		gl.useProgram(program);
		gl.uniformMatrix4fv(uniform.uModelViewMat, false, modelView);
		gl.uniformMatrix4fv(uniform.uProjectionMat, false, projection);
		gl.uniform3fv(uniform.uLightDirection, light.direction || [0, -1, 0]);
		gl.uniform3fv(uniform.uLightAmbient, light.ambient);
		gl.uniform3fv(uniform.uLightDiffuse, light.diffuse);
		gl.uniform3fv(uniform.uLightEnv, light.env || [1, 1, 1]);
		gl.uniform1i(uniform.uLightMapUse, ctx.lightmap === false ? 0 : 1);
		gl.uniform1i(uniform.uFogUse, fog.use && fog.exist);
		gl.uniform1f(uniform.uFogNear, fog.near);
		gl.uniform1f(uniform.uFogFar, fog.far);
		gl.uniform3fv(uniform.uFogColor, fog.color);
		const depthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
		const blend = gl.isEnabled(gl.BLEND);
		gl.enable(gl.DEPTH_TEST);
		gl.depthMask(!blended);
		if (blended) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); } else gl.disable(gl.BLEND);
		for (const entry of meshes.values()) {
			for (const group of entry.groups) {
				if ((group.alpha === 'BLEND') === blended) drawGroup(group, entry, attribute, uniform);
			}
		}
		gl.depthMask(depthMask);
		if (blend) gl.enable(gl.BLEND); else gl.disable(gl.BLEND);
	}

	return {
		name: 'glTF models',
		replacesModels: Object.keys(models),
		init(context) { gl = context; },
		models(context, list) {
			gl = context;
			for (const original of list) {
				const spec = models[Object.keys(models).find(key => key.replace(/\\/g, '/').toLowerCase() === original.name)];
				if (!spec) continue;
				load(spec.url).then(flat => {
					if (!gl) return;
					const fit = fitMatrix(flat, original, spec);
					const matrices = new Float32Array(original.instances.length * 16);
					original.instances.forEach((m, i) => matrices.set(multiply(Float32Array.from(m), fit), i * 16));
					const instanceBuffer = gl.createBuffer();
					gl.bindBuffer(gl.ARRAY_BUFFER, instanceBuffer);
					gl.bufferData(gl.ARRAY_BUFFER, matrices, gl.STATIC_DRAW);
					const previous = meshes.get(original.name);
					if (previous) release(previous);
					const groups = upload(flat);
					// A mod's own colours for named materials ({ leafsGreen: [r, g, b] }, 0..1, sRGB).
					for (const group of groups) {
						const color = spec.colors && spec.colors[group.name];
						if (Array.isArray(color) && color.length >= 3) group.color = [color[0], color[1], color[2], group.color[3]];
					}
					meshes.set(original.name, { groups, instanceBuffer, instances: original.instances.length });
				}).catch(error => report(new Error(`${spec.url}: ${error.message}`)));
			}
		},
		render(stage, ctx) {
			if (stage === 'models') draw(ctx, false);
			else if (stage === 'end') draw(ctx, true);
		},
		free(context) {
			gl = context || gl;
			for (const entry of meshes.values()) release(entry);
			meshes.clear();
			if (program) gl.deleteProgram(program);
			program = null;
		},
	};
}

/**
 * Replace map models with glTF ones: { 'folder/name.rsm': { url, size?, scale?, colors? } }.
 * colors: { materialName: [r, g, b] } in place of those materials' base colour
 * (a multiplier on their texture: above 1 brightens a dark one, up to 4).
 * size: a multiple of the original's height (default 1); scale: an exact
 * scale instead. Applies to maps loaded from now on. Returns a function that
 * undoes it.
 * @param {object} models - checked by ExtensionRuntime
 * @param {Function} report
 */
export function replace(models, report) {
	if (typeof MapHooks?.modelNames !== 'function') {
		report(new Error('model replacement needs a newer client (MapHooks.modelNames)'));
		return () => {};
	}
	return MapHooks.register(createHook(models, report));
}
