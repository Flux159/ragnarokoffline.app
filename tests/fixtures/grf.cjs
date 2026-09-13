'use strict';
const { deflateSync } = require('node:zlib');

// One tiny synthetic GRF 0x200 entry. No game artwork or external assets.
module.exports = function grf(name = 'data\\fixture.txt', content = Buffer.from('synthetic archive bytes')) {
	const body = deflateSync(content);
	const entry = Buffer.alloc(17);
	entry.writeUInt32LE(body.length, 0);
	entry.writeUInt32LE(body.length, 4);
	entry.writeUInt32LE(content.length, 8);
	entry[12] = 1;
	const table = Buffer.concat([Buffer.from(name + '\0'), entry]);
	const compressed = deflateSync(table);
	const header = Buffer.alloc(46);
	header.write('Master of Magic');
	header.writeUInt32LE(body.length, 30);
	header.writeUInt32LE(8, 38);
	header.writeUInt32LE(0x200, 42);
	const lengths = Buffer.alloc(8);
	lengths.writeUInt32LE(compressed.length, 0);
	lengths.writeUInt32LE(table.length, 4);
	return Buffer.concat([header, body, lengths, compressed]);
};
