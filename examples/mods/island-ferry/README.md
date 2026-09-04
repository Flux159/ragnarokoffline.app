# island-ferry

A way into the island from a map people are already standing on. Trivial once
[custom-map](../custom-map) works and impossible before it, which is why it is
its own folder.

**Install `custom-map` first.** Without it there is no `ro_isle` to go to, and
the failure is loud in a useful way: `warp` reports the map is unknown, and the
NPC's `warp` command fails at runtime with the map name in the map server log.

Two ways in, both in `npc/ferry.txt`:

- **A warp square** at `prontera 159 178`. Walk into it, and you are across.
  Four numbers after the name: the trigger area's width and height, then the
  destination map and coordinates.
- **Ferryman Osric** at `prontera 155 178`, who asks first. Same trip, but an
  NPC can charge zeny, check a level or refuse — a warp square cannot.

## What to look at first

`close2` before `warp`, in the NPC. `close` waits for the player to dismiss the
dialogue and *then* ends the script; `close2` closes the box and keeps running,
which is what you want when the next thing you do is move the player. Using
`close` here leaves the script sitting on a box that is already gone.

## Coming back

The return warp is in `custom-map`, not here, and it is deliberately at the far
end of the island rather than under the arrival point. A return warp placed
where the ferry drops you fires the instant you land and puts you back in
Prontera — which looks exactly like the map not working at all.

## Applying it

`npc/` is read when the **server** starts.
