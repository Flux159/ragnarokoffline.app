// /q1 and /q2 -- the official client's quickspell toggles, which roBrowser
// never implemented.
//
//   /q1  right click casts the F9 hotkey        (MSI_QUICKSPELL_ON)
//   /q2  wheel up and down cast F7 and F8       (MSI_QUICKSPELL2_ON)
//   /q3  both                                   (MSI_EXPLAIN_QUICKSPELL3)
//
// The slot numbers are the official ones and are not configurable there, so
// they are not configurable here either. Shortcut rows are zero-indexed from
// F1, which puts F7, F8 and F9 at 6, 7 and 8.
import Preferences from 'Core/Preferences.js';
import UIManager from 'UI/UIManager.js';

export const SLOT_RIGHT_CLICK = 8;
export const SLOT_WHEEL_UP = 6;
export const SLOT_WHEEL_DOWN = 7;

// Per browser and per server origin, like every other client preference. Both
// default off, which is what the official client does.
const state = Preferences.get('QuickSpell', { rightClick: false, wheel: false }, 1.0);

export const QuickSpell = {
    get rightClick() { return Boolean(state.rightClick); },
    get wheel() { return Boolean(state.wheel); },
    set(field, value) {
        state[field] = Boolean(value);
        state.save();
        return state[field];
    },
    /**
     * Fire a shortcut slot, if the bar exists and something is in it.
     * Returns whether the press was consumed, so a caller can fall back to
     * whatever the button used to do.
     */
    cast(slot) {
        let bar;
        try { bar = UIManager.getComponent('ShortCut'); } catch { return false; }
        if (!bar || typeof bar.onShortCut !== 'function') return false;
        bar.onShortCut({ cmd: `EXECUTE${slot}` });
        return true;
    },
};

export default QuickSpell;
