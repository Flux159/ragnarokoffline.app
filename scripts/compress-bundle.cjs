/**
 * Shrink the built client for the wire.
 *
 *   node scripts/compress-bundle.cjs [--precompress-only] <dist/Web directory>
 *
 * roBrowserLegacy builds Online.js unminified (13 MB), and the asset server
 * gzips it at level 1 on every request, to about 3.2 MB. A friend on a slow
 * link waits for all of it before the login window appears. This runs after
 * patch-bundle.sh's edits, which need the unminified source:
 *
 * - minifies the scripts the game page loads with terser: whitespace,
 *   comments and local names only. compress is off and function and class
 *   names are kept, because the client keys effects and logs packets by
 *   `constructor.name`.
 * - writes a `.br` (brotli, quality 11) and a `.gz` (gzip -9) beside each
 *   compressible file it serves, which the Rust server sends instead of
 *   compressing on the fly when the browser accepts them. Each is written
 *   after its source, so its newer mtime marks it fresh; the server ignores
 *   one older than the file it stands for.
 *
 * terser comes from roBrowserLegacy's own devDependencies, so there is
 * nothing to install here.
 *
 * --precompress-only rewrites just the .br/.gz copies. package.sh runs it
 * after copying the client into the payload: a copy, or a CI artifact, does
 * not keep mtimes, and a sibling that lands older than its file is ignored.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const args = process.argv.slice(2);
const precompressOnly = args[0] === '--precompress-only';
const web = args[precompressOnly ? 1 : 0] ? path.resolve(args[precompressOnly ? 1 : 0]) : null;
if (!web || !fs.existsSync(path.join(web, 'Online.js'))) {
  throw Error('Usage: node compress-bundle.cjs [--precompress-only] <dist/Web directory containing Online.js>');
}

const MINIFY = ['Online.js', 'ThreadEventHandler.js', 'PathFindingWorker.js'];
const COMPRESS = /\.(js|mjs|html|css|json|svg|wasm|webmanifest)$/;
// Rewritten while the app runs, so a precompressed copy would only go stale;
// and the viewer bundles, which every build path prunes after this runs.
const SKIP = new Set(['Config.local.js', 'endpoint.json', 'GrfViewer.js', 'MapViewer.js', 'ModelViewer.js',
  'StrViewer.js', 'EffectViewer.js', 'GrannyModelViewer.js']);

async function main() {
  if (!precompressOnly) await minifyScripts();
  precompress();
}

async function minifyScripts() {
  const vendor = path.join(__dirname, '..', 'vendor', 'roBrowserLegacy');
  const { minify } = require(require.resolve('terser', { paths: [web, vendor] }));
  for (const name of MINIFY) {
    const file = path.join(web, name);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const result = await minify(source, {
      module: true,
      compress: false,
      mangle: true,
      keep_classnames: true,
      keep_fnames: true,
      format: { comments: false },
    });
    fs.writeFileSync(file, result.code);
    console.log(`minified ${name}: ${mb(Buffer.byteLength(source))} -> ${mb(Buffer.byteLength(result.code))}`);
  }
}

function precompress() {
  for (const name of fs.readdirSync(web)) {
    const file = path.join(web, name);
    if (!COMPRESS.test(name) || SKIP.has(name) || !fs.statSync(file).isFile()) continue;
    const data = fs.readFileSync(file);
    if (data.length < 1024) continue;
    const br = zlib.brotliCompressSync(data, { params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    } });
    const gz = zlib.gzipSync(data, { level: 9 });
    fs.writeFileSync(file + '.br', br);
    fs.writeFileSync(file + '.gz', gz);
    if (data.length > 256 * 1024) console.log(`compressed ${name}: ${mb(data.length)}, br ${mb(br.length)}, gz ${mb(gz.length)}`);
  }
}

const mb = n => (n / 1048576).toFixed(2) + ' MB';
main().catch(err => { console.error(err); process.exit(1); });
