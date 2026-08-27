/**
 * roBrowser overrides for Ragnarok Offline.
 *
 * api.html merges ROConfigBase (Config.js) with this, so it is the supported
 * way to configure the client without patching the build. Loaded directly as
 * a page rather than through an iframe: TYPE.FRAME nests the game in a second
 * browsing context, which swallows keyboard focus (no chat input, no movement
 * keys) for no benefit when the game already owns the whole window.
 */
window.ROConfigLocal = {
	// Client bundle, GRF assets and the game socket all come from our asset
	// server on :3338, so everything is same-origin.
	remoteClient: '/',
	servers: [
		{
			display: 'Ragnarok Offline',
			desc: 'local rAthena',
			// Whoever served this page is the server to play on.
			//
			// Hardcoding 127.0.0.1 works only when the player and the server
			// are the same machine. A joining player downloads this file from
			// the host and would then connect to their own loopback, finding
			// nothing -- and the proxy would refuse the target anyway, since
			// its allow-list carries the host's addresses, not the guest's.
			// location is the one thing that is always correct for both.
			address: location.hostname,
			port: 6900,
			version: 55,
			// windows-949, not windows-1252. langtype picks the text codepage,
			// and 12 (Brazil) renders every string the English overlay does not
			// cover as mojibake ("¼¼»òÀ»"). 949 is ASCII-compatible, so English
			// is untouched and leftover Korean renders as actual Korean.
			langtype: 0,
			packetver: 20221005,
			renewal: true,
			worldMapSettings: { episode: 20 },
			packetKeys: false,
			// location.host, so the port comes along: the proxy is the same
			// origin that served the page.
			socketProxy: 'ws://' + location.host + '/ws/',
			remoteClient: '/',
			adminList: [2000000]
		}
	],
	skipServerList: true,
	skipIntro: true,
	// Without this roBrowser never reads the item, robe, accessory and NPC
	// name tables at all.
	loadLua: true,
	BGMFileExtension: ['mp3']
};
