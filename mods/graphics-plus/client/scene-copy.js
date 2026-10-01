/**
 * Graphics+: copies of the scene drawn so far, for what is drawn after it and needs to
 * know what is underneath: water reads the depth to know how deep it is,
 * grass reads the depth to stay behind models and the colour to grow only
 * on green ground. WebGL 2 only (the copy is a framebuffer blit); null
 * otherwise, and the callers fall back to doing without.
 */

let _depth = null;
let _color = null;

function isWebGL2(gl) {
	return typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
}

function target(gl, old, w, h, internal, format, type, attachment, filter) {
	if (old && old.w === w && old.h === h) {
		return old;
	}
	if (old) {
		gl.deleteFramebuffer(old.fbo);
		gl.deleteTexture(old.texture);
	}
	const current = gl.getParameter(gl.FRAMEBUFFER_BINDING);
	const texture = gl.createTexture();
	gl.bindTexture(gl.TEXTURE_2D, texture);
	gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	const fbo = gl.createFramebuffer();
	gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
	gl.framebufferTexture2D(gl.FRAMEBUFFER, attachment, gl.TEXTURE_2D, texture, 0);
	if (attachment === gl.DEPTH_ATTACHMENT) {
		gl.drawBuffers([gl.NONE]);
		gl.readBuffer(gl.NONE);
	}
	gl.bindFramebuffer(gl.FRAMEBUFFER, current);
	return { fbo, texture, w, h };
}

function blit(gl, into, bits) {
	const current = gl.getParameter(gl.FRAMEBUFFER_BINDING);
	const vp = gl.getParameter(gl.VIEWPORT);
	gl.getError();
	gl.bindFramebuffer(gl.READ_FRAMEBUFFER, current);
	gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, into.fbo);
	gl.blitFramebuffer(vp[0], vp[1], vp[0] + vp[2], vp[1] + vp[3], 0, 0, into.w, into.h, bits, gl.NEAREST);
	gl.bindFramebuffer(gl.FRAMEBUFFER, current);
	return gl.getError() === gl.NO_ERROR ? into.texture : null;
}

/**
 * The depth drawn so far, as a texture, or null. Only when drawing into a
 * framebuffer (the post-processing target): the screen's own cannot be read.
 */
function depth(gl) {
	if (!isWebGL2(gl) || !gl.getParameter(gl.FRAMEBUFFER_BINDING)) {
		return null;
	}
	const vp = gl.getParameter(gl.VIEWPORT);
	_depth = target(gl, _depth, vp[2], vp[3], gl.DEPTH_COMPONENT24, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, gl.DEPTH_ATTACHMENT, gl.NEAREST);
	return blit(gl, _depth, gl.DEPTH_BUFFER_BIT);
}

/** The colour drawn so far, as a texture, or null. */
function color(gl) {
	if (!isWebGL2(gl) || !gl.getParameter(gl.FRAMEBUFFER_BINDING)) {
		return null;
	}
	const vp = gl.getParameter(gl.VIEWPORT);
	_color = target(gl, _color, vp[2], vp[3], gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE, gl.COLOR_ATTACHMENT0, gl.LINEAR);
	return blit(gl, _color, gl.COLOR_BUFFER_BIT);
}

/** Let go of the copies (the map is going away). */
function free(gl) {
	for (const copy of [_depth, _color]) {
		if (copy) {
			gl.deleteFramebuffer(copy.fbo);
			gl.deleteTexture(copy.texture);
		}
	}
	_depth = _color = null;
}

export default { depth, color, free };
