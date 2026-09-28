'use strict';
//
// Sign one Windows binary with Azure Artifact Signing.
//
// electron-builder calls this for every .exe it produces or copies: the app,
// each payload binary under resources/payload/bin, the uninstaller and the
// installer, in that order, so what the installer carries is already signed.
//
// Why a hook and not electron-builder's own `win.azureSignOptions`: that path
// refuses to start without AZURE_CLIENT_SECRET (or a certificate) in the
// environment. We keep no secret. The workflow's `release` environment lets
// this job mint a GitHub OIDC token, and Azure trusts that token -- and only
// from that environment -- through a federated credential on the
// `github-codesigning` app registration. So a leaked log or a hostile pull
// request has nothing to steal.
//
// The token is fetched here, per file, rather than once by azure/login before
// the build: a GitHub OIDC token is good for minutes, the build takes longer
// than that, and a login cached at the start has expired by the time the
// installer is signed.
//
// Without the Azure variables (manual runs, forks, local builds) this signs
// nothing and says so, and the build carries on unsigned. With them, any
// failure fails the build: a release that was meant to be signed and is not
// should never be published.
//
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REQUIRED = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_SIGNING_ENDPOINT', 'AZURE_SIGNING_ACCOUNT', 'AZURE_SIGNING_PROFILE'];

let warned = false;

async function federatedTokenFile() {
	const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
	const bearer = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
	if (!url || !bearer) {
		throw new Error('sign-win: Azure signing is configured but this job cannot mint an OIDC token (permissions: id-token: write)');
	}
	const res = await fetch(`${url}&audience=${encodeURIComponent('api://AzureADTokenExchange')}`, {
		headers: { Authorization: `Bearer ${bearer}` },
	});
	if (!res.ok) throw new Error(`sign-win: OIDC token request failed: HTTP ${res.status}`);
	const { value } = await res.json();
	const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oidc-')), 'token');
	fs.writeFileSync(file, value, { mode: 0o600 });
	return file;
}

// Values go in through the environment, not the command line, so a path with
// a space in it ("Ragnarok Offline.exe") needs no quoting.
const SIGN = `
$ErrorActionPreference = 'Stop'
$file = $env:SIGN_FILE
# Something someone else already signed -- Microsoft's, say -- keeps its own
# signature rather than having ours replace it.
if ((Get-AuthenticodeSignature -LiteralPath $file).Status -eq 'Valid') {
	Write-Host "  already signed: $file"
	exit 0
}
Import-Module ArtifactSigning
$params = @{
	Endpoint               = $env:AZURE_SIGNING_ENDPOINT
	CodeSigningAccountName = $env:AZURE_SIGNING_ACCOUNT
	CertificateProfileName = $env:AZURE_SIGNING_PROFILE
	Files                  = $file
	FileDigest             = 'SHA256'
	TimestampRfc3161       = 'http://timestamp.acs.microsoft.com'
	TimestampDigest        = 'SHA256'
}
Invoke-ArtifactSigning @params
$sig = Get-AuthenticodeSignature -LiteralPath $file
if ($sig.Status -ne 'Valid' -or -not $sig.TimeStamperCertificate) {
	throw "not validly signed and timestamped after signing: $file ($($sig.Status))"
}
Write-Host "  signed: $file -- $($sig.SignerCertificate.Subject)"
`;

exports.default = async function sign(configuration) {
	const missing = REQUIRED.filter(name => !process.env[name]);
	if (missing.length) {
		if (!warned) {
			console.log(`  sign-win: Azure signing not configured (${missing.join(', ')} unset), leaving Windows binaries unsigned`);
			warned = true;
		}
		return;
	}

	const tokenFile = await federatedTokenFile();
	try {
		execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', SIGN], {
			stdio: 'inherit',
			env: {
				...process.env,
				SIGN_FILE: configuration.path,
				// Read by the WorkloadIdentityCredential that Invoke-ArtifactSigning's
				// credential chain tries second, with AZURE_TENANT_ID and
				// AZURE_CLIENT_ID. There is no secret for the first one to find.
				AZURE_FEDERATED_TOKEN_FILE: tokenFile,
			},
		});
	} finally {
		fs.rmSync(path.dirname(tokenFile), { recursive: true, force: true });
	}
};
