// Tap actions around native shop/storage handlers. DOM references and listeners
// are owned by the component attachment and released with it.
export function attachCommerce({
  component,
  api,
  on,
  add,
  button,
  label,
  attribute,
}) {
  const { name, root } = component;
  let selected = null;
  const select = (selector) =>
    on(root, "click", (event) => {
      const item = event.target.closest?.(selector);
      if (!item) return;
      selected?.classList.remove("ro-mobile-selected");
      selected = item;
      selected.classList.add("ro-mobile-selected");
    });
  const act = (callback) => {
    if (selected?.isConnected) callback(selected);
  };
  const toolbar = () => {
    const node = document.createElement("div");
    node.className = "ro-mobile-toolbar";
    return node;
  };
  if (root.querySelector("#win_popup")) {
    for (const [key, text] of [
      ["buy", "Buy"],
      ["sell", "Sell"],
      ["cancel", "Cancel"],
      ["ok", "OK"],
      ["close", "Close"],
    ]) {
      label(
        root.querySelector(`button[data-background="btn_${key}.bmp"]`),
        text,
      );
    }
  }
  if (name === "InputBox") {
    label(root.querySelector("ui-button"), "OK");
    attribute(root.querySelector("input"), "aria-label", "Value");
  }
  if (name === "NpcStore") {
    label(root.querySelector(".btn.buy"), "Buy");
    label(root.querySelector(".btn.sell"), "Sell");
    label(root.querySelector(".btn.cancel"), "Cancel");
    label(root.querySelector(".btn.ok"), "OK");
    select(".item[data-index]");
    for (const [selector, text] of [
      [".InputWindow", "Add selected"],
      [".OutputWindow", "Remove selected"],
    ]) {
      const panel = root.querySelector(selector),
        bar = toolbar();
      add(
        bar,
        button(text, () =>
          act((item) => {
            if (panel.contains(item))
              item.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
          }),
        ),
      );
      add(
        bar,
        button("Item info", () =>
          act((item) => {
            item.querySelector(".icon")?.dispatchEvent(
              new MouseEvent("contextmenu", {
                bubbles: true,
                cancelable: true,
                button: 2,
              }),
            );
          }),
        ),
      );
      add(panel, bar);
    }
  }
  if (name === "Storage" || /^Inventory/.test(name)) {
    const deposit = name !== "Storage",
      bar = toolbar();
    bar.classList.add("ro-storage-controls");
    if (deposit) bar.hidden = true;
    const quantity = document.createElement("input");
    quantity.type = "number";
    quantity.inputMode = "numeric";
    quantity.min = "1";
    quantity.step = "1";
    quantity.value = "1";
    quantity.setAttribute(
      "aria-label",
      deposit ? "Deposit quantity" : "Withdraw quantity",
    );
    const message = document.createElement("output");
    message.setAttribute("aria-live", "polite");
    const transfer = (count) =>
      act((item) => {
        const dispatched = api.actions.perform("storage:transfer", {
          direction: deposit ? "deposit" : "withdraw",
          index: Number(item.dataset.index),
          count,
        });
        message.textContent = dispatched
          ? "Transfer requested."
          : "Choose an available quantity of an unequipped item.";
      });
    add(bar, quantity);
    add(
      bar,
      button(deposit ? "Deposit" : "Withdraw", () =>
        transfer(Number(quantity.value)),
      ),
    );
    add(
      bar,
      button(deposit ? "Deposit all" : "Withdraw all", () => transfer("all")),
    );
    add(
      bar,
      button(deposit ? "Back to storage" : "Open inventory", () =>
        api.actions.perform("window", {
          name: deposit ? "Storage" : "Inventory",
          open: true,
        }),
      ),
    );
    add(bar, message);
    add(root.querySelector(".ui-component-root"), bar);
    select(".content .item[data-index]");
    if (!deposit) {
      label(root.querySelector(".close"), "Close storage");
      label(root.querySelector(".search-button"), "Search");
      attribute(
        root.querySelector(".search-input"),
        "aria-label",
        "Search storage",
      );
      for (const [key, title] of [
        ["item", "Use"],
        ["kafra", "Cash"],
        ["armor", "Armor"],
        ["arms", "Weapon"],
        ["ammo", "Ammo"],
        ["card", "Card"],
        ["etc", "Etc"],
      ])
        label(root.querySelector(`.tabs button.${key}`), title);
    }
  }
  return () => selected?.classList.remove("ro-mobile-selected");
}
