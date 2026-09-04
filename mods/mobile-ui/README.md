# mobile-ui

Ships with the app and is on by default. It is also the shortest complete
example of the `client/` layer, so it is worth reading even if you never touch
a phone.

## What it does

On a touch device with a screen under 900 points on its short side:

- sets a real `viewport` meta, so the browser stops pretending to be 980px wide
  and scaling the whole canvas down to fit
- stops the page from panning, pinch-zooming and text-selecting under a drag,
  which is otherwise what a swipe does instead of moving your character
- brings buttons up to a 44px touch target
- sets login inputs to 16px, because iOS Safari zooms the page when it focuses
  anything smaller and does not zoom back out
- keeps the game clear of the notch and the home indicator

On a desktop it does nothing at all.

## What to look at first

`client/index.js`, and specifically two things:

**The default export is a function.** The plugin manager `import()`s the file
and calls `module.default(params)`. A plugin written as `define(function(){…})`
— the form older roBrowser plugins use, and the form this mod itself used until
0.2.0 — throws on import, gets caught, and is reported to a console that the
client has muted. It loads, it does nothing, and nothing says so.

**Shadow roots need the stylesheet handed to them.** Every roBrowser window is
a custom element with its own shadow root, and a `<style>` in the document head
does not cross that boundary. The plugin builds one `CSSStyleSheet` and adopts
it into each shadow root as it appears, with a `MutationObserver` to catch the
windows created later. This is the part to copy if you want to restyle the
interface rather than the page.

## Related

Issue [#6](https://github.com/Flux159/ragnarokoffline.app/issues/6) also asks
for WASD movement and controller support. Keyboard movement is already built
into the client (`patches/KeyboardMove.js`); a controller mod would be another
`client/` plugin, and would start from the same two facts above.
