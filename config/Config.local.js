/**
 * roBrowser overrides for RagnarokMac.
 *
 * api.html merges ROConfigBase (Config.js) with this, so it is the supported
 * way to configure the client without patching the build. Loaded directly as
 * a page rather than through an iframe: TYPE.FRAME nests the game in a second
 * browsing context, which swallows keyboard focus (no chat input, no movement
 * keys) for no benefit when the game already owns the whole window.
 */
window.ROConfigLocal = {
	// Client bundle, GRF assets and the game socket all come from the
	// RemoteClient-JS unified server on :3338, so everything is same-origin.
	remoteClient: '/',
	servers: [
		{
			display: 'Ragnarok Offline',
			desc: 'local rAthena',
			address: '127.0.0.1',
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
			socketProxy: 'ws://127.0.0.1:3338/ws/',
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
