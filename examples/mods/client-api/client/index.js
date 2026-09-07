export default function initialize(parameters, api) {
    if (api?.version !== 1) throw new Error('This example requires client API 1');
    const label = document.createElement('output');
    label.style.cssText = 'position:fixed;bottom:8px;right:8px;color:white;background:#222c;padding:8px;pointer-events:none;z-index:1000';
    document.body.append(label);
    api.cleanup(() => label.remove());
    api.on('map:enter', ({ name }) => { label.textContent = name; label.hidden = false; });
    api.on('map:leave', () => { label.hidden = true; });
    label.hidden = !api.snapshot().map;

    const styles = new Map();
    const remove = ({ host }) => { styles.get(host)?.remove(); styles.delete(host); };
    api.on('ui:append', component => {
        if (component.name !== 'ChatBox' || styles.has(component.host)) return;
        const style = document.createElement('style');
        style.textContent = ':host { outline:1px solid #b69f6c; }';
        component.root.append(style); styles.set(component.host, style);
    });
    api.on('ui:remove', remove);
    api.cleanup(() => { for (const style of styles.values()) style.remove(); styles.clear(); });
}
