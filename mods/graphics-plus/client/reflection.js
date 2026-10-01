/**
 * Graphics+: a planar reflection for the water: the scene drawn again, mirrored across
 * the water plane, into a texture the water shader samples. An oblique near
 * plane (Lengyel, "Oblique View Frustum Depth Projection and Clipping") cuts
 * away everything under the water, so nothing below the surface shows up in
 * its reflection -- with no change to any other shader.
 */

let _fbo = null;

/** Column-major 4x4 multiply: a * b. */
export function multiply(a, b) {
	const out = new Float32Array(16);
	for (let col = 0; col < 4; col++) {
		for (let row = 0; row < 4; row++) {
			let sum = 0;
			for (let k = 0; k < 4; k++) {
				sum += a[k * 4 + row] * b[col * 4 + k];
			}
			out[col * 4 + row] = sum;
		}
	}
	return out;
}

/** Column-major 4x4 inverse, or null if singular. */
export function invert(m) {
	const inv = new Float32Array(16);
	inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
	inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
	inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
	inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
	inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
	inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
	inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
	inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
	inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
	inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
	inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
	inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
	inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
	inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
	inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
	inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
	const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
	if (Math.abs(det) < 1e-12) {
		return null;
	}
	for (let i = 0; i < 16; i++) {
		inv[i] /= det;
	}
	return inv;
}

/**
 * The view mirrored across the horizontal plane y = level (world space; up is
 * negative y in RO), and a projection whose near plane is that plane, so only
 * what is above the water is drawn.
 */
export function mirrored(modelView, projection, level) {
	const reflect = new Float32Array([1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 2 * level, 0, 1]);
	const view = multiply(modelView, reflect);

	// The water plane in world space, positive above the water: -y + level.
	// Into the mirrored camera's space with the inverse transpose.
	const inv = invert(view);
	if (!inv) {
		return { view, projection };
	}
	const p = [0, -1, 0, level];
	const c = [0, 1, 2, 3].map(i => inv[i * 4] * p[0] + inv[i * 4 + 1] * p[1] + inv[i * 4 + 2] * p[2] + inv[i * 4 + 3] * p[3]);
	if (c[3] > 0) {
		// The camera must be on the negative side; it is unless it's under water.
		return { view, projection };
	}
	const proj = Float32Array.from(projection);
	const q = [(Math.sign(c[0]) + proj[8]) / proj[0], (Math.sign(c[1]) + proj[9]) / proj[5], -1, (1 + proj[10]) / proj[14]];
	const scale = 2 / (c[0] * q[0] + c[1] * q[1] + c[2] * q[2] + c[3] * q[3]);
	proj[2] = c[0] * scale;
	proj[6] = c[1] * scale;
	proj[10] = c[2] * scale + 1;
	proj[14] = c[3] * scale;
	return { view, projection: proj };
}

/**
 * Draw the reflection: `draw(view, projection)` renders what should appear in
 * it. Returns the texture, or null if it could not be made.
 */
export function render(gl, modelView, projection, level, draw) {
	const width = Math.max(1, Math.floor(gl.canvas.width / 2));
	const height = Math.max(1, Math.floor(gl.canvas.height / 2));

	if (!_fbo || _fbo.width !== width || _fbo.height !== height) {
		free(gl);
		const framebuffer = gl.createFramebuffer();
		const texture = gl.createTexture();
		const depth = gl.createRenderbuffer();
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
		gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, width, height);
		gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
		gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
		if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.deleteFramebuffer(framebuffer);
			gl.deleteTexture(texture);
			gl.deleteRenderbuffer(depth);
			return null;
		}
		_fbo = { framebuffer, texture, depth, width, height };
	}

	const { view, projection: clipped } = mirrored(modelView, projection, level);
	gl.bindFramebuffer(gl.FRAMEBUFFER, _fbo.framebuffer);
	gl.viewport(0, 0, width, height);
	gl.clearColor(0, 0, 0, 0);
	gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
	// Whatever the last pass of the previous frame left, the mirror needs depth.
	const depthTest = gl.isEnabled(gl.DEPTH_TEST);
	gl.enable(gl.DEPTH_TEST);
	gl.depthMask(true);
	draw(view, clipped);
	if (!depthTest) {
		gl.disable(gl.DEPTH_TEST);
	}
	gl.bindFramebuffer(gl.FRAMEBUFFER, null);
	return _fbo.texture;
}

export function free(gl) {
	if (_fbo) {
		gl.deleteFramebuffer(_fbo.framebuffer);
		gl.deleteTexture(_fbo.texture);
		gl.deleteRenderbuffer(_fbo.depth);
		_fbo = null;
	}
}
