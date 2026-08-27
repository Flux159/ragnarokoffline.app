'use strict';
//
// Sign the payload binaries before electron-builder signs the app around them.
//
// `nebula` and `nebulad` create the microVM and need
// com.apple.security.virtualization and .hypervisor. Those entitlements have
// to be on the binary that calls Virtualization.framework -- putting them on
// the app around it does nothing and the VM refuses to start.
//
// This used to run in afterSign, which was wrong in a way that only showed up
// on a user's machine. electron-builder's order is: sign the app, notarise it,
// *then* call afterSign. Re-signing anything at that point invalidates the
// notarisation ticket that was just issued, and the shipped app is refused
// with "Unnotarized Developer ID" despite the build log saying notarisation
// succeeded.
//
// afterPack runs before any signing, so the sidecars are signed first, the
// app's own signature seals them by hash, and notarisation is the last thing
// that touches the bundle.
//
// The payload binaries are excluded from electron-builder's own signing (see
// mac.signIgnore in package.json), because it would re-sign them with the
// app's entitlements and drop the virtualization ones.
//
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
	if (context.electronPlatformName !== 'darwin') return;

	const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
	const bin = path.join(appPath, 'Contents/Resources/payload/bin');
	if (!fs.existsSync(bin)) {
		throw new Error(`afterPack: no payload/bin in ${appPath}`);
	}
	const identity = process.env.RAGNAROKMAC_IDENTITY || findIdentity();
	if (!identity) {
		console.log('  afterPack: no Developer ID found, leaving payload binaries unsigned');
		return;
	}

	const vz = path.join(__dirname, '..', 'config', 'entitlements.plist');
	const app = path.join(__dirname, 'entitlements.mac.plist');

	// Everything in payload/bin, because electron-builder will sign none of it
	// and notarisation rejects a bundle containing unsigned Mach-O.
	for (const name of fs.readdirSync(bin)) {
		const target = path.join(bin, name);
		if (!fs.statSync(target).isFile()) continue;
		if (name.endsWith('.sha256')) continue;
		const needsVZ = name === 'nebula' || name === 'nebulad';
		execFileSync('codesign', [
			'--force', '--sign', identity,
			'--options', 'runtime', '--timestamp',
			'--entitlements', needsVZ ? vz : app,
			target,
		], { stdio: 'inherit' });
	}

	// Assert the thing this file exists for, rather than trusting it: a
	// bundle that ships without the entitlement installs fine and cannot
	// start a VM, which looks nothing like a signing fault.
	const ents = execFileSync('codesign', ['-d', '--entitlements', '-', path.join(bin, 'nebulad')], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
	});
	if (!/virtualization/i.test(ents)) {
		throw new Error('afterPack: nebulad did not get its virtualization entitlement');
	}
	console.log('  afterPack: payload binaries signed, entitlements verified');
};

function findIdentity() {
	try {
		const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
		const m = out.split('\n').find(l => l.includes('Developer ID Application'));
		return m ? m.match(/"(.*)"/)[1] : null;
	} catch {
		return null;
	}
}
