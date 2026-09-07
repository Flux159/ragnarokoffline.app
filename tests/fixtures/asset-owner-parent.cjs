'use strict';
const { AssetServer } = require('../../electron/asset-server');
const server = new AssetServer();
process.on('message', async options => {
	try { process.send({ identity: await server.start(options) }); }
	catch (error) { process.send({ error: error.message }); }
});
