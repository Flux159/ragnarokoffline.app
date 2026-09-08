import { componentStyle } from "./styles.js";
import { attachCommerce } from "./commerce.js";

function readLayout(api) {
  const value = api.preferences.get("layout", {});
  return {
    mode: ["auto", "on", "off"].includes(value?.mode) ? value.mode : "auto",
    scale: Math.max(0.85, Math.min(1.25, Number(value?.scale) || 1)),
  };
}
function usePhone(mode) {
  return (
    mode === "on" ||
    (mode === "auto" &&
      Math.min(screen.width, screen.height) <= 900 &&
      (navigator.maxTouchPoints > 0 || "ontouchstart" in window))
  );
}

export default function mobileUI(parameters, api) {
  if (api?.version !== 1) throw new Error("mobile-ui requires client API 1");
  let settings = readLayout(api);
  const phone = usePhone(settings.mode);
  const abort = new AbortController();
  const listen = (node, event, fn, options = {}) =>
    node.addEventListener(event, fn, { ...options, signal: abort.signal });
  // A second touch does not reliably generate a compatibility click. Activate
  // HUD actions on their own pointer release and deduplicate the primary click.
  const activate = (node, fn) => {
    const pointers = new Set();
    let lastTouch = -Infinity;
    listen(node, "pointerdown", (event) => {
      if (event.pointerType !== "touch" || node.disabled) return;
      pointers.add(event.pointerId);
      node.setPointerCapture(event.pointerId);
    });
    listen(node, "pointerup", (event) => {
      if (!pointers.delete(event.pointerId)) return;
      lastTouch = event.timeStamp;
      const box = node.getBoundingClientRect();
      if (
        !node.disabled &&
        event.clientX >= box.left &&
        event.clientX <= box.right &&
        event.clientY >= box.top &&
        event.clientY <= box.bottom
      )
        fn(event);
    });
    for (const type of ["pointercancel", "lostpointercapture"])
      listen(node, type, (event) => pointers.delete(event.pointerId));
    listen(node, "click", (event) => {
      if (event.detail !== 0 && event.timeStamp - lastTouch < 1000) return;
      fn(event);
    });
  };
  api.cleanup(() => abort.abort());
  const owned = new Map();
  const components = new Map();
  const rootStyle = document.documentElement.style;
  const propertyNames = [
    "--ro-view-width",
    "--ro-view-height",
    "--ro-view-top",
    "--ro-keyboard-height",
    "--ro-ui-scale",
  ];
  const oldProperties = propertyNames.map((name) => [
    name,
    rootStyle.getPropertyValue(name),
  ]);
  const viewport = () => {
    const view = window.visualViewport;
    rootStyle.setProperty("--ro-view-width", `${view?.width || innerWidth}px`);
    rootStyle.setProperty(
      "--ro-view-height",
      `${view?.height || innerHeight}px`,
    );
    rootStyle.setProperty("--ro-view-top", `${view?.offsetTop || 0}px`);
    rootStyle.setProperty(
      "--ro-keyboard-height",
      `${Math.max(0, innerHeight - (view?.height || innerHeight) - (view?.offsetTop || 0))}px`,
    );
    rootStyle.setProperty("--ro-ui-scale", settings.scale);
  };
  if (phone) {
    const pageStyle = document.createElement("style");
    pageStyle.textContent =
      'html,body{overflow:clip!important;width:100%;height:100%;margin:0}.win_popup_overlay{z-index:4999!important;background:#0005}.cursor{display:none!important}.ro-background{background-size:cover!important;background-position:center!important}.ro-background[data-ro-tiled="true"]{width:max(100vw,calc(100vh * 4 / 3))!important;height:max(100vh,calc(100vw * 3 / 4))!important;left:50%!important;top:50%!important;transform:translate(-50%,-50%)}';
    document.head.append(pageStyle);
    api.cleanup(() => pageStyle.remove());
  }
  // Keep a device-sized viewport when a phone user opts into desktop layout.
  // The generated api.html has no viewport meta; otherwise the browser falls
  // back to a 980px layout and touch hit testing changes after the reload.
  if (phone || usePhone("auto")) {
    viewport();
    listen(window, "resize", viewport);
    if (window.visualViewport) {
      listen(visualViewport, "resize", viewport);
      listen(visualViewport, "scroll", viewport);
    }
    let meta = document.querySelector("meta[name=viewport]");
    const hadMeta = Boolean(meta),
      content = meta?.getAttribute("content");
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "viewport";
      document.head.append(meta);
    }
    meta.content = "width=device-width, initial-scale=1, viewport-fit=cover";
    api.cleanup(() => {
      if (hadMeta) meta.setAttribute("content", content || "");
      else meta.remove();
    });
    api.cleanup(() => {
      for (const [name, value] of oldProperties)
        if (value) rootStyle.setProperty(name, value);
        else rootStyle.removeProperty(name);
    });
  }

  const host = document.createElement("div");
  host.id = "ragnarok-mobile";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
 :host{position:fixed;inset:0;pointer-events:none;z-index:1400;font:14px system-ui;color:#fff6df;}
 button,select,input {font:inherit;} button{pointer-events:auto;touch-action:manipulation;min-width:44px;min-height:44px;border:1px solid #d4bd8688;border-radius:9px;background:#29241fdf;color:#fff4d8;padding:8px 10px;box-sizing:border-box;}
 button:active{background:#715835;}button:focus-visible{outline:2px solid #edc778;outline-offset:2px;}
 [hidden]{display:none!important;}
 .hud{position:absolute;inset:0;pointer-events:none;}
 .vitals{position:absolute;left:calc(env(safe-area-inset-left) + 8px);top:calc(env(safe-area-inset-top) + 8px);width:calc(100vw - 188px);max-width:230px;border:1px solid #c6b18177;background:#1b1b18da;border-radius:7px;padding:6px;box-sizing:border-box;}
 .meter{height:7px;background:#080a0d;border-radius:4px;overflow:hidden;margin:3px 0;}.meter>div{height:100%;background:#63bf72;width:0;}#spbar{background:#619cdb;}
 .values{font-size:11px;line-height:14px;font-variant-numeric:tabular-nums;white-space:nowrap;}
 #target{font-size:12px;color:#e6cc8d;max-width:220px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;position:absolute;top:68px;left:8px;text-shadow:0 1px 3px #000;}
 #menuButton{position:absolute;top:calc(env(safe-area-inset-top) + 8px);right:96px;}
 .actions{position:absolute;right:calc(env(safe-area-inset-right) + 12px);bottom:calc(env(safe-area-inset-bottom) + 16px);display:grid;grid-template-columns:repeat(2,64px);gap:6px;pointer-events:auto;}
 .actions button{min-height:max(44px,calc(48px * var(--ro-ui-scale,1)));font-size:calc(14px * var(--ro-ui-scale,1));}#attack{grid-row:span 2;background:#6a3924e8;font-weight:600;font-size:16px;}
 .skills{position:absolute;right:calc(env(safe-area-inset-right) + 12px);bottom:calc(env(safe-area-inset-bottom) + 30px + max(88px,96px * var(--ro-ui-scale,1)));display:flex;gap:5px;pointer-events:auto;}
 .skills button{width:46px;height:46px;padding:4px;font-size:12px;background:#252c35e8;}
 .menu{position:absolute;right:8px;top:calc(env(safe-area-inset-top) + 62px);width:min(260px,calc(100vw - 16px));max-height:calc(var(--ro-view-height,100dvh) - 84px);overflow:auto;pointer-events:auto;background:#24221df5;border:1px solid #b4a27e;border-radius:10px;padding:8px;box-sizing:border-box;display:grid;grid-template-columns:1fr 1fr;gap:6px;}
 #displayButton{position:fixed;right:8px;bottom:8px;z-index:100;}
 /* Touch targets stay 44px; a mouse does not need one parked on the HUD. */
 @media (pointer: fine){#displayButton{min-width:0;min-height:0;padding:3px 9px;font-size:12px;opacity:.5;}
  #displayButton:hover,#displayButton:focus-visible{opacity:1;}}
 dialog{pointer-events:auto;color:#312b21;background:#fff7e8;border:1px solid #ae976c;border-radius:10px;padding:18px;width:min(330px,calc(100vw - 60px));max-height:calc(var(--ro-view-height,100dvh) - 64px);overflow:auto;font:15px/1.45 system-ui;}
 dialog::backdrop{background:#0008;}dialog h2{margin:0 0 12px;font-size:22px;}dialog label{display:block;margin:14px 0 5px;}dialog select{width:100%;min-height:44px;}dialog input{width:100%;min-height:44px;}dialog button{background:#59472c;color:#fff8e6;margin:10px 4px 0 0;}dialog p{margin:10px 0;}output{display:block;min-height:20px;}
 @media(max-height:480px){.skills{right:164px;bottom:20px;}.vitals{width:190px;}.actions{grid-template-columns:repeat(2,60px);}.menu{grid-template-columns:repeat(3,1fr);width:350px;}}
 </style>
 <div class="hud" hidden>
  <div class="vitals" aria-label="Health and skill points"><div class="values" id="hptext"></div><div class="meter"><div id="hpbar"></div></div><div class="values" id="sptext"></div><div class="meter"><div id="spbar"></div></div></div>
  <div id="target"></div><button id="menuButton" aria-expanded="false">Menu</button>
  <div class="skills" aria-label="Quick shortcuts">${[1, 2, 3, 4].map((n) => `<button data-shortcut="${n - 1}" aria-label="Use shortcut ${n}">F${n}</button>`).join("")}</div>
  <div class="actions"><button id="attack">Attack</button><button id="interact">Talk</button><button id="pickup">Pick up</button></div>
  <nav class="menu" aria-label="Game menu" hidden>
   ${["Inventory", "Equipment", "Skills", "Quests", "Stats", "Map", "Friends", "Storage", "Chat", "Target", "Display", "Game options", "Close"].map((name) => `<button data-menu="${name}">${name}</button>`).join("")}
  </nav>
 </div>
 <button id="displayButton" aria-haspopup="dialog">Display</button>
 <dialog aria-labelledby="displayTitle"><h2 id="displayTitle">Display settings</h2>
  <label for="layoutMode">Phone layout</label><select id="layoutMode"><option value="auto">Auto — touch screens</option><option value="on">On</option><option value="off">Off — desktop layout</option></select>
  <label for="uiScale">Control size</label><input id="uiScale" type="range" min="0.85" max="1.25" step="0.05"><output id="scaleValue"></output>
  <p>Phone and desktop window positions are saved separately. Changing layout mode takes effect when you reload the game.</p><output id="message" aria-live="polite"></output>
  <button id="reload">Save and reload</button><button id="done">Done</button>
 </dialog>`;
  document.body.append(host);
  api.cleanup(() => host.remove());
  // Keep both thumbs out of roBrowser's whole-window camera gesture handler.
  for (const event of [
    "pointerdown",
    "pointerup",
    "mousedown",
    "mouseup",
    "touchstart",
    "touchmove",
    "touchend",
    "touchcancel",
  ]) {
    listen(root, event, (e) => e.stopPropagation());
  }
  let releaseDialog = null;
  const dialog = root.querySelector("dialog");
  const save = () => {
    try {
      api.preferences.set("layout", settings);
      root.querySelector("#message").textContent = "Saved on this browser.";
      return true;
    } catch {
      root.querySelector("#message").textContent =
        "Browser storage is unavailable; changes apply only for this session.";
      return false;
    }
  };
  const openDisplay = () => {
    if (dialog.open) return;
    releaseDialog = api.input.suspend();
    dialog.showModal();
  };
  listen(root.querySelector("#displayButton"), "click", openDisplay);
  listen(dialog, "close", () => {
    releaseDialog?.();
    releaseDialog = null;
  });
  api.cleanup(() => releaseDialog?.());
  root.querySelector("#layoutMode").value = settings.mode;
  root.querySelector("#uiScale").value = settings.scale;
  root.querySelector("#scaleValue").textContent =
    `${Math.round(settings.scale * 100)}%`;
  listen(root.querySelector("#layoutMode"), "change", (e) => {
    settings.mode = e.target.value;
    save();
  });
  listen(root.querySelector("#uiScale"), "input", (e) => {
    settings.scale = Number(e.target.value);
    root.querySelector("#scaleValue").textContent =
      `${Math.round(settings.scale * 100)}%`;
    if (phone) viewport();
    save();
  });
  listen(root.querySelector("#done"), "click", () => dialog.close());
  listen(root.querySelector("#reload"), "click", () => {
    if (save()) location.reload();
  });
  const menu = root.querySelector(".menu");
  let releaseMenu = null;
  api.cleanup(() => releaseMenu?.());
  const toggleMenu = (value) => {
    releaseMenu?.();
    releaseMenu = null;
    if (value) {
      releaseMenu = api.input.suspend();
      host.style.zIndex = "4600";
    } else host.style.removeProperty("z-index");
    menu.hidden = !value;
    root
      .querySelector("#menuButton")
      .setAttribute("aria-expanded", String(value));
  };
  listen(root.querySelector("#menuButton"), "click", () =>
    toggleMenu(menu.hidden),
  );
  for (const name of ["attack", "interact", "pickup"])
    activate(root.querySelector(`#${name}`), () => api.actions.perform(name));
  for (const button of root.querySelectorAll("[data-shortcut]"))
    activate(button, () =>
      api.actions.perform("shortcut", {
        index: Number(button.dataset.shortcut),
      }),
    );
  for (const button of root.querySelectorAll("[data-menu]"))
    listen(button, "click", () => {
      const name = button.dataset.menu;
      toggleMenu(false);
      if (name === "Display") {
        openDisplay();
        return;
      }
      if (name === "Target") {
        api.actions.perform("target");
        return;
      }
      if (name === "Game options") {
        api.actions.perform("menu");
        return;
      }
      if (name === "Chat") {
        const chat = components.get("ChatBox");
        if (chat) {
          chat.host.dataset.roChatOpen = "true";
          chat.root.querySelector(".input-chatbox")?.focus();
        }
        return;
      }
      const windows = {
        Inventory: "Inventory",
        Equipment: "Equipment",
        Skills: "SkillList",
        Quests: "Quest",
        Stats: "WinStats",
        Map: "WorldMap",
        Friends: "PartyFriends",
        Storage: "Storage",
      };
      if (windows[name])
        api.actions.perform("window", { name: windows[name], open: true });
    });
  // Declared in mod.json and set in Settings > Mods. Off keeps the phone
  // layout and every other behaviour; it only withdraws the on-screen button.
  const showDisplayButton = parameters?.show_display_button !== false;
  const setPlaying = (playing) => {
    root.querySelector(".hud").hidden = !phone || !playing;
    root.querySelector("#displayButton").hidden =
      !showDisplayButton || (phone && playing);
    toggleMenu(false);
  };
  api.on("map:enter", () => setPlaying(true));
  api.on("map:leave", () => setPlaying(false));
  setPlaying(Boolean(api.snapshot().map));
  const update = () => {
    if (!phone || document.hidden) return;
    const state = api.snapshot(),
      player = state.player;
    if (!state.map || !player) return;
    const storage = components.get("Storage");
    const storageOpen = Boolean(
      storage?.host.isConnected &&
      storage.host.getClientRects().length &&
      getComputedStyle(storage.host).display !== "none",
    );
    root.querySelector('[data-menu="Storage"]').hidden = !storageOpen;
    for (const [name, component] of components)
      if (/^Inventory/.test(name)) {
        const controls = component.root.querySelector(".ro-storage-controls");
        if (controls) controls.hidden = !storageOpen;
        const itemActions = component.root.querySelector(".ro-item-actions");
        if (itemActions) itemActions.hidden = storageOpen;
      }
    for (const [key, maxKey, label] of [
      ["hp", "maxHp", "HP"],
      ["sp", "maxSp", "SP"],
    ]) {
      root.querySelector(`#${key}text`).textContent =
        `${label} ${Math.max(0, player[key])} / ${Math.max(0, player[maxKey])}`;
      root.querySelector(`#${key}bar`).style.width =
        `${Math.max(0, Math.min(100, (100 * player[key]) / Math.max(1, player[maxKey])))}%`;
    }
    root.querySelector("#target").textContent = state.target?.name || "";
    const shortcuts = components.get("ShortCut");
    if (shortcuts)
      for (const button of root.querySelectorAll("[data-shortcut]")) {
        const slot = shortcuts.root.querySelector(
          `.container[data-index="${button.dataset.shortcut}"]`,
        );
        const image = slot?.querySelector(".img")?.style.backgroundImage || "";
        button.style.backgroundImage = image;
        button.style.backgroundSize = "30px";
        button.style.backgroundPosition = "center";
        button.style.backgroundRepeat = "no-repeat";
        button.textContent = image
          ? ""
          : `F${Number(button.dataset.shortcut) + 1}`;
        button.setAttribute(
          "aria-label",
          image
            ? `Use ${slot.getAttribute("data-tooltip")}`
            : `Use shortcut ${Number(button.dataset.shortcut) + 1}`,
        );
      }
  };
  const interval = setInterval(update, 200);
  api.cleanup(() => clearInterval(interval));

  function attach(component) {
    if (!phone) return;
    const { name, root: ui, host: element } = component;
    components.set(name, component);
    if (owned.has(element)) return;
    const cleanups = [];
    const localAbort = new AbortController();
    cleanups.push(() => localAbort.abort());
    const on = (node, event, fn, options = {}) =>
      node?.addEventListener(event, fn, {
        ...options,
        signal: localAbort.signal,
      });
    const attribute = (node, key, value) => {
      if (!node) return;
      const old = node.getAttribute(key);
      node.setAttribute(key, value);
      cleanups.push(() => {
        if (old === null) node.removeAttribute(key);
        else node.setAttribute(key, old);
      });
    };
    const label = (node, text) => {
      if (!node) return;
      attribute(node, "aria-label", text);
      if (node.tagName === "BUTTON" || node.tagName === "UI-BUTTON") {
        attribute(node, "data-mobile-label", "true");
        const children = [...node.childNodes];
        node.textContent = text;
        cleanups.push(() => node.replaceChildren(...children));
      }
      if (node.tagName === "UI-BUTTON") {
        attribute(node, "role", "button");
        attribute(node, "tabindex", "0");
      }
    };
    let css = componentStyle(
      ui.querySelector("#win_popup") ? "WinPopup" : name,
    );
    if (name === "ChatBox")
      css +=
        ":host{display:none!important;}:host([data-ro-chat-open]){display:block!important;}";
    if (css) {
      const style = document.createElement("style");
      style.dataset.mobileStyle = name;
      style.textContent = css;
      ui.append(style);
      cleanups.push(() => style.remove());
    }
    const add = (parent, node) => {
      parent.append(node);
      cleanups.push(() => node.remove());
      return node;
    };
    const button = (text, fn) => {
      const node = document.createElement("button");
      node.className = "ro-mobile-button";
      node.textContent = text;
      on(node, "click", fn);
      return node;
    };
    // Touchable controls consume their own gesture; scrollable panels retain
    // browser scrolling instead of global touch-action:none.
    for (const event of ["touchstart", "touchmove", "touchend", "touchcancel"])
      on(ui, event, (e) => e.stopPropagation());
    // Native hover-based Mouse.intersect can be stale during fast touch taps.
    // Keep compatibility mousedown inside the GUI after its own focus/drag
    // handlers run. Mouseup still reaches the global drag/walk cleanup.
    on(element, "mousedown", (event) => event.stopPropagation());
    if (name === "MobileUI") {
      const base = ui.querySelector("#joystickBase");
      attribute(base, "aria-label", "Movement joystick");
      attribute(base, "role", "group");
    }
    if (/^WinLogin/.test(name)) {
      const container =
        ui.querySelector("#WinLogin .win_login") ||
        ui.querySelector("#WinLogin");
      if (container) {
        const title = document.createElement("h1");
        title.className = "ro-mobile-title";
        title.textContent = "Ragnarok Offline";
        container.prepend(title);
        cleanups.push(() => title.remove());
      }
      for (const [id, text] of [
        ["user", "Account"],
        ["pass", "Password"],
      ]) {
        const input = ui.querySelector(`#${id}`);
        attribute(input, "aria-label", text);
        attribute(input, "placeholder", text);
      }
      label(ui.querySelector(".connect"), "Log in");
      label(ui.querySelector(".signup"), "Sign up");
      label(ui.querySelector(".replay"), "Replay");
    }
    if (/^CharSelect/.test(name)) {
      label(ui.querySelector(".cancel"), "Back");
      label(ui.querySelector(".ok"), "Play");
      const row = document.createElement("div");
      row.className = "ro-mobile-toolbar";
      const continueButton = button("Play / create", () => {
        const selected =
          ui.querySelector("canvas[data-ro-selected]") ||
          ui.querySelector("#slot0");
        selected?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      });
      add(row, continueButton);
      add(
        ui.querySelector(".char_select_container") ||
          ui.querySelector(".ui-component-root"),
        row,
      );
      for (const canvas of ui.querySelectorAll(".char_canvas canvas")) {
        attribute(
          canvas,
          "aria-label",
          `Character slot ${Number(canvas.id.replace("slot", "")) + 1}`,
        );
        attribute(canvas, "role", "button");
        attribute(canvas, "tabindex", "0");
        cleanups.push(() => {
          delete canvas.dataset.roSelected;
          canvas.classList.remove("ro-mobile-selected");
        });
        on(canvas, "click", () => {
          ui.querySelectorAll("canvas").forEach((c) => {
            delete c.dataset.roSelected;
            c.classList.remove("ro-mobile-selected");
          });
          canvas.dataset.roSelected = "true";
          canvas.classList.add("ro-mobile-selected");
          canvas.dispatchEvent(
            new MouseEvent("mousedown", {
              bubbles: true,
              button: 0,
              buttons: 1,
            }),
          );
        });
      }
    }
    if (/^CharCreate/i.test(name)) {
      label(ui.querySelector(".btn.make"), "Create");
      label(ui.querySelector(".btn.cancel"), "Back");
      label(ui.querySelector(".btn.return"), "Return");
      label(ui.querySelector(".rot_left"), "Rotate left");
      label(ui.querySelector(".rot_right"), "Rotate right");
      const input = ui.querySelector("#char_name");
      attribute(input, "aria-label", "Character name");
      attribute(input, "placeholder", "Character name");
    }
    if (name === "ChatBox") {
      add(
        ui.querySelector(".ui-component-root"),
        button("Close chat", () => {
          delete element.dataset.roChatOpen;
          ui.activeElement?.blur();
        }),
      );
      const input = ui.querySelector(".input-chatbox");
      attribute(input, "aria-label", "Chat message");
      cleanups.push(() => delete element.dataset.roChatOpen);
    }
    if (name === "NpcBox") {
      label(ui.querySelector(".next"), "Next");
      label(ui.querySelector(".close"), "Close");
    }
    if (name === "Escape") {
      for (const [selector, text] of [
        [".resurection", "Resurrect"],
        [".savepoint", "Return to save point"],
        [".charselect", "Character selection"],
        [".graphics", "Graphics"],
        [".sound", "Sound"],
        [".hotkey", "Shortcuts"],
        [".exit", "Log out"],
        [".cancel", "Return to game"],
      ])
        label(ui.querySelector(selector), text);
    }
    if (name === "NpcMenu") {
      label(ui.querySelector(".ok"), "Choose");
      label(ui.querySelector(".cancel"), "Cancel");
    }
    if (name === "Quest") {
      label(ui.querySelector(".close-quest-container-btn"), "Close");
      for (const [id, text] of [
        ["active", "Active"],
        ["feature", "Story"],
        ["inactive", "Inactive"],
        ["cooldown", "Cooldown"],
      ]) {
        const tab = ui.querySelector(`#${id}.quest-menu-item`);
        if (!tab) continue;
        const children = [...tab.childNodes];
        tab.textContent = text;
        attribute(tab, "aria-label", text);
        attribute(tab, "role", "button");
        cleanups.push(() => tab.replaceChildren(...children));
      }
    }
    if (/^(Inventory|Equipment|SkillList)/.test(name)) {
      let selected = null;
      const toolbar = document.createElement("div");
      toolbar.className = "ro-mobile-toolbar ro-item-actions";
      const skills = /^SkillList/.test(name);
      // SkillList delegates native use/info to its icon/name, whereas item
      // windows delegate to the item itself. Dispatch through the actual
      // native action target so the toolbar follows both event contracts.
      const actionTarget = () => selected?.isConnected
        ? skills ? selected.querySelector('.icon, .name') : selected
        : null;
      const use = button(
        /^Equipment/.test(name)
          ? "Unequip"
          : skills
            ? "Use skill"
            : "Use / equip",
        () => {
          if (actionTarget())
            actionTarget().dispatchEvent(
              new MouseEvent("dblclick", { bubbles: true }),
            );
        },
      );
      use.disabled = true;
      add(toolbar, use);
      add(
        toolbar,
        button("Info", () => {
          if (actionTarget())
            actionTarget().dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
              }),
            );
        }),
      );
      if (!/^Equipment/.test(name)) {
        const message = document.createElement("output");
        message.textContent = "Tap an item or skill, then choose an action.";
        for (let slot = 0; slot < 4; slot++)
          add(
            toolbar,
            button(`Set F${slot + 1}`, () => {
              const id = Number(selected?.getAttribute("data-index"));
              const assigned =
                selected?.isConnected &&
                api.actions.perform("shortcut:assign", {
                  slot,
                  kind: skills ? "skill" : "item",
                  id,
                });
              message.textContent = assigned
                ? `Assigned to F${slot + 1}.`
                : "Select an item or a learned skill first.";
            }),
          );
        add(toolbar, message);
      }
      add(ui.querySelector(".ui-component-root"), toolbar);
      on(ui, "click", (event) => {
        const item = event.target.closest?.(
          skills ? ".skill[data-index]" : ".item[data-index]",
        );
        if (!item) return;
        selected?.classList.remove("ro-mobile-selected");
        selected = item;
        selected.classList.add("ro-mobile-selected");
        use.disabled = false;
      });
      cleanups.push(() => selected?.classList.remove("ro-mobile-selected"));
    }
    if (name === 'SkillDescription') label(ui.querySelector('.close'), 'Close');
    // Labels for native button controls do not change their visibility/state.
    for (const [selector, text] of [
      [".titlebar .close", "Close"],
      [".btns .cancel", "Cancel"],
      [".btns .ok", "OK"],
    ])
      label(ui.querySelector(selector), text);
    cleanups.push(
      attachCommerce({ component, api, on, add, button, label, attribute }),
    );
    owned.set(element, () => {
      for (const cleanup of cleanups.reverse()) cleanup();
      if (components.get(name)?.host === element) components.delete(name);
    });
  }
  function detach({ host }) {
    owned.get(host)?.();
    owned.delete(host);
  }
  api.on("ui:append", attach);
  api.on("ui:remove", detach);
  api.cleanup(() => {
    for (const dispose of owned.values()) dispose();
    owned.clear();
    components.clear();
  });
  return true;
}
