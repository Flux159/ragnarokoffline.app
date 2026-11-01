// Companion Living Style v1.6.0: supported Client API 1, no engine/packet hooks.
export default function init(parameters, api) {
    if (api?.version !== 1) throw new Error('Companion Living Style needs Client API 1.');
    let disposed = false;
    const timers = new Set();
    function cancel() {
        for (const id of timers) clearTimeout(id);
        timers.clear();
    }
    function arrive() {
        cancel();
        if (disposed) return;
        // First request on arrival, then bounded retries while the town populates.
        for (const delay of [0, 150, 500, 1200]) {
            const id = setTimeout(() => {
                timers.delete(id);
                if (!disposed) Promise.resolve(api.server.request('dlsrefresh', '', { timeout: 2000 })).catch(() => {});
            }, delay);
            timers.add(id);
        }
    }
    const offEnter = api.on('map:enter', arrive);
    const offLeave = api.on('map:leave', cancel);
    const offExit = api.on('exit', cancel);
    if (api.snapshot()?.map?.name) arrive();
    function dispose() {
        if (disposed) return;
        disposed = true;
        cancel();
        offEnter?.(); offLeave?.(); offExit?.();
    }
    api.cleanup(dispose);
    return dispose;
}
