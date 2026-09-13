# The walk fast-forward ran on a clock that was never set

A walk arrives from the server with the tick it started at. The client rolls
the animation back by however long the packet took to arrive, so the character
is drawn where it has really got to by now. Both numbers that needs are wrong.

## The round trip that was never measured

```js
SP.returned  = true;
SP.pongTime  = 0;
SP.value     = SP.pongTime - SP.pingTime;
Session.serverTick = pkt.time + SP.value / 2; // Adjust with half ping
```

`pongTime` is assigned `0` and then `value` is computed from it, so `value` is
always `-pingTime`. `pingTime` is not a timestamp either — it is
`Date.now() - startTick`, the age of the connection. So the "half ping"
correction is minus half the age of the session, and it grows for as long as
you play. Measured on a ten-second-old connection:

| field | value |
|---|---|
| `pingTime` | 10048 |
| `pongTime` | 0 |
| `value` | -10048 |

`serverTick` was set 5,024 ms behind the server, and half an hour into a
session it would be fifteen minutes behind.

## The two clocks that were never the same clock

Before any pong, `Session.serverTick` counts from the moment the renderer
started. `moveStartTime` counts from the moment the map server started. The
guard in `computeWalkStartTick` was `!Session.serverTick`, which is only false
on the very first frame, so the subtraction went ahead on two unrelated clocks.

Over twelve clicked moves on a development machine the difference sat at a
steady **-40379 ms** — negative, so `elapsed <= 0` and the fast-forward never
ran at all. That is why this does not reproduce on a machine that launches the
app and plays: the code is simply dead there.

It stops being dead when the page outlives the map server, which **Apply, an
era switch, Repair and crash recovery all arrange**. Then the same subtraction
comes out positive, and for a player-like entity the clamp is the whole path
duration:

```js
const maxFastForward = isPlayerLike ? pathDuration : Math.min(pathDuration, this.walk.speed);
```

So the character is drawn at the far end of a path it has not walked, and the
next server update drags it back. That is the reported symptom: a click, a step
backwards, then the walk.

## The fix

Measure the round trip against the base `pingTime` is already measured from,
and refuse to fast-forward anything until a pong has put `serverTick` on the
server's clock. `serverTickSynced` is cleared when a connection is set up, so a
relog cannot inherit the previous session's correction.

## Verification

Same world, same twelve clicked moves, before and after, with the numbers read
out of the running client:

| | before | after |
|---|---|---|
| `ping.value` | -10048, growing | 37, 33, 33 ms |
| `serverTick` vs the server's own tick | 5,024 ms behind | within half a round trip |
| `rawElapsed` per move | -40379 | 16 to 20 ms |
| walks fast-forwarded | 0 of 12 | 16 of 16 |

Path durations in that run were 450 to 1,900 ms, so the correction is now a
1-4% nudge that does what it was written to do, instead of either nothing at
all or a teleport to the end of the path.

**What this does not prove.** The symptom has not been reproduced on a machine
that shows it; this is the mechanism found by reading and then measured. It
explains the reported shape and the device-dependence, and both defects are
real and worth fixing regardless. Verification on a machine that actually
rubber-bands is still outstanding — [#87](../../../issues/87)'s Steam Deck is
the next instrument for that.

## Upstream

Both defects are roBrowserLegacy's, not ours, and neither is specific to how
this app runs it. Worth sending upstream.
