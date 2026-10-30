# discord-announcements

Posts what happens on your world to a Discord channel:

- players logging in and out;
- base level milestones (99 by default, or any list such as `50,99,175`);
- MVP kills;
- War of Emperium starting and ending.

AI characters (the population engine's shells and companions) are left out.

## Setting it up

1. In Discord, open the channel's **Edit Channel → Integrations → Webhooks**,
   make a webhook and **Copy Webhook URL**.
2. Paste it into **Settings → General → Discord announcements** and press
   **Send a test**.
3. Install this mod from **Settings → Mods**, turn it on, pick the events, and **Apply**.

## How it works, and how your own mod can announce

The scripts here don't talk to Discord. They write a line to the map server's
log with `debugmes`, starting with `[discord] `:

```c
debugmes "[discord] **" + strcharinfo(0) + "** found a secret!";
```

While a webhook is set, the app follows the map server's log and posts every
such line, in order, a few at a time (`electron/discord-webhook.js`). Any mod's
script can do the same, with nothing else to set up. Discord markdown works,
and mentions are switched off, so a line cannot ping `@everyone`.
