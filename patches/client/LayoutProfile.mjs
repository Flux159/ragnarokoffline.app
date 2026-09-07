// Chosen before UI modules read geometry preferences. A profile switch reloads
// the page so the old layout is saved to its own bank, never the other device's.
import Configs from "Core/Configs.js";

let preference = {};
try {
  preference =
    JSON.parse(
      localStorage.getItem("ragnarok:plugin:mobile-ui:layout") || "{}",
    ) || {};
} catch {
  /* A fresh browser uses automatic detection. */
}
const available = Object.hasOwn(Configs.get("plugins") || {}, "mobile-ui");
export const mobileModAvailable = available;
const mode = ["auto", "on", "off"].includes(preference.mode)
  ? preference.mode
  : "auto";
const small = Math.min(window.screen.width, window.screen.height) <= 900;
const touch = navigator.maxTouchPoints > 0 || "ontouchstart" in window;
export const phoneLayout =
  available && (mode === "on" || (mode === "auto" && small && touch));
export function geometryKey(key, defaults) {
  // NpcStore creates nested per-shop geometry lazily from an empty default.
  return phoneLayout &&
    (key === "NpcStore" ||
      (defaults &&
        Object.hasOwn(defaults, "x") &&
        Object.hasOwn(defaults, "y")))
    ? `ragnarok:phone:${key}`
    : key;
}
