// Loading is sequential so a mod never races a preceding mod's async setup.
// Engine imports and URL resolution are provided by the small bundled adapter.
export function createPluginLoader({ runtime, importModule, report = console.error, timeout = 10000 }) {
    let generation = 0;
    let flight = null;
    let instances = [];
    let statuses = [];
    const deadline = promise => new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Plugin initialization timed out')), timeout);
        Promise.resolve(promise).then(resolve, reject).finally(() => clearTimeout(timer));
    });
    return Object.freeze({
        init(definitions) {
            if (flight) return flight;
            const mine = ++generation;
            flight = (async () => {
                for (const [name, config] of Object.entries(definitions || {})) {
                    if (mine !== generation) break;
                    let instance;
                    try {
                        const path = typeof config === 'string' ? config : config?.path;
                        if (!path) throw new Error('Plugin path is missing');
                        instance = runtime.scope(name);
                        instances.push(instance);
                        const module = await deadline(importModule(path));
                        if (mine !== generation) { instance.dispose(); break; }
                        if (typeof module.default !== 'function') throw new Error('Plugin must default-export an initializer');
                        const initialized = Promise.resolve(module.default(typeof config === 'object' ? config.pars : null, instance.api)).then(result => {
                            // Even a late return after timeout/disposal must release its resources.
                            if (typeof result === 'function') instance.api.cleanup(result);
                            else if (typeof result?.dispose === 'function') instance.api.cleanup(() => result.dispose());
                            return result;
                        });
                        const result = await deadline(initialized);
                        if (mine !== generation) { instance.dispose(); break; }
                        if (result === false) throw new Error('Plugin initializer returned false');
                        statuses.push(Object.freeze({ name, status: 'ready' }));
                    } catch (error) {
                        instance?.dispose();
                        if (mine !== generation) break;
                        statuses.push(Object.freeze({ name, status: 'failed', error: String(error.message || error) }));
                        report(`[Plugin ${name}] initialization failed`, error);
                    }
                }
                return Object.freeze([...statuses]);
            })();
            return flight;
        },
        dispose() {
            generation++;
            for (const instance of instances.reverse()) instance.dispose();
            instances = []; statuses = []; flight = null;
        },
        status() { return Object.freeze([...statuses]); },
    });
}
