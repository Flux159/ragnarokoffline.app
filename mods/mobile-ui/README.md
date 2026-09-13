# mobile-ui

Bundled and enabled by default. **Display → Phone layout** offers Auto, On and
Off. Auto selects touch screens with a shorter side of at most 900 pixels.
Changing layout reloads the client; control size (85–125%) applies immediately.
Phone and desktop window positions are saved separately in each browser.

The phone layout provides a compact HP/SP display, native movement joystick,
Attack/Talk/Pickup buttons, four native shortcuts and a game menu. Login,
character selection/creation, inventory, equipment, skills, quests and NPC
windows get touch controls. Tap an item or skill before using its action
buttons. Inventory and skills can assign F1–F4 without dragging.

When storage is open, select an item and use Deposit/Withdraw with a quantity,
or Deposit all/Withdraw all. Open inventory and Back to storage bring the
respective panel forward. The server still authorizes each transfer; the
request message is not a success acknowledgement. Shops use Add selected,
the native quantity dialog, then Buy or Sell; Remove selected edits the cart.
Pick up approaches a distant item and collects it after the walk finishes. Moving
with the joystick or keyboard cancels that pending pickup.

Viewport and safe-area handling keep controls within the visible game. Small
touch devices retain a real viewport even with the phone layout Off. Default
desktop mode preserves the native layout. Physical phone keyboard/orientation
behavior and complete gameplay coverage remain release gates; see
[testing](../../docs/TESTING.md).

The ES module exports `default(params, api)`. Client API 1 supplies scoped
component append/remove events, native actions, input suspension, preferences
and cleanup. Styles are attached inside each native component's shadow root;
there is no document-wide MutationObserver. See
[the API contract](../../docs/MODDING.md#client-api-1).

Keyboard movement is provided by the separate `wasd-movement` mod and shares
movement ownership with the native joystick. Controller support remains future
work; it is not implemented by this mod.
