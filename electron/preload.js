'use strict';
//
// The bridge between the app's own pages and the main process.
//
//   window.__ELECTRON__.core.invoke(name, args)  -> the handlers in main.js
//   window.__ELECTRON__.dialog.open/save(opts)   -> native file dialogs
//
// This was `window.__TAURI__` for a while: the pages were written against
// Tauri's API and the shim kept them byte-identical through the engine swap, so
// that anything which misbehaved afterwards was known to be the shell rather
// than the page. That migration has long since settled, and carrying another
// framework's namespace only invites the question of whether we still use it.
// We do not.
//
// `dialog` keeps Tauri's *return shape* rather than Electron's, because the
// pages branch on it: a path string, an array when multiple, or null when
// cancelled. That is a page contract, not a framework leftover.
//
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (name, args) => ipcRenderer.invoke('invoke', name, args);

contextBridge.exposeInMainWorld('__ELECTRON__', {
	core: { invoke },
	dialog: {
		open: (opts = {}) => invoke('__dialog_open', opts),
		save: (opts = {}) => invoke('__dialog_save', opts),
	},
});
