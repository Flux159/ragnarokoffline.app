'use strict';
//
// Exposes the shape the pages already use.
//
// index.html, setup.html and settings.html were written against Tauri's
// `window.__TAURI__.core.invoke(name, args)` and `window.__TAURI__.dialog`.
// Rather than rewrite three working pages as part of an engine swap, this
// presents the same surface over ipcRenderer. The pages stay byte-identical,
// so if one misbehaves after the move it is the shell that changed, not the
// page — which is the only way to keep the migration diff honest.
//
// It is a compatibility shim, not an endorsement: once the move has settled,
// renaming this to something that is not another framework's namespace is a
// tidy-up worth doing.
//
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (name, args) => ipcRenderer.invoke('invoke', name, args);

contextBridge.exposeInMainWorld('__TAURI__', {
	core: { invoke },
	// Tauri's dialog plugin returns a path string, an array for multiple, or
	// null when cancelled. Matched exactly, because the pages branch on
	// `typeof picked === 'string'`.
	dialog: {
		open: (opts = {}) => invoke('__dialog_open', opts),
		save: (opts = {}) => invoke('__dialog_save', opts),
	},
});
