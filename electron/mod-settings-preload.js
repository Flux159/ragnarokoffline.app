'use strict';
//
// The only bridge a mod's settings page gets. Deliberately not preload.js,
// which hands the app's own pages every handler in main.js. See
// mod-settings-window.js for what each call may do.
//
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('modSettings', {
	get: () => ipcRenderer.invoke('mod-settings:get'),
	set: values => ipcRenderer.invoke('mod-settings:set', values),
	apply: () => ipcRenderer.invoke('mod-settings:apply'),
});
