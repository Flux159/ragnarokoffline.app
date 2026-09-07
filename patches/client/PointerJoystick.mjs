// One captured pointer controls movement. A second thumb remains free to use
// attack/skill controls without ending or moving the joystick gesture.
export function attachJoystick(base, thumb, movement) {
    const controller = new AbortController();
    const { signal } = controller;
    let pointer = null;
    const reset = () => {
        const old = pointer;
        pointer = null;
        thumb.style.transform = 'translate(0, 0)';
        if (old !== null && base.hasPointerCapture(old)) base.releasePointerCapture(old);
    };
    const source = movement.register('joystick', reset);
    const vector = event => {
        const box = base.getBoundingClientRect();
        const radius = Math.max(1, Math.min(box.width, box.height) / 2);
        let x = (event.clientX - box.left - box.width / 2) / radius;
        let y = (event.clientY - box.top - box.height / 2) / radius;
        const length = Math.hypot(x, y);
        const scale = Math.max(1, length);
        x /= scale; y /= scale;
        thumb.style.transform = `translate(${x * radius}px, ${y * radius}px)`;
        return length < 0.18 ? [0, 0] : [x, -y];
    };
    base.style.touchAction = 'none';
    base.addEventListener('pointerdown', event => {
        if (pointer !== null || (event.pointerType === 'mouse' && event.button !== 0)) return;
        event.preventDefault(); event.stopPropagation();
        if (!source.begin(...vector(event))) { reset(); return; }
        pointer = event.pointerId;
        base.setPointerCapture(pointer);
    }, { signal });
    base.addEventListener('pointermove', event => {
        if (event.pointerId !== pointer) return;
        event.preventDefault(); event.stopPropagation();
        source.update(...vector(event));
    }, { signal });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        base.addEventListener(type, event => {
            if (event.pointerId !== pointer) return;
            event.preventDefault(); event.stopPropagation();
            source.end(); reset();
        }, { signal });
    }
    // Suppress the compatibility mouse event that would start camera/map input.
    base.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); }, { signal });
    // Pointer capture does not stop the compatibility TouchEvent from reaching
    // the legacy whole-window camera gesture handler.
    for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
        base.addEventListener(type, event => event.stopPropagation(), { signal });
    }
    return () => { source.dispose(); reset(); controller.abort(); };
}
