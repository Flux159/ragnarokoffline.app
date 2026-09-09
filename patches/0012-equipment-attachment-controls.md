# Equipment attachment controls

roBrowserLegacy includes buttons for removing character attachments and opening
the cart inventory, but its stylesheet hides both buttons. The state updater
attempts to reveal them by clearing their inline display value, which exposes
the stylesheet's `display: none` again. Consequently, neither control can ever
be used.

For the V4 equipment window used by Ragnarok Offline's 20221005 packet version,
the source patch moves the controls from the character preview into a 23-pixel
strip between the equipment grid and its footer. The strip reuses the official
`equipwin_bg3.bmp`, `grp_online.bmp`, `grp_offline.bmp`, and cart item button
assets. It is visible only on the General tab and only while a relevant state
is active, leaving Costume, Title, and Damage unchanged.

The removal control covers carts, falcons, Peco riding, dragon riding, and Mado
Gear, matching the states already handled by roBrowserLegacy and rAthena's
`CZ_REQ_CARTOFF` packet handler. If a character has both a mount attachment and
a cart, the server removes the attachment first and the cart on the next click.
Class-specific mounts activated through Halter Lead Box use `allRidingState`;
they are deliberately excluded because this packet does not remove them.

## Verification

The packaged desktop client was manually tested with Cart, Falcon, Peco,
Rune Knight dragon, and Mechanic Mado Gear. Cart inventory opening and the
two-step Mado Gear plus Cart removal flow were also verified.

The complete client patch was additionally applied twice to a clean checkout
of the pinned roBrowserLegacy revision to verify both applicability and
idempotency. The patched Web client and the final navigation-patched bundle
were then built and syntax-checked successfully.
