import Configs from 'Core/Configs.js';
import Runtime from './Ragnarok/ExtensionRuntime.mjs';
import { createPluginLoader } from './Ragnarok/PluginLoader.mjs';

const loader = createPluginLoader({ runtime: Runtime, importModule(path) {
    // External plugin paths are relative to the page, not a hashed Vite chunk.
    const url = new URL(path, document.baseURI);
    if (!/\.m?js$/i.test(url.pathname)) url.pathname += '.js';
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== location.origin) {
        throw new Error('Plugins must be served from the game origin');
    }
    return import(/* @vite-ignore */ url.href);
} });

export default {
    init: () => loader.init(Configs.get('plugins') || {}),
    dispose: () => loader.dispose(),
    status: () => loader.status(),
};
