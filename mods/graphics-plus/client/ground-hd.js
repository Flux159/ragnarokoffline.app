/**
 * Graphics+: high-resolution ground textures. The client draws every ground
 * texture into one atlas at 256x256 each, whatever size the file is. When a
 * map has larger textures (a texture pack mod's), this rebuilds the atlas at
 * two or four times the scale (as far as a 4096x4096 atlas allows) -- same layout, so the ground's texture
 * coordinates still fit -- and puts it into the client's atlas texture, with
 * mipmaps and anisotropic filtering so it stays sharp at a slant. Maps whose
 * textures are all 256x256 are left alone.
 */

const SLOT = 258;   // the client's: 256 and a 1-pixel border each side

let _map = null;
let _canvas = null;     // the rebuilt atlas, waiting to be uploaded
let _uploaded = null;   // the client atlas texture we filled
let _generation = 0;

function loadImage(url) {
	return new Promise(resolve => {
		const image = new Image();
		image.onload = () => resolve(image);
		image.onerror = () => resolve(null);
		image.src = url;
	});
}

/** The atlas, at `scale` times the client's, from the full-size images. */
function buildAtlas(images, scale) {
	const count = images.length;
	const cols = Math.round(Math.sqrt(count));
	const rows = Math.ceil(Math.sqrt(count));
	const pow2 = n => 2 ** Math.ceil(Math.log2(n));
	const canvas = document.createElement('canvas');
	canvas.width = pow2(cols * SLOT) * scale;
	canvas.height = pow2(rows * SLOT) * scale;
	const g = canvas.getContext('2d');
	g.imageSmoothingQuality = 'high';
	const slot = SLOT * scale;
	images.forEach((image, index) => {
		if (!image) return;
		const x = (index % cols) * slot;
		const y = Math.floor(index / cols) * slot;
		g.drawImage(image, x, y, slot, slot);                                       // the border
		g.drawImage(image, x + scale, y + scale, slot - 2 * scale, slot - 2 * scale);
	});
	return canvas;
}

async function prepare(map, generation, maxSize) {
	const urls = map.textureUrls || [];
	if (!urls.length) return;
	const images = await Promise.all(urls.map(loadImage));
	if (generation !== _generation) return;   // another map since
	const largest = Math.max(0, ...images.map(image => (image ? Math.max(image.naturalWidth, image.naturalHeight) : 0)));
	if (largest <= 256) return;               // nothing to gain
	const cols = Math.round(Math.sqrt(urls.length));
	const rows = Math.ceil(Math.sqrt(urls.length));
	const base = Math.max(2 ** Math.ceil(Math.log2(cols * SLOT)), 2 ** Math.ceil(Math.log2(rows * SLOT)));
	let scale = Math.min(4, 2 ** Math.ceil(Math.log2(largest / 256)));
	while (scale > 1 && base * scale > maxSize) scale /= 2;
	if (scale <= 1) return;
	_canvas = buildAtlas(images, scale);
	console.log(`[graphics-plus] ground textures at ${256 * scale}px (atlas ${_canvas.width}x${_canvas.height})`);
}

function upload(gl) {
	const atlas = _map && _map.groundTextures().atlas;
	if (!_canvas || !atlas || _uploaded === atlas) return;
	gl.bindTexture(gl.TEXTURE_2D, atlas);
	gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, _canvas);
	gl.generateMipmap(gl.TEXTURE_2D);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
	const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
	if (aniso) {
		gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
	}
	_uploaded = atlas;
	_canvas = null;   // the GPU has it
}

/** High-resolution ground as a map hook. */
export function groundHdHook() {
	return {
		name: 'High-resolution ground',
		init(gl, map) {
			_map = map;
			_canvas = null;
			_uploaded = null;
			const generation = ++_generation;
			// At most 4096x4096 (64 MB, a third more with mipmaps): every
			// texture in the atlas is scaled, not just the large ones.
			prepare(map, generation, Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE))).catch(error => console.error('[graphics-plus] ground textures', error));
		},
		render(stage, ctx) {
			// The client fills its atlas when its own textures have loaded;
			// ours goes in after that, once.
			if (stage === 'begin') upload(ctx.gl);
		},
		free() {
			// The atlas texture is the client's; it deletes it with the map.
			_map = null;
			_canvas = null;
			_uploaded = null;
			_generation++;
		},
	};
}
