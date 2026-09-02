/**
 * A roBrowser plugin: proof that a mod can restyle the client.
 *
 * The game is a canvas, so this cannot reflow the UI the way a web page would.
 * What it can do is stop a phone from rendering a desktop-sized layout into a
 * 400 point wide screen -- which is most of what makes it unplayable -- and
 * make the touch targets big enough to hit.
 *
 * Loaded by name from Config.local.js, which `stack link-assets` generates from
 * whichever mods are installed.
 */
define(function () {
	'use strict';

	function isSmallScreen() {
		return Math.min(window.screen.width, window.screen.height) <= 820
			|| /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
	}

	return {
		init: function () {
			if (!isSmallScreen()) {
				return;
			}

			// Without this a phone reports a 980px viewport and scales the whole
			// canvas down to fit it, which is why the game reads as unusably
			// small before anything else is wrong.
			var meta = document.querySelector('meta[name=viewport]')
				|| document.head.appendChild(document.createElement('meta'));
			meta.name = 'viewport';
			meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, '
				+ 'user-scalable=no, viewport-fit=cover';

			var css = document.createElement('style');
			css.textContent = [
				/* The chat box takes a third of a phone screen at desktop size. */
				'#chat, .chat { font-size: 15px !important; }',
				/* Buttons sized for a mouse are below the 44px touch target. */
				'.btn, button, .ui button { min-width: 44px !important;',
				'  min-height: 44px !important; }',
				/* Stop a stray drag from selecting the UI instead of moving. */
				'body { -webkit-user-select: none; user-select: none;',
				'  -webkit-touch-callout: none; overscroll-behavior: none; }',
				/* Keep the canvas clear of the notch and the home indicator. */
				'#robrowser, canvas { padding: env(safe-area-inset-top) 0',
				'  env(safe-area-inset-bottom) 0; }',
			].join('\n');
			document.head.appendChild(css);

			console.log('[mobile-ui] small screen: viewport and touch targets adjusted');
		},
	};
});
