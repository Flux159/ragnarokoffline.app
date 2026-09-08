// Trusted Settings page only. Passwords are kept out of the general log pane,
// preferences and diagnostics, and cleared after every attempted operation.
(() => {
  const element = (id) => document.getElementById(id);
  let snapshot = null,
    busy = false;
  // A refusal has to look like one. Every message used to land in the same
  // dim note style as "Loading accounts…", so a rejected password change was
  // indistinguishable from progress and read as the button doing nothing.
  const status = (message, kind = "") => {
    const node = element("accounts-status");
    node.classList.remove("bad", "good");
    if (kind) node.classList.add(kind);
    node.textContent = message;
    // A refusal that scrolls off-screen is a refusal nobody reads.
    if (kind === "bad") node.scrollIntoView({ block: "nearest" });
  };
  const selected = () =>
    snapshot?.accounts.find(
      (account) => account.id === element("account-select").value,
    );
  function paint() {
    const account = selected();
    element("account-select").disabled = busy || !snapshot;
    for (const id of [
      "accounts-refresh",
      "account-password",
      "account-confirmation",
      "account-username",
    ])
      element(id).disabled = busy;
    element("account-create").disabled = busy || !snapshot;
    element("account-password-save").disabled = busy || !account;
    element("account-disable").disabled =
      busy || !account || account.state !== 0;
    element("account-enable").disabled =
      busy || !account || account.state === 0;
    element("account-password-save").textContent =
      account?.group >= 99 ? "Change GM/admin password" : "Change password";
    element("account-detail").textContent = account
      ? `${account.username} · ID ${account.id} · group ${account.group} · ${account.state === 0 ? "enabled" : "disabled (state " + account.state + ")"}${account.defaultPassword ? " · uses the shipped default password" : ""}`
      : "";
  }
  async function refresh() {
    if (busy) return;
    busy = true;
    paint();
    status("Loading accounts…");
    try {
      const settings = await invoke("get_settings");
      const era = settings.prerenewal ? "prerenewal" : "renewal";
      snapshot = await invoke("accounts", { action: "list", era });
      element("accounts-era").textContent =
        era === "prerenewal" ? "Pre-renewal accounts" : "Renewal accounts";
      const select = element("account-select");
      select.replaceChildren();
      for (const account of snapshot.accounts) {
        const option = document.createElement("option");
        option.value = account.id;
        option.textContent = `${account.username} (ID ${account.id})`;
        select.append(option);
      }
      const gm = snapshot.accounts.find(
        (account) => account.username.toLowerCase() === "ragnarok",
      );
      if (gm) select.value = gm.id;
      status(
        snapshot.accounts.some(
          (account) =>
            account.group > 0 && account.defaultPassword && account.state === 0,
        )
          ? "An enabled privileged account uses ragnarok as its password. Change or disable it before internet sharing."
          : "Accounts loaded. Select an account to manage it.",
      );
    } catch (error) {
      snapshot = null;
      status(error.message || "Could not load accounts", "bad");
    } finally {
      busy = false;
      paint();
    }
  }
  async function change(action) {
    if (busy || !snapshot) return;
    const account = selected();
    const request = { action, era: snapshot.era };
    if (action === "create")
      request.username = element("account-username").value;
    else if (account)
      Object.assign(request, { id: account.id, username: account.username });
    else return;
    if (action === "password" || action === "create") {
      request.password = element("account-password").value;
      request.confirmation = element("account-confirmation").value;
    }
    busy = true;
    paint();
    status("Updating the account and restarting game services…");
    let message;
    let failed = true;
    try {
      const result = await invoke("accounts", request);
      if (!result.updated)
        throw new Error("The account update was not confirmed");
      message = `Account updated in ${result.era === "prerenewal" ? "pre-renewal" : "renewal"}. Log in again.`;
      failed = false;
    } catch (error) {
      message = error.message || "Account update failed";
    } finally {
      element("account-password").value = element(
        "account-confirmation",
      ).value = "";
      delete request.password;
      delete request.confirmation;
      busy = false;
    }
    await refresh();
    status(message, failed ? "bad" : "good");
  }
  element("accounts-refresh").onclick = refresh;
  element("account-select").onchange = paint;
  element("account-password-save").onclick = () => change("password");
  element("account-disable").onclick = () => change("disable");
  element("account-enable").onclick = () => change("enable");
  element("account-create").onclick = () => change("create");
})();
