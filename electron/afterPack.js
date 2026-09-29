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
	const vz = path.join(__dirname, '..', 'config', 'entitlements.plist');
	const app = path.join(__dirname, 'entitlements.mac.plist');

	// No Developer ID -- a fork's CI, or a Mac without the certificate.
	// electron-builder will then sign nothing, and an unsigned build is worse
	// than it sounds: Electron's binary arrives linker-signed, packing changes
	// the resources that signature seals, and Apple Silicon reports the result
	// as "damaged" with no way past it. So seal it ad hoc instead. It is not
	// notarisable and Gatekeeper still asks, but it opens, and nebulad keeps
	// the entitlement it needs to start a VM.
	//
	// Inside out: --deep first for the frameworks and helpers, then the payload
	// with its own entitlements (--deep gave it the app's), then the app once
	// more so its seal covers the payload as it now is. No hardened runtime:
	// with no team id, library validation would refuse Electron's frameworks.
	if (!identity) {
		console.log('  afterPack: no Developer ID found, signing ad hoc');
		execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
		signPayload(bin, target => ['--force', '--sign', '-', '--entitlements', entitlementsFor(target, vz, app), target]);
		execFileSync('codesign', ['--force', '--sign', '-', '--entitlements', app, appPath], { stdio: 'inherit' });
	} else {
		// Everything in payload/bin, because electron-builder will sign none of
		// it and notarisation rejects a bundle containing unsigned Mach-O.
		signPayload(bin, target => [
			'--force', '--sign', identity,
			'--options', 'runtime', '--timestamp',
			'--entitlements', entitlementsFor(target, vz, app),
			target,
		]);
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

function signPayload(bin, args) {
	for (const name of fs.readdirSync(bin)) {
		const target = path.join(bin, name);
		if (!fs.statSync(target).isFile()) continue;
		if (name.endsWith('.sha256') || name.endsWith('.source-commit')) continue;
		execFileSync('codesign', args(target), { stdio: 'inherit' });
	}
}

function entitlementsFor(target, vz, app) {
	const name = path.basename(target);
	return name === 'nebula' || name === 'nebulad' ? vz : app;
}

function findIdentity() {
	try {
		const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
		const m = out.split('\n').find(l => l.includes('Developer ID Application'));
		return m ? m.match(/"(.*)"/)[1] : null;
	} catch {
		return null;
	}
}
