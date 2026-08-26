'use strict';
//
// electron-builder signs everything it finds with the app's entitlements, which
// is wrong for two of our sidecars: `nebula` and `nebulad` create the microVM
// and need com.apple.security.virtualization and .hypervisor. Those entitlements
// have to be on the binary that calls Virtualization.framework — putting them on
// the app around it does nothing and the VM simply refuses to start.
//
// So we re-sign those two afterwards, and then re-seal the bundle: sealing
// hashes what is inside it, so anything signed after the seal invalidates it.
// That ordering is the whole reason this file exists rather than a config key.
//
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

exports.default = async function afterSign(context) {
	if (context.electronPlatformName !== 'darwin') return;

	const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
	const identity = process.env.RAGNAROKMAC_IDENTITY || findIdentity();
	if (!identity) {
		console.log('  afterSign: no Developer ID found, leaving signatures as-is');
		return;
	}

	const vzEntitlements = path.join(__dirname, '..', 'config', 'entitlements.plist');
	const bin = path.join(appPath, 'Contents/Resources/payload/bin');

	for (const name of ['nebula', 'nebulad']) {
		const target = path.join(bin, name);
		if (!fs.existsSync(target)) {
			throw new Error(`afterSign: ${name} missing from the bundle`);
		}
		execFileSync('codesign', [
			'--force', '--sign', identity,
			'--options', 'runtime', '--timestamp',
			'--entitlements', vzEntitlements,
			target,
		], { stdio: 'inherit' });
	}

	// Re-seal, now that the inner binaries changed.
	execFileSync('codesign', [
		'--force', '--sign', identity,
		'--options', 'runtime', '--timestamp',
		'--entitlements', path.join(__dirname, 'entitlements.mac.plist'),
		appPath,
	], { stdio: 'inherit' });

	// Verify rather than assume: a broken seal only shows up on another machine,
	// as "damaged and can't be opened", which looks nothing like a signing fault.
	execFileSync('codesign', ['--verify', '--strict', appPath], { stdio: 'inherit' });
	const ents = execFileSync('codesign', ['-d', '--entitlements', '-', path.join(bin, 'nebulad')], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'ignore'],
	});
	if (!/virtualization/i.test(ents)) {
		throw new Error('afterSign: nebulad lost its virtualization entitlement');
	}
	console.log('  afterSign: sidecars signed, bundle re-sealed, entitlements verified');
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
