/**
 * mobile-ui -- make the client usable on a phone.
 *
 * A roBrowser plugin, and the shape of every one: an ES module whose *default
 * export is a function*. The plugin manager `import()`s this file, calls that
 * function once with whatever parameters the config passed, and takes a truthy
 * return as "loaded". An older generation of roBrowser plugins wrapped
 * themselves in `define(...)` instead; those load and do nothing at all here,
 * with the error swallowed by the console manager. If a plugin seems inert,
 * that is the first thing to check.
 *
 * The game is a canvas, so this cannot reflow the interface the way a web page
 * would. What it can do is the handful of things that stand between a phone
 * and a playable window, and nothing on a desktop.
 *
 * Loaded by name from Config.local.js, which `stack link-assets` generates
 * from whichever mods are installed. Files beside this one are served from
 * `plugins/mobile-ui/`.
 */

/** Is this a screen worth changing anything for? */
function isHandheld() {
	// Both halves matter. A phone in landscape is 844 points wide and would
	// pass a width test; a desktop browser window dragged narrow would fail
	// one. The touch check is what separates them.
	const smallSide = Math.min(window.screen.width, window.screen.height);
	const touch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
	return touch && smallSide <= 900;
}

const CSS = `
	/* Without this the canvas is dragged around instead of the character, and
	   a two-finger pinch zooms the page rather than the camera. */
	html, body {
		overscroll-behavior: none;
		touch-action: none;
		-webkit-user-select: none;
		user-select: none;
		-webkit-touch-callout: none;
		-webkit-tap-highlight-color: transparent;
	}

	/* Chat is sized for a monitor an arm's length away. */
	#chat, .chat, .chatbox, #ChatBox { font-size: 15px !important; }

	/* Anything clickable, brought up to the 44px that a thumb can actually
	   hit. Scoped to buttons so it cannot stretch a layout table. */
	button, .btn, .ui button, [role="button"] {
		min-width: 44px !important;
		min-height: 44px !important;
	}

	/* The login form is the first thing a phone sees, and its inputs are
	   16px-or-larger here for a specific reason: iOS Safari zooms the whole
	   page when it focuses an input with a smaller font, and never zooms back
	   out. */
	input[type="text"], input[type="password"] {
		font-size: 16px !important;
		min-height: 40px !important;
	}

	/* Keep the game clear of the notch and the home indicator. */
	body {
		padding: env(safe-area-inset-top) env(safe-area-inset-right)
		         env(safe-area-inset-bottom) env(safe-area-inset-left);
		box-sizing: border-box;
	}
`;

export default function mobileUI() {
	if (!isHandheld()) {
		// Returning true either way: the plugin ran and decided there was
		// nothing to do, which is a success. Returning false would print
		// "Failed to initialize plugin" on every desktop.
		return true;
	}

	// Without this a phone reports a 980px viewport and scales the whole canvas
	// down to fit it, which is most of what makes the game read as unusably
	// small before anything else is wrong.
	const meta = document.querySelector('meta[name=viewport]')
		|| document.head.appendChild(document.createElement('meta'));
	meta.name = 'viewport';
	meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, '
		+ 'user-scalable=no, viewport-fit=cover';

	const style = document.createElement('style');
	style.id = 'mobile-ui';
	style.textContent = CSS;
	document.head.appendChild(style);

	// roBrowser's own components live in shadow roots, so a stylesheet in the
	// document head does not reach them. Adopting the same sheet into each one
	// as it appears is the only way in from outside the bundle.
	//
	// The observer is left running: windows are created and destroyed for the
	// life of the session, not once at startup.
	const sheet = new CSSStyleSheet();
	sheet.replaceSync(CSS);
	const adopt = (root) => {
		if (root.adoptedStyleSheets && !root.adoptedStyleSheets.includes(sheet)) {
			root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
		}
	};
	const sweep = () => {
		document.querySelectorAll('*').forEach((el) => {
			if (el.shadowRoot) adopt(el.shadowRoot);
		});
	};
	sweep();
	new MutationObserver(sweep).observe(document.documentElement, {
		childList: true,
		subtree: true,
	});

	return true;
}
