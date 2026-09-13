/**
 * Add the complete legacy navigation UI and ground route renderer to the
 * pinned roBrowserLegacy Online bundle.
 *
 * Every edit requires one exact source signature. An upstream change therefore
 * stops the patch before the output file is written instead of producing a
 * partially modified client.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PATCH_MARKER = 'function getNavigationFallbackPath(mapName)';
const input = process.argv[2] ? path.resolve(process.argv[2]) : null;
const output = process.argv[3] ? path.resolve(process.argv[3]) : null;

if (!input || !output) {
  throw Error('Usage: node patch-navigation-client.cjs <input Online.js> <output Online.js>');
}
if (input === output) throw Error('Input and output must be different files.');
if (!fs.existsSync(input)) throw Error('Input file not found: ' + input);

const original = fs.readFileSync(input, 'utf8');
if (original.includes(PATCH_MARKER)) {
  throw Error('This Online.js already contains the navigation patch.');
}
let patched = original;
for (const name of ['NaviMapTable','NaviMobTable','NaviNpcTable','NaviLinkTable','NaviLinkDistanceTable','NaviNpcDistanceTable']) {
  const needle = name + ' = {};';
  if (patched.split(needle).length !== 2) throw Error('Unexpected initialization: ' + name);
  patched = patched.replace(needle, name + ' = [];');
}
const start = patched.indexOf('function loadLuaValue(');
const stop = patched.indexOf('\n/**', start);
let loader = patched.slice(start, stop);
const escapePattern = /local function escape_str\(str\)\s+return str:gsub[^\n]+\s+end/;
if (!escapePattern.test(loader)) throw Error('Escape function not found');
loader = loader.replace(escapePattern, () => String.raw`local function escape_str(str)
                                return (str:gsub('[%z\1-\31\\"]', function(c)
                                    return string.format('\\u%04x', string.byte(c))
                                end))
                            end`);
const arrayPattern = /local is_array = true\s+local index = 1\s+for k, _ in pairs\(value\) do[\s\S]*?index = index \+ 1\s+end/;
if (!arrayPattern.test(loader)) throw Error('Array detection not found');
loader = loader.replace(arrayPattern, `local is_array = true
                                    local count, highest = 0, 0
                                    for k, _ in pairs(value) do
                                        if type(k) ~= "number" or k < 1 or k % 1 ~= 0 then
                                            is_array = false
                                            break
                                        end
                                        count = count + 1
                                        highest = math.max(highest, k)
                                    end
                                    is_array = is_array and count == highest`);
const decodeNeedle = 'result = JSON.parse(userStringDecoder.decode(value));';
if (loader.split(decodeNeedle).length !== 2) throw Error('Navigation JSON decode call not found');
loader = loader.replace(decodeNeedle, 'result = JSON.parse(userStringDecoder.decode(value, userCharpage));');
patched = patched.slice(0,start) + loader + patched.slice(stop);

const classicNavigationHtml = String.raw`<div class="Navigation">
	<div class="titlebar">
		<div class="left" data-background="basic_interface/titlebar_left.bmp"></div>
		<div class="center" data-background="basic_interface/titlebar_mid.bmp"></div>
		<div class="right" data-background="basic_interface/titlebar_right.bmp"></div>
		<div class="title">Navigation</div>
		<ui-button class="close" bg="navigation_interface3/btn_close_normal.bmp" hover="navigation_interface3/btn_close_over.bmp" down="navigation_interface3/btn_close_press.bmp"></ui-button>
	</div>
	<div class="content">
		<div class="search-container">
			<div class="search-type-frame" data-background="navigation_interface3/bg_combo.bmp">
				<select class="search-type"><option value="ALL">All</option><option value="NPC">NPC</option><option value="MOB">MOB</option></select>
			</div>
			<div class="search-field"><input type="text" class="search-input" /></div>
			<ui-button class="search-button" bg="navigation_interface3/btn_searchbar_normal.bmp" hover="navigation_interface3/btn_searchbar_over.bmp" down="navigation_interface3/btn_searchbar_press.bmp"></ui-button>
		</div>
		<div class="search-caption">Search result[<span class="search-count">0</span>]</div>
		<div class="search-workspace">
			<div class="search-results"></div>
			<div class="detail-pane">
				<div class="detail-name">Select a result</div>
				<div class="detail-summary">
					<canvas class="entity-preview" width="120" height="150"></canvas>
					<div class="detail-summary-data">
						<div class="detail-map-preview"><span class="detail-map-pin"></span></div>
						<div class="detail-coordinates"></div>
						<div class="detail-stats"></div>
					</div>
				</div>
				<div class="location-table">
					<div class="location-columns"><span>Map</span><span>Coordinates</span><span>Frequency</span></div>
					<div class="location-list"></div>
				</div>
			</div>
		</div>
		<div class="search-actions">
			<ui-button class="share-result disabled" disabled bg="navigation_interface3/btn_share_normal.bmp" hover="navigation_interface3/btn_share_over.bmp" down="navigation_interface3/btn_share_press.bmp" title="Not supported by this client"></ui-button>
			<ui-button class="find-result disabled" disabled bg="navigation_interface3/btn_find_normal.bmp" hover="navigation_interface3/btn_find_over.bmp" down="navigation_interface3/btn_find_press.bmp"></ui-button>
		</div>
		<div class="map-container">
			<div class="map-header"><div class="location-title"></div></div>
			<div class="services-toggle-container"><label><input type="checkbox" class="services-toggle" /> Services</label></div>
			<div class="map-display"></div>
			<button class="move-button" disabled>✣ MOVE</button>
		</div>
	</div>
	<div class="footer">
		<label class="minimize-label"><input type="checkbox" class="minimize-toggle" /> Minimize</label>
		<div class="coordinates-bar"><div class="map-name"></div><div class="mouse-info"><span class="mouse-label">Mouse:</span><span class="mouse-coordinates"></span></div><div class="target-info"><span class="target-label">Target:</span><span class="target-coordinates"></span></div></div>
		<ui-button class="marker-menu-button" bg="navigation_interface3/btn_roadiocn_select1_normal.bmp" hover="navigation_interface3/btn_roadiocn_select1_over.bmp" down="navigation_interface3/btn_roadiocn_select1_press.bmp" title="Path marker"></ui-button>
		<div class="marker-palette">
			<ui-button data-style="1" bg="navigation_interface3/btn_roadiocn_select1_normal.bmp" hover="navigation_interface3/btn_roadiocn_select1_over.bmp" down="navigation_interface3/btn_roadiocn_select1_press.bmp"></ui-button>
			<ui-button data-style="2" bg="navigation_interface3/btn_roadiocn_select2_normal.bmp" hover="navigation_interface3/btn_roadiocn_select2_over.bmp" down="navigation_interface3/btn_roadiocn_select2_press.bmp"></ui-button>
			<ui-button data-style="3" bg="navigation_interface3/btn_roadiocn_select3_normal.bmp" hover="navigation_interface3/btn_roadiocn_select3_over.bmp" down="navigation_interface3/btn_roadiocn_select3_press.bmp"></ui-button>
			<ui-button data-style="4" bg="navigation_interface3/btn_roadiocn_select4_normal.bmp" hover="navigation_interface3/btn_roadiocn_select4_over.bmp" down="navigation_interface3/btn_roadiocn_select4_press.bmp"></ui-button>
			<ui-button data-style="5" bg="navigation_interface3/btn_roadiocn_select5_normal.bmp" hover="navigation_interface3/btn_roadiocn_select5_over.bmp" down="navigation_interface3/btn_roadiocn_select5_press.bmp"></ui-button>
			<ui-button data-style="6" bg="navigation_interface3/btn_roadiocn_select6_normal.bmp" hover="navigation_interface3/btn_roadiocn_select6_over.bmp" down="navigation_interface3/btn_roadiocn_select6_press.bmp"></ui-button>
			<ui-button data-style="7" bg="navigation_interface3/btn_roadiocn_select7_normal.bmp" hover="navigation_interface3/btn_roadiocn_select7_over.bmp" down="navigation_interface3/btn_roadiocn_select7_press.bmp"></ui-button>
			<ui-button data-style="8" bg="navigation_interface3/btn_roadiocn_select8_normal.bmp" hover="navigation_interface3/btn_roadiocn_select8_over.bmp" down="navigation_interface3/btn_roadiocn_select8_press.bmp"></ui-button>
		</div>
	</div>
</div>`;

const classicNavigationCss = String.raw`:host { top: 120px; left: 120px; width: 390px; height: 430px; font-family: Arial, sans-serif; font-size: 11px; }
.Navigation { width: 390px; height: 430px; color: #333; position: relative; }
.Navigation .titlebar { position: relative; width: 390px; height: 17px; cursor: move; }
.Navigation .titlebar .left { position:absolute; left:0; top:0; width:15px; height:17px; }
.Navigation .titlebar .center { position:absolute; left:12px; right:12px; top:0; height:17px; background-repeat:repeat-x; }
.Navigation .titlebar .right { position:absolute; right:0; top:0; width:12px; height:17px; }
.Navigation .titlebar .title { position:absolute; left:8px; top:1px; color:#333; text-shadow:1px 1px #fff; }
.Navigation .titlebar .close { position:absolute; right:2px; top:1px; width:14px; height:14px; z-index:3; }
.Navigation .content { position:absolute; top:17px; left:0; width:390px; height:389px; box-sizing:border-box; background:#f4f4f4; border-left:1px solid #aaa; border-right:1px solid #aaa; display:flex; flex-direction:column; }
.Navigation .search-container { height:24px; padding:3px 5px; display:flex; gap:3px; align-items:center; box-sizing:border-box; }
.Navigation .search-type-frame { width:43px; height:18px; position:relative; flex:none; box-sizing:border-box; border:1px solid #9c9c9c; background:#fff; }
.Navigation .search-type { position:absolute; inset:0; width:43px; height:18px; border:0; outline:0; padding:0 2px; font-size:10px; background:transparent; color:#333; }
.Navigation .search-field { height:18px; position:relative; flex:1; min-width:0; box-sizing:border-box; border:1px solid #9c9c9c; background:#fff; }
.Navigation .search-input { position:absolute; inset:1px 3px; width:calc(100% - 6px); height:16px; padding:0; border:0; outline:0; background:transparent; font-size:11px; }
.Navigation .search-button { width:25px; height:18px; flex:none; background-repeat:no-repeat; overflow:hidden; }
.Navigation .search-caption { height:18px; line-height:18px; padding:0 7px; border-bottom:1px solid #aaa; box-sizing:border-box; }
.Navigation .search-workspace { height:320px; display:flex; background:#fff; }
.Navigation .search-results { display:block; width:145px; height:320px; overflow-y:auto; overflow-x:hidden; border-right:1px solid #aaa; box-sizing:border-box; background:#fff; }
.Navigation .results-list { list-style:none; margin:0; padding:0; }
.Navigation .result-item { min-height:17px; padding:2px 3px; box-sizing:border-box; display:flex; align-items:flex-start; cursor:pointer; white-space:nowrap; }
.Navigation .result-item:hover, .Navigation .result-item.selected { background:#dcecff; }
.Navigation .result-type { width:11px; height:11px; margin:1px 3px 0 0; flex:none; font-size:0; background-repeat:no-repeat; }
.Navigation .result-name { overflow:hidden; text-overflow:ellipsis; }
.Navigation .result-map { display:none; }
.Navigation .no-results { padding:8px 4px; color:#777; }
.Navigation .result-count { flex:none; margin-right:3px; color:#555; }
.Navigation .detail-pane { width:243px; height:320px; position:relative; overflow:hidden; box-sizing:border-box; padding:4px; background:#fff; display:flex; flex-direction:column; }
.Navigation .detail-name { height:18px; color:#555; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:none; }
.Navigation .detail-summary { height:155px; display:flex; flex:none; border-bottom:1px solid #bbb; }
.Navigation .entity-preview { display:block; width:120px; height:150px; flex:none; pointer-events:none; }
.Navigation .detail-summary-data { flex:1; min-width:0; padding-left:3px; }
.Navigation .detail-map-preview { position:relative; width:105px; height:78px; margin:0 auto 2px; background:#111 center/contain no-repeat; border:1px solid #888; box-sizing:border-box; }
.Navigation .detail-map-pin { display:none; position:absolute; width:7px; height:7px; margin:-3px 0 0 -3px; border-radius:50%; background:#ffea00; border:1px solid #7c6200; box-shadow:0 0 2px #000; }
.Navigation .detail-coordinates { height:14px; text-align:center; color:#555; }
.Navigation .detail-stats { color:#4c4c93; line-height:13px; }
.Navigation .detail-stats .label { color:#555; }
.Navigation .location-table { flex:1; min-height:0; margin-right:-4px; padding-right:0; overflow-y:auto; overflow-x:hidden; scrollbar-gutter:stable; }
.Navigation .location-columns, .Navigation .location-row { display:grid; grid-template-columns:minmax(82px,1fr) 72px 70px; column-gap:3px; align-items:center; }
.Navigation .location-columns { height:18px; position:sticky; top:0; z-index:1; color:#666; border-bottom:1px solid #ccc; font-size:10px; background:#fff; }
.Navigation .location-list { min-height:0; overflow:visible; }
.Navigation .location-row { min-height:18px; padding:1px 2px; cursor:pointer; box-sizing:border-box; white-space:nowrap; }
.Navigation .location-row:hover, .Navigation .location-row.selected { background:#dcecff; }
.Navigation .location-row span { overflow:hidden; text-overflow:ellipsis; }
.Navigation .location-frequency { color:#4c4c93; }
.Navigation .search-actions { height:23px; padding:2px 7px 1px; display:flex; justify-content:center; gap:4px; box-sizing:border-box; background:#f4f4f4; }
.Navigation .search-actions ui-button { width:120px; height:20px; }
.Navigation .disabled { filter:grayscale(.55); opacity:.65; }
.Navigation .map-container { height:344px; display:none; flex-direction:column; align-items:center; padding:0 5px 4px; box-sizing:border-box; background:#f4f4f4; }
.Navigation .map-header { height:20px; width:100%; position:relative; display:flex; align-items:center; }
.Navigation .location-title { flex:1; text-align:center; font-weight:bold; height:18px; line-height:18px; }
.Navigation .services-toggle-container { position:absolute; left:7px; top:44px; z-index:2; }
.Navigation .map-display { width:364px; height:299px; position:relative; background:#000; border:1px solid #777; box-sizing:border-box; }
.Navigation .map-display canvas { width:100%; height:100%; display:block; }
.Navigation .move-button { width:364px; height:20px; margin-top:2px; border:1px solid #aaa; background:linear-gradient(#fff,#ddd); color:#777; font-size:11px; }
.Navigation .footer { position:absolute; left:0; bottom:0; width:390px; height:24px; z-index:5; box-sizing:border-box; border:1px solid #aaa; border-top-color:#ccc; background:linear-gradient(#fff,#ededed); }
.Navigation .minimize-label { position:absolute; left:5px; top:5px; font-size:10px; }
.Navigation .minimize-label input { width:10px; height:10px; margin:0 2px 0 0; vertical-align:-1px; }
.Navigation .coordinates-bar { display:none; }
.Navigation .marker-menu-button { position:absolute; right:4px; top:2px; width:26px; height:18px; background-repeat:no-repeat; overflow:hidden; }
.Navigation .marker-palette { display:none; position:absolute; right:3px; bottom:22px; width:126px; height:50px; z-index:20; box-sizing:border-box; border:1px solid #888; border-radius:2px; background:#f4f4f4; box-shadow:1px 1px 3px rgba(0,0,0,.4); }
.Navigation .marker-palette.open { display:grid; grid-template-columns:repeat(4,26px); grid-template-rows:repeat(2,18px); gap:4px; padding:4px; }
.Navigation .marker-palette ui-button { width:26px; height:18px; position:relative; z-index:1; }
.Navigation.minimized { height:41px; }
.Navigation.minimized .content { display:none; }
.Navigation.minimized .footer { bottom:0; }
`;

function replaceNavigationRawAssignment(variableName, value) {
	const assignment = `\t${variableName} = `;
	const assignmentStart = patched.indexOf(assignment);
	if (assignmentStart < 0) throw Error(variableName + ' assignment not found');
	const assignmentEnd = patched.indexOf(';\n}));', assignmentStart);
	if (assignmentEnd < 0) throw Error(variableName + ' assignment end not found');
	patched = patched.slice(0, assignmentStart) + assignment + JSON.stringify(value) + patched.slice(assignmentEnd);
}
replaceNavigationRawAssignment('Navigation_default$2', classicNavigationHtml);
replaceNavigationRawAssignment('Navigation_default$1', classicNavigationCss);

const navigationVarsNeedle = 'var Navigation, _arrow, _toolDealer, _weaponDealer, _armorDealer, _blacksmith, _guide, _inn, _kafra, _map, _ctx$2, _towninfo, _markers, _path, _lastPathUpdate, _pathUpdateThrottle, _pathUpdateLock, _pathFindingWorker, _mapData, _targetData, _finalTargetData, _isMapClickTarget, _blinking, _fadeInterval, _originalColor, _documentClickHandler, Navigation_default;';
if (patched.split(navigationVarsNeedle).length !== 2) throw Error('Navigation variable declaration not found');
const groundPathImplementation = String.raw`var _navigationGroundPathProgram = null;
var _navigationGroundPathBuffers = Array(8).fill(null);
var _navigationGroundPathTextures = Array(8).fill(null);
var _navigationGroundPathTexturesLoading = false;
var _navigationGroundPathTexturesReady = 0;
var _navigationTargetTextures = Array(4).fill(null);
var _navigationTargetTexturesLoading = false;
var _navigationTargetTexturesReady = 0;
var _navigationTargetBuffer = null;
var _navigationTargetSource = null;
var _navigationTargetVertices = new Float32Array(0);
var _selectedNavigationResult = null;
var _navigationPreviewModel = { entity: null, ctx: null, render: false };
function getNavigationFallbackPath(mapName) {
	const mapBaseName = String(mapName || "").replace(/\..*/, "");
	const mapInfo = DB.getNaviMapTable().find((row) => row && row[0] === mapBaseName);
	const isInterior = Number(mapInfo && mapInfo[2]) === 5003;
	return DB.INTERFACE_PATH + "navigation_interface/" + (isInterior ? "interior.bmp" : "noimage.bmp");
}
function loadNavigationFallback(mapName, callback) {
	Client.loadFile(getNavigationFallbackPath(mapName), (dataURI) => callback(dataURI || ""));
}
function renderNavigationEntityPreview() {
	if (!_navigationPreviewModel.render || !_navigationPreviewModel.entity || !_navigationPreviewModel.ctx) return;
	const ctx = _navigationPreviewModel.ctx;
	SpriteRenderer.bind2DContext(ctx, Math.floor(ctx.canvas.width / 2), ctx.canvas.height - 5);
	ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
	const cameraDirection = Camera.direction;
	try {
		Camera.direction = 0;
		_navigationPreviewModel.entity.direction = 0;
		_navigationPreviewModel.entity.renderEntity();
	} finally {
		Camera.direction = cameraDirection;
	}
}
var _navigationGroundPathStyle = 1;
try {
	_navigationGroundPathStyle = Math.max(1, Math.min(8, parseInt(localStorage.getItem("navigationGroundPathStyle"), 10) || 1));
} catch (e) {}
var _navigationGroundPathSource = null;
var _navigationGroundPathPlayerCell = "";
var _navigationGroundPathVertices = Array.from({ length: 8 }, () => new Float32Array(0));
function setNavigationGroundPathStyle(style) {
	style = Math.max(1, Math.min(8, parseInt(style, 10) || 1));
	if (_navigationGroundPathStyle === style && _navigationGroundPathTexturesReady > 0) return;
	_navigationGroundPathStyle = style;
	try {
		localStorage.setItem("navigationGroundPathStyle", String(style));
	} catch (e) {}
	const gl = Renderer.getContext();
	if (gl) for (const texture of _navigationGroundPathTextures) if (texture && gl.isTexture(texture)) gl.deleteTexture(texture);
	_navigationGroundPathTextures = Array(8).fill(null);
	_navigationGroundPathTexturesLoading = false;
	_navigationGroundPathTexturesReady = 0;
	if (gl) loadNavigationGroundPathTextures(gl);
}
function loadNavigationGroundPathTextures(gl) {
	if (_navigationGroundPathTexturesLoading) return;
	_navigationGroundPathTexturesLoading = true;
	// Cleared once every frame has settled, successfully or not. Leaving it
	// set on failure meant a client whose GRF lacks these arrows never tried
	// again -- and a GRF that lacks them is exactly the case this feature is
	// for.
	let settled = 0;
	const settle = () => { if (++settled === 8) _navigationGroundPathTexturesLoading = false; };
	for (let frame = 0; frame < 8; frame++) Client.loadFile(DB.INTERFACE_PATH + "navigation_interface3/navi_grid" + _navigationGroundPathStyle + "_" + frame + ".tga", function(buffer) {
		Texture.load(buffer, function(success) {
			settle();
			if (!success || gl.isContextLost()) return;
			const texture = gl.createTexture();
			const previousFlip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
			gl.bindTexture(gl.TEXTURE_2D, texture);
			gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this);
			gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, previousFlip);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			_navigationGroundPathTextures[frame] = texture;
			_navigationGroundPathTexturesReady++;
		});
	});
}
function loadNavigationTargetTextures(gl) {
	if (_navigationTargetTexturesLoading) return;
	_navigationTargetTexturesLoading = true;
	let settled = 0;
	const settle = () => { if (++settled === 4) _navigationTargetTexturesLoading = false; };
	for (let frame = 0; frame < 4; frame++) Client.loadFile(DB.INTERFACE_PATH + "navigation_interface3/location" + (frame + 1) + ".tga", function(buffer) {
		Texture.load(buffer, function(success) {
			settle();
			if (!success || gl.isContextLost()) return;
			const texture = gl.createTexture();
			const previousFlip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL);
			gl.bindTexture(gl.TEXTURE_2D, texture);
			gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
			gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this);
			gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, previousFlip);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
			gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
			_navigationTargetTextures[frame] = texture;
			_navigationTargetTexturesReady++;
		});
	});
}
function buildNavigationGroundPathVertices() {
	const groups = Array.from({ length: 8 }, () => []);
	if (!_path || _path.length < 3) return groups.map(() => new Float32Array(0));
	const step = Math.max(3, Math.ceil(_path.length / 70));
	const player = getPlayerPosition();
	let closestIndex = 0;
	let closestDistance = Infinity;
	for (let i = 0; i < _path.length; i++) {
		const candidate = _path[i];
		if (!candidate || candidate.isWarp) break;
		const distance = Math.hypot(candidate.x - player.x, candidate.y - player.y);
		if (distance < closestDistance) {
			closestDistance = distance;
			closestIndex = i;
		}
	}
	const firstMarkerIndex = Math.min(Math.max(step, Math.ceil(closestIndex / step) * step), _path.length - 2);
	for (let i = firstMarkerIndex; i < _path.length - 1; i += step) {
		const point = _path[i];
		if (!point || point.isWarp) break;
		if (Math.hypot(point.x - player.x, point.y - player.y) < 0.9) continue;
		let next = _path[Math.min(i + 2, _path.length - 1)];
		if (!next || next.isWarp) next = _path[Math.min(i + 1, _path.length - 1)];
		if (!next) continue;
		const dx = next.x - point.x;
		const dy = next.y - point.y;
		if (Math.hypot(dx, dy) < 0.01) continue;
		const octant = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
		const frame = (6 - octant + 8) % 8;
		const cell = Altitude.getCell(Math.floor(point.x), Math.floor(point.y));
		if (!cell || cell.length < 4) continue;
		const height = (cell[0] + cell[1] + cell[2] + cell[3]) / 4 - 0.14;
		const centerX = point.x + 0.5;
		const centerY = point.y + 0.5;
		const halfSize = 0.72;
		const left = centerX - halfSize;
		const right = centerX + halfSize;
		const bottom = centerY - halfSize;
		const top = centerY + halfSize;
		groups[frame].push(
			left, height, bottom, 0, 0,
			right, height, bottom, 1, 0,
			left, height, top, 0, 1,
			left, height, top, 0, 1,
			right, height, bottom, 1, 0,
			right, height, top, 1, 1
		);
	}
	return groups.map((vertices) => new Float32Array(vertices));
}
function buildNavigationTargetVertices() {
	if (!_finalTargetData || getCurrentMap() !== _finalTargetData.map) return new Float32Array(0);
	const cell = Altitude.getCell(Math.floor(_finalTargetData.x), Math.floor(_finalTargetData.y));
	if (!cell || cell.length < 4) return new Float32Array(0);
	const height = (cell[0] + cell[1] + cell[2] + cell[3]) / 4 - 0.16;
	const centerX = _finalTargetData.x + 0.5;
	const centerY = _finalTargetData.y + 0.5;
	const halfSize = 1.65;
	return new Float32Array([
		centerX - halfSize, height, centerY - halfSize, 0, 0,
		centerX + halfSize, height, centerY - halfSize, 1, 0,
		centerX - halfSize, height, centerY + halfSize, 0, 1,
		centerX - halfSize, height, centerY + halfSize, 0, 1,
		centerX + halfSize, height, centerY - halfSize, 1, 0,
		centerX + halfSize, height, centerY + halfSize, 1, 1
	]);
}
function renderNavigationGroundPath(gl, modelView, projection, tick) {
	if (Navigation && Navigation.hasReachedTarget && Navigation.hasReachedTarget()) {
		Navigation.completeNavigation();
		return;
	}
	const targetVisible = _finalTargetData && getCurrentMap() === _finalTargetData.map;
	if ((!_path || _path.length < 3) && !targetVisible) return;
	if (_navigationGroundPathProgram && !gl.isProgram(_navigationGroundPathProgram)) {
		_navigationGroundPathProgram = null;
		_navigationGroundPathBuffers = Array(8).fill(null);
		_navigationGroundPathTextures = Array(8).fill(null);
		_navigationGroundPathTexturesLoading = false;
		_navigationGroundPathTexturesReady = 0;
		_navigationTargetTextures = Array(4).fill(null);
		_navigationTargetTexturesLoading = false;
		_navigationTargetTexturesReady = 0;
		_navigationTargetBuffer = null;
		_navigationTargetSource = null;
		_navigationTargetVertices = new Float32Array(0);
		_navigationGroundPathSource = null;
		_navigationGroundPathPlayerCell = "";
	}
	if (!_navigationGroundPathProgram) {
		const vertexShader = '#version 300 es\nprecision highp float;\nin vec3 aPosition;\nin vec2 aTextureCoord;\nout vec2 vTextureCoord;\nuniform mat4 uModelViewMat;\nuniform mat4 uProjectionMat;\nvoid main(void) { gl_Position = uProjectionMat * uModelViewMat * vec4(aPosition, 1.0); vTextureCoord = aTextureCoord; }';
		const fragmentShader = '#version 300 es\nprecision highp float;\nin vec2 vTextureCoord;\nout vec4 fragColor;\nuniform sampler2D uDiffuse;\nvoid main(void) { vec4 color = texture(uDiffuse, vTextureCoord); if (color.a < 0.03) discard; fragColor = color; }';
		_navigationGroundPathProgram = WebGL_default.createShaderProgram(gl, vertexShader, fragmentShader);
		_navigationGroundPathBuffers = Array.from({ length: 8 }, () => gl.createBuffer());
		_navigationTargetBuffer = gl.createBuffer();
		loadNavigationGroundPathTextures(gl);
		loadNavigationTargetTextures(gl);
	}
	const playerPosition = getPlayerPosition();
	const playerCell = Math.floor(playerPosition.x) + ":" + Math.floor(playerPosition.y);
	if (_navigationGroundPathSource !== _path || _navigationGroundPathPlayerCell !== playerCell) {
		_navigationGroundPathSource = _path;
		_navigationGroundPathPlayerCell = playerCell;
		_navigationGroundPathVertices = buildNavigationGroundPathVertices();
		for (let frame = 0; frame < 8; frame++) {
			gl.bindBuffer(gl.ARRAY_BUFFER, _navigationGroundPathBuffers[frame]);
			gl.bufferData(gl.ARRAY_BUFFER, _navigationGroundPathVertices[frame], gl.DYNAMIC_DRAW);
		}
	}
	const targetSource = targetVisible ? _finalTargetData.map + ":" + _finalTargetData.x + ":" + _finalTargetData.y : null;
	if (_navigationTargetSource !== targetSource) {
		_navigationTargetSource = targetSource;
		_navigationTargetVertices = buildNavigationTargetVertices();
		gl.bindBuffer(gl.ARRAY_BUFFER, _navigationTargetBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, _navigationTargetVertices, gl.DYNAMIC_DRAW);
	}
	const program = _navigationGroundPathProgram;
	const wasBlendEnabled = gl.isEnabled(gl.BLEND);
	const wasCullEnabled = gl.isEnabled(gl.CULL_FACE);
	const previousDepthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
	gl.useProgram(program);
	gl.uniformMatrix4fv(program.uniform.uModelViewMat, false, modelView);
	gl.uniformMatrix4fv(program.uniform.uProjectionMat, false, projection);
	gl.activeTexture(gl.TEXTURE0);
	gl.uniform1i(program.uniform.uDiffuse, 0);
	gl.enableVertexAttribArray(program.attribute.aPosition);
	gl.enableVertexAttribArray(program.attribute.aTextureCoord);
	gl.enable(gl.BLEND);
	gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
	gl.disable(gl.CULL_FACE);
	gl.depthMask(false);
	for (let frame = 0; frame < 8; frame++) {
		const vertices = _navigationGroundPathVertices[frame];
		const texture = _navigationGroundPathTextures[frame];
		if (!texture || vertices.length === 0) continue;
		gl.bindBuffer(gl.ARRAY_BUFFER, _navigationGroundPathBuffers[frame]);
		gl.vertexAttribPointer(program.attribute.aPosition, 3, gl.FLOAT, false, 20, 0);
		gl.vertexAttribPointer(program.attribute.aTextureCoord, 2, gl.FLOAT, false, 20, 12);
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 5);
	}
	if (_navigationTargetVertices.length > 0 && _navigationTargetTexturesReady > 0) {
		const targetFrame = Math.floor((Number(tick) || performance.now()) / 180) % 4;
		const targetTexture = _navigationTargetTextures[targetFrame];
		if (targetTexture) {
			gl.bindBuffer(gl.ARRAY_BUFFER, _navigationTargetBuffer);
			gl.vertexAttribPointer(program.attribute.aPosition, 3, gl.FLOAT, false, 20, 0);
			gl.vertexAttribPointer(program.attribute.aTextureCoord, 2, gl.FLOAT, false, 20, 12);
			gl.bindTexture(gl.TEXTURE_2D, targetTexture);
			gl.drawArrays(gl.TRIANGLES, 0, _navigationTargetVertices.length / 5);
		}
	}
	gl.depthMask(previousDepthMask);
	if (wasCullEnabled) gl.enable(gl.CULL_FACE);
	if (!wasBlendEnabled) gl.disable(gl.BLEND);
	gl.disableVertexAttribArray(program.attribute.aPosition);
	gl.disableVertexAttribArray(program.attribute.aTextureCoord);
}`;
patched = patched.replace(navigationVarsNeedle, groundPathImplementation + '\n' + navigationVarsNeedle);

const navigationDependenciesNeedle = '\tinit_DBManager();\n\tinit_Navigation$2();';
if (patched.split(navigationDependenciesNeedle).length !== 2) throw Error('Navigation dependency block not found');
patched = patched.replace(navigationDependenciesNeedle, '\tinit_DBManager();\n\tinit_Entity$1();\n\tinit_SpriteRenderer();\n\tinit_Navigation$2();');

const navigationInitialPositionNeedle = `\t\tthis._host.style.top = \`\${Math.max(0, Math.min(Renderer.height - 300, 200))}px\`;
\t\tthis._host.style.left = \`\${Math.max(0, Math.min(Renderer.width - 300, 200))}px\`;`;
if (patched.split(navigationInitialPositionNeedle).length !== 2) throw Error('Navigation initial position not found');
patched = patched.replace(navigationInitialPositionNeedle, `\t\tthis._host.style.top = \`\${Math.max(0, Math.min(Renderer.height - 430, 120))}px\`;
\t\tthis._host.style.left = \`\${Math.max(0, Math.min(Renderer.width - 390, 120))}px\`;`);

const groundRenderNeedle = '\t\t\tGround_default.render(gl, modelView, projection, normalMat, fog, light);\n\t\t\tEffects_default.spam(SessionStorage_default.Entity.position, tick);';
if (patched.split(groundRenderNeedle).length !== 2) throw Error('Map ground render call not found');
patched = patched.replace(groundRenderNeedle, '\t\t\tGround_default.render(gl, modelView, projection, normalMat, fog, light);\n\t\t\trenderNavigationGroundPath(gl, modelView, projection, tick);\n\t\t\tEffects_default.spam(SessionStorage_default.Entity.position, tick);');

const navigationMapEventsNeedle = '\t\troot.querySelector(".map-display").addEventListener("click", (e) => this.onMapClick(e));';
if (patched.split(navigationMapEventsNeedle).length !== 2) throw Error('Navigation map event hook not found');
patched = patched.replace(navigationMapEventsNeedle, `\t\tconst previewCanvas = root.querySelector(".entity-preview");
\t\t_navigationPreviewModel.ctx = previewCanvas.getContext("2d");
\t\tconst markerMenu = root.querySelector(".marker-menu-button");
\t\tconst markerPalette = root.querySelector(".marker-palette");
\t\tmarkerMenu.addEventListener("click", (event) => {
\t\t\tevent.stopPropagation();
\t\t\tmarkerPalette.classList.toggle("open");
\t\t});
\t\troot.querySelectorAll(".marker-palette [data-style]").forEach((button) => button.addEventListener("click", () => {
\t\t\tsetNavigationGroundPathStyle(button.dataset.style);
\t\t\tconst style = button.dataset.style;
\t\t\tmarkerMenu.setAttribute("bg", "navigation_interface3/btn_roadiocn_select" + style + "_normal.bmp");
\t\t\tmarkerMenu.setAttribute("hover", "navigation_interface3/btn_roadiocn_select" + style + "_over.bmp");
\t\t\tmarkerMenu.setAttribute("down", "navigation_interface3/btn_roadiocn_select" + style + "_press.bmp");
\t\t\tmarkerPalette.classList.remove("open");
\t\t}));
\t\troot.querySelector(".find-result").addEventListener("click", () => {
\t\t\tif (_selectedNavigationResult) this.navigateToSearchResult(_selectedNavigationResult);
\t\t});
\t\troot.querySelector(".minimize-toggle").addEventListener("change", (event) => {
\t\t\troot.querySelector(".Navigation").classList.toggle("minimized", event.target.checked);
\t\t\tthis._host.style.height = event.target.checked ? "41px" : "430px";
\t\t});
${navigationMapEventsNeedle}`);

const clearPathNeedle = `\tNavigation.clearPath = function clearPath() {
\t\t_path = [];
\t\t_lastPathUpdate = 0;
\t\t_pathUpdateLock = false;
\t};`;
if (patched.split(clearPathNeedle).length !== 2) throw Error('Navigation clearPath method not found');
patched = patched.replace(clearPathNeedle, `\tNavigation.clearPath = function clearPath() {
\t\t_path = [];
\t\t_lastPathUpdate = 0;
\t\t_pathUpdateLock = false;
\t\t_navigationGroundPathSource = null;
\t\t_navigationGroundPathPlayerCell = "";
\t\t_navigationGroundPathVertices = Array.from({ length: 8 }, () => new Float32Array(0));
\t\t_navigationTargetSource = null;
\t\t_navigationTargetVertices = new Float32Array(0);
\t};
\tNavigation.hasReachedTarget = function hasReachedTarget() {
\t\tif (!_finalTargetData || getCurrentMap() !== _finalTargetData.map) return false;
\t\tconst target = _targetData && _targetData.map === _finalTargetData.map ? _targetData : _finalTargetData;
\t\tconst currentPos = getPlayerPosition();
\t\treturn Math.hypot(currentPos.x - target.x, currentPos.y - target.y) <= 5;
\t};
\tNavigation.completeNavigation = function completeNavigation() {
\t\tif (!_finalTargetData) return;
\t\t_finalTargetData = null;
\t\t_targetData = null;
\t\tthis.clearPath();
\t\tthis.setTargetCoordinatesBlinking(false);
\t\tconst root = Navigation.getRoot();
\t\tconst targetInfo = root && root.querySelector(".target-info");
\t\tif (targetInfo) targetInfo.style.display = "none";
\t\tthis.setLocationTitle(getCurrentMap(), null);
\t};`);

const targetUpdateNeedle = `\t\tconst currentMap = getCurrentMap();
\t\tconst currentPos = getPlayerPosition();
\t\tif (_finalTargetData && tick - _lastPathUpdate > _pathUpdateThrottle && !_pathUpdateLock) {`;
if (patched.split(targetUpdateNeedle).length !== 2) throw Error('Navigation target update loop not found');
patched = patched.replace(targetUpdateNeedle, `\t\tconst currentMap = getCurrentMap();
\t\tconst currentPos = getPlayerPosition();
\t\tif (this.hasReachedTarget()) this.completeNavigation();
\t\tif (_finalTargetData && tick - _lastPathUpdate > _pathUpdateThrottle && !_pathUpdateLock) {`);

const naviCommandNeedle = `\t\tnavi: {
\t\t\tdescription: "Navigate to a map location. Usage: /navi mapname x y",
\t\t\tcallback: function(text) {
\t\t\t\tconst matches = text.match(/^navi\\s+(\\S+)\\s+(\\d+)\\s+(\\d+)/);
\t\t\t\tif (matches) {
\t\t\t\t\tNavigation_default.append();
\t\t\t\t\tNavigation_default.navigateTo({
\t\t\t\t\t\tstartMap: MapRenderer.currentMap,
\t\t\t\t\t\tstartX: SessionStorage_default.Entity.position[0] | 0,
\t\t\t\t\t\tstartY: SessionStorage_default.Entity.position[1] | 0,
\t\t\t\t\t\tendMap: matches[1],
\t\t\t\t\t\tendX: parseInt(matches[2], 10),
\t\t\t\t\t\tendY: parseInt(matches[3], 10),
\t\t\t\t\t\tdisplayName: matches[1] + " (" + matches[2] + ", " + matches[3] + ")"
\t\t\t\t\t});
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t}
\t\t},`;
if (patched.split(naviCommandNeedle).length !== 2) throw Error('/navi command implementation not found');
patched = patched.replace(naviCommandNeedle, `\t\tnavi: {
\t\t\tdescription: "Navigate by coordinates or search by name. Usage: /navi map x/y or /navi name",
\t\t\tcallback: function(text) {
\t\t\t\tconst args = text.replace(/^navi\\s*/i, "").trim();
\t\t\t\tconst coordinates = args.match(/^(\\S+)\\s+(\\d+)\\s*(?:\\/|,|\\s)\\s*(\\d+)$/);
\t\t\t\tNavigation_default.append();
\t\t\t\tNavigation_default.show();
\t\t\t\tif (coordinates) {
\t\t\t\t\tconst navigationRoot = Navigation_default.getRoot();
\t\t\t\t\tnavigationRoot.querySelector(".search-workspace").style.display = "none";
\t\t\t\t\tnavigationRoot.querySelector(".search-actions").style.display = "none";
\t\t\t\t\tnavigationRoot.querySelector(".map-container").style.display = "flex";
\t\t\t\t\tNavigation_default.navigateTo({
\t\t\t\t\t\tstartMap: MapRenderer.currentMap,
\t\t\t\t\t\tstartX: SessionStorage_default.Entity.position[0] | 0,
\t\t\t\t\t\tstartY: SessionStorage_default.Entity.position[1] | 0,
\t\t\t\t\t\tendMap: coordinates[1],
\t\t\t\t\t\tendX: parseInt(coordinates[2], 10),
\t\t\t\t\t\tendY: parseInt(coordinates[3], 10),
\t\t\t\t\t\tdisplayName: coordinates[1] + " (" + coordinates[2] + ", " + coordinates[3] + ")"
\t\t\t\t\t});
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tif (args.length >= 2) {
\t\t\t\t\tconst root = Navigation_default.getRoot();
\t\t\t\t\troot.querySelector(".search-input").value = args;
\t\t\t\t\troot.querySelector(".search-type").value = "ALL";
\t\t\t\t\tNavigation_default.onSearch();
\t\t\t\t}
\t\t\t}
\t\t},`);

const keypressNeedle = `\t\tsearchInput.addEventListener("keypress", (e) => {
\t\t\tif (e.which === KEYS.ENTER || e.key === "Enter") this.onSearch();
\t\t});`;
if (patched.split(keypressNeedle).length !== 2) throw Error('Navigation keypress handler not found');
patched = patched.replace(keypressNeedle, `${keypressNeedle}
\t\tsearchInput.addEventListener("input", () => {
\t\t\tif (searchInput.value.trim().length >= 2) return;
\t\t\tconst resultsContainer = root.querySelector(".search-results");
\t\t\tif (resultsContainer) {
\t\t\t\tresultsContainer.innerHTML = "";
\t\t\t\tresultsContainer.style.display = "block";
\t\t\t}
\t\t\troot.querySelector(".search-count").textContent = "0";
\t\t\troot.querySelector(".search-workspace").style.display = "flex";
\t\t\troot.querySelector(".search-actions").style.display = "flex";
\t\t\t_selectedNavigationResult = null;
\t\t\t_navigationPreviewModel.render = false;
\t\t\tif (_navigationPreviewModel.ctx) _navigationPreviewModel.ctx.clearRect(0, 0, _navigationPreviewModel.ctx.canvas.width, _navigationPreviewModel.ctx.canvas.height);
\t\t\troot.querySelector(".detail-name").textContent = "Select a result";
\t\t\troot.querySelector(".detail-coordinates").textContent = "";
\t\t\troot.querySelector(".detail-stats").replaceChildren();
\t\t\troot.querySelector(".location-list").replaceChildren();
\t\t\troot.querySelector(".detail-map-preview").style.backgroundImage = "";
\t\t\troot.querySelector(".detail-map-pin").style.display = "none";
\t\t\tconst findButton = root.querySelector(".find-result");
\t\t\tfindButton.classList.add("disabled");
\t\t\tfindButton.disabled = true;
\t\t\tconst mapContainer = root.querySelector(".map-container");
\t\t\tif (mapContainer) mapContainer.style.display = "none";
\t\t});`);

const focusNeedle = `\t\tsearchInput.addEventListener("focus", () => {
\t\t\tconst resultsContainer = root.querySelector(".search-results");
\t\t\tif (resultsContainer && resultsContainer.children.length > 0) resultsContainer.style.display = "";
\t\t});`;
if (patched.split(focusNeedle).length !== 2) throw Error('Navigation focus handler not found');
patched = patched.replace(focusNeedle, `\t\tsearchInput.addEventListener("focus", () => {
\t\t\tconst resultsContainer = root.querySelector(".search-results");
\t\t\tif (resultsContainer && resultsContainer.children.length > 0) {
\t\t\t\tresultsContainer.style.display = "";
\t\t\t\troot.querySelector(".search-workspace").style.display = "flex";
\t\t\t\troot.querySelector(".search-actions").style.display = "flex";
\t\t\t\tconst mapContainer = root.querySelector(".map-container");
\t\t\t\tif (mapContainer) mapContainer.style.display = "none";
\t\t\t}
\t\t});`);

const outsideClickNeedle = `\t\t_documentClickHandler = (e) => {
\t\t\tif (!e.target.closest(".search-results, .search-input, .search-button, .search-type")) {
\t\t\t\tconst resultsContainer = root.querySelector(".search-results");
\t\t\t\tif (resultsContainer) resultsContainer.style.display = "none";
\t\t\t}
\t\t};`;
if (patched.split(outsideClickNeedle).length !== 2) throw Error('Navigation outside-click handler not found');
patched = patched.replace(outsideClickNeedle, `\t\t_documentClickHandler = (e) => {
\t\t\tconst clickPath = typeof e.composedPath === "function" ? e.composedPath() : [];
\t\t\tif (!clickPath.includes(this._host)) {
\t\t\t\troot.querySelector(".marker-palette").classList.remove("open");
\t\t\t}
\t\t};`);

const searchNeedle = `\t\tconst results = DB.searchNavigation(query, type);
\t\tthis.displaySearchResults(results);`;
if (patched.split(searchNeedle).length !== 2) throw Error('Navigation search call not found');
patched = patched.replace(searchNeedle, `\t\tconst results = DB.searchNavigation(query, type);
\t\tconst groupsByName = new Map();
\t\tfor (const result of results) {
\t\t\tconst key = result.type + "\\0" + result.name.trim().toLowerCase();
\t\t\tlet group = groupsByName.get(key);
\t\t\tif (!group) {
\t\t\t\tgroup = { ...result, locations: [] };
\t\t\t\tgroupsByName.set(key, group);
\t\t\t}
\t\t\tgroup.locations.push(result);
\t\t}
\t\tconst groupedResults = Array.from(groupsByName.values());
\t\tfor (const group of groupedResults) group.locations.sort((a, b) => a.mapName.localeCompare(b.mapName) || (Number(a.x) || 0) - (Number(b.x) || 0) || (Number(a.y) || 0) - (Number(b.y) || 0));
\t\tthis.displaySearchResults(groupedResults);`);

const displayMethodNeedle = '\tNavigation.displaySearchResults = function displaySearchResults(results) {';
if (patched.split(displayMethodNeedle).length !== 2) throw Error('Navigation result display method not found');
patched = patched.replace(displayMethodNeedle, `\tNavigation.loadDetailMapPreview = function loadDetailMapPreview(location) {
\t\tconst root = Navigation.getRoot();
\t\tconst preview = root.querySelector(".detail-map-preview");
\t\tconst pin = root.querySelector(".detail-map-pin");
\t\tpreview.style.backgroundImage = "";
\t\tpin.style.display = "none";
\t\tif (!location || !location.mapName) return;
\t\tconst selectedLocation = location;
\t\tlet bmpPath = DB.INTERFACE_PATH.replace("data/texture/", "") + "map/" + location.mapName.replace(/\\..*/, "") + ".bmp";
\t\tbmpPath = bmpPath.replace(/\\//g, "\\\\");
\t\tbmpPath = DB.mapalias[bmpPath] || bmpPath;
\t\tconst showFallback = () => loadNavigationFallback(location.mapName, (fallbackURI) => {
\t\t\tif (_selectedNavigationResult === selectedLocation && fallbackURI) preview.style.backgroundImage = 'url("' + fallbackURI + '")';
\t\t});
\t\tClient.loadFile("data/texture/" + bmpPath, (dataURI) => {
\t\t\tif (_selectedNavigationResult !== selectedLocation) return;
\t\t\tif (dataURI) {
\t\t\t\tpreview.style.backgroundImage = 'url("' + dataURI + '")';
\t\t\t\treturn;
\t\t\t}
\t\t\tshowFallback();
\t\t}, showFallback);
\t\tif (location.x == null || location.y == null) return;
\t\tconst mapInfo = DB.getNaviMapTable().find((row) => row && row[0] === location.mapName);
\t\tconst width = Number(mapInfo && mapInfo[3]);
\t\tconst height = Number(mapInfo && mapInfo[4]);
\t\tif (width > 0 && height > 0) {
\t\t\tpin.style.left = Math.max(0, Math.min(100, Number(location.x) / width * 100)) + "%";
\t\t\tpin.style.top = Math.max(0, Math.min(100, (height - Number(location.y)) / height * 100)) + "%";
\t\t\tpin.style.display = "block";
\t\t}
\t};
\tNavigation.selectNavigationLocation = function selectNavigationLocation(location, locationItem) {
\t\tif (!location) return;
\t\t_selectedNavigationResult = location;
\t\tconst root = Navigation.getRoot();
\t\troot.querySelectorAll(".location-row.selected").forEach((item) => item.classList.remove("selected"));
\t\tif (locationItem) locationItem.classList.add("selected");
\t\troot.querySelector(".detail-coordinates").textContent = location.x == null || location.y == null ? "Map-wide spawn" : "(" + location.x + ", " + location.y + ")";
\t\tconst findButton = root.querySelector(".find-result");
\t\tfindButton.classList.remove("disabled");
\t\tfindButton.disabled = false;
\t\tthis.loadDetailMapPreview(location);
\t};
\tNavigation.selectSearchResult = function selectSearchResult(result, resultItem) {
\t\tif (!result || !result.locations || result.locations.length === 0) return;
\t\tconst root = Navigation.getRoot();
\t\troot.querySelectorAll(".result-item.selected").forEach((item) => item.classList.remove("selected"));
\t\tif (resultItem) resultItem.classList.add("selected");
\t\troot.querySelector(".detail-name").textContent = "[" + result.name + "]";
\t\tconst stats = root.querySelector(".detail-stats");
\t\tstats.replaceChildren();
\t\tconst addStat = (label, value) => {
\t\t\tconst row = document.createElement("div");
\t\t\tconst labelNode = document.createElement("span");
\t\t\tlabelNode.className = "label";
\t\t\tlabelNode.textContent = label + ": ";
\t\t\trow.append(labelNode, document.createTextNode(String(value)));
\t\t\tstats.appendChild(row);
\t\t};
\t\tif (result.type === "MOB") {
\t\t\taddStat("Lv.", result.level || "?");
\t\t\taddStat("Element", result.element || "Unknown");
\t\t\taddStat("Type", result.race || "Unknown");
\t\t\taddStat("Size", result.size || "Unknown");
\t\t}
\t\tconst spriteId = Number(result.spriteId) || 0;
\t\tif (spriteId > 0) {
\t\t\t_navigationPreviewModel.entity = new Entity();
\t\t\t_navigationPreviewModel.entity.set({ job: spriteId, action: 0, direction: 0 });
\t\t\t_navigationPreviewModel.render = true;
\t\t\tRenderer.render(renderNavigationEntityPreview);
\t\t} else {
\t\t\t_navigationPreviewModel.entity = null;
\t\t\t_navigationPreviewModel.render = false;
\t\t}
\t\tconst locationList = root.querySelector(".location-list");
\t\tlocationList.replaceChildren();
\t\tconst locationTable = root.querySelector(".location-table");
\t\tif (locationTable) locationTable.scrollTop = 0;
\t\tfor (const location of result.locations) {
\t\t\tconst row = document.createElement("div");
\t\t\trow.className = "location-row";
\t\t\tconst map = document.createElement("span");
\t\t\tmap.textContent = location.mapName;
\t\t\tconst coordinates = document.createElement("span");
\t\t\tcoordinates.textContent = location.x == null || location.y == null ? "—" : location.x + ", " + location.y;
\t\t\tconst frequency = document.createElement("span");
\t\t\tfrequency.className = "location-frequency";
\t\t\tfrequency.textContent = location.type === "MOB" ? location.frequency : "";
\t\t\tif (location.spawnCount) frequency.title = location.spawnCount + " spawn entries";
\t\t\trow.append(map, coordinates, frequency);
\t\t\trow.addEventListener("click", () => this.selectNavigationLocation(location, row));
\t\t\tlocationList.appendChild(row);
\t\t}
\t\tconst firstLocation = locationList.querySelector(".location-row");
\t\tif (firstLocation) this.selectNavigationLocation(result.locations[0], firstLocation);
\t};
\tNavigation.displaySearchResults = function displaySearchResults(results) {`);

const displayNeedle = `\t\t} else resultsContainer.innerHTML = "";
\t\tif (results.length === 0) {`;
if (patched.split(displayNeedle).length !== 2) throw Error('Navigation results display block not found');
patched = patched.replace(displayNeedle, `\t\t} else resultsContainer.innerHTML = "";
\t\tconst mapContainer = root.querySelector(".map-container");
\t\tif (mapContainer) mapContainer.style.display = "none";
\t\troot.querySelector(".search-count").textContent = results.length;
\t\troot.querySelector(".search-workspace").style.display = "flex";
\t\troot.querySelector(".search-actions").style.display = "flex";
\t\t_selectedNavigationResult = null;
\t\t_navigationPreviewModel.render = false;
\t\troot.querySelector(".detail-name").textContent = results.length ? "Select a result" : "No result";
\t\t// A player whose GRF replaced the tables gets an empty search and no
\t\t// reason for it. The mod that fixes it is off by default and lives in
\t\t// another window, so name it here or they will never find it.
\t\troot.querySelector(".detail-coordinates").textContent = results.length ? "" : "Empty? An English GRF can replace these tables. Enable Settings \u2192 Mods \u2192 navigation-english-tables.";
\t\troot.querySelector(".detail-stats").replaceChildren();
\t\troot.querySelector(".location-list").replaceChildren();
\t\troot.querySelector(".detail-map-preview").style.backgroundImage = "";
\t\troot.querySelector(".detail-map-pin").style.display = "none";
\t\tif (_navigationPreviewModel.ctx) _navigationPreviewModel.ctx.clearRect(0, 0, _navigationPreviewModel.ctx.canvas.width, _navigationPreviewModel.ctx.canvas.height);
\t\tconst findButton = root.querySelector(".find-result");
\t\tfindButton.classList.add("disabled");
\t\tfindButton.disabled = true;
\t\tif (results.length === 0) {`);

const navigateNeedle = `\t\tconst resultsContainer = Navigation.getRoot().querySelector(".search-results");
\t\tif (resultsContainer) resultsContainer.style.display = "none";`;
if (patched.split(navigateNeedle).length !== 2) throw Error('Navigation result-selection cleanup not found');
patched = patched.replace(navigateNeedle, `\t\tconst navigationRoot = Navigation.getRoot();
\t\tconst resultsContainer = navigationRoot.querySelector(".search-results");
\t\tif (resultsContainer) resultsContainer.style.display = "none";
\t\tconst searchWorkspace = navigationRoot.querySelector(".search-workspace");
\t\tif (searchWorkspace) searchWorkspace.style.display = "none";
\t\tconst searchActions = navigationRoot.querySelector(".search-actions");
\t\tif (searchActions) searchActions.style.display = "none";
\t\tconst mapContainer = navigationRoot.querySelector(".map-container");
\t\tif (mapContainer) mapContainer.style.display = "flex";`);

const resultMarkupNeedle = '\t\t\tresultItem.innerHTML = `<span class="result-type ${result.type === "NPC" ? "npc_icon" : "mob_icon"}">${result.type}</span><span class="result-name">${result.name}</span><span class="result-map">${result.mapName}</span>`;';
if (patched.split(resultMarkupNeedle).length !== 2) throw Error('Navigation result markup not found');
patched = patched.replace(resultMarkupNeedle, `\t\t\tresultItem.innerHTML = '<span class="result-type"></span><span class="result-count"></span><span class="result-name"></span><span class="result-map"></span>';
\t\t\tconst typeIcon = resultItem.querySelector(".result-type");
\t\t\ttypeIcon.classList.add(result.type === "NPC" ? "npc_icon" : "mob_icon");
\t\t\tresultItem.querySelector(".result-count").textContent = "[" + result.locations.length + "]";
\t\t\tresultItem.querySelector(".result-name").textContent = result.name;
\t\t\tresultItem.querySelector(".result-map").textContent = result.mapName;
\t\t\tClient.loadFile(DB.INTERFACE_PATH + "navigation_interface3/icon_list_" + result.type.toLowerCase() + ".bmp", (dataURI) => {
\t\t\t\ttypeIcon.style.backgroundImage = 'url("' + dataURI + '")';
\t\t\t});`);

const resultClickNeedle = `\t\t\tresultItem.addEventListener("click", () => {
\t\t\t\tthis.navigateToSearchResult(result);
\t\t\t});`;
if (patched.split(resultClickNeedle).length !== 2) throw Error('Navigation result click handler not found');
patched = patched.replace(resultClickNeedle, `\t\t\tresultItem.addEventListener("click", () => {
\t\t\t\tthis.selectSearchResult(result, resultItem);
\t\t\t});`);

const resultListEndNeedle = `\t\t}
\t\tresultsContainer.style.display = "";
\t};
\t/**
\t* Navigate to a search result`;
if (patched.split(resultListEndNeedle).length !== 2) throw Error('Navigation result list end not found');
patched = patched.replace(resultListEndNeedle, `\t\t}
\t\tresultsContainer.style.display = "";
\t\tconst firstResultItem = resultsContainer.querySelector(".result-item");
\t\tif (firstResultItem && results[0]) this.selectSearchResult(results[0], firstResultItem);
\t};
\t/**
\t* Navigate to a search result`);

const hiddenResultsShowNeedle = 'resultsContainer.style.display = "";';
if (!patched.includes(hiddenResultsShowNeedle)) throw Error('Navigation result show operation not found');
patched = patched.replaceAll(hiddenResultsShowNeedle, 'resultsContainer.style.display = "block";');

const navigationMapClickCoordinatesNeedle = `\t\tconst x = Math.floor(event.clientX - rect.left);
\t\tconst y = Math.floor(event.clientY - rect.top);`;
if (patched.split(navigationMapClickCoordinatesNeedle).length !== 3) throw Error('Unexpected navigation map coordinate handlers');
patched = patched.replaceAll(navigationMapClickCoordinatesNeedle, `\t\tconst x = Math.floor((event.clientX - rect.left) * 280 / rect.width);
\t\tconst y = Math.floor((event.clientY - rect.top) * 230 / rect.height);`);

const navigationRemoveNeedle = `\tNavigation.onRemove = function onRemove() {
\t\tthis.clearPath();
\t\tterminatePathFindingWorker();
\t\tif (_documentClickHandler) document.removeEventListener("click", _documentClickHandler);
\t};`;
if (patched.split(navigationRemoveNeedle).length !== 2) throw Error('Navigation remove method not found');
patched = patched.replace(navigationRemoveNeedle, `\tNavigation.onRemove = function onRemove() {
\t\tthis.clearPath();
\t\t_navigationPreviewModel.render = false;
\t\tRenderer.stop(renderNavigationEntityPreview);
\t\tterminatePathFindingWorker();
\t\tif (_documentClickHandler) document.removeEventListener("click", _documentClickHandler);
\t};`);

const navigationSearchTablesNeedle = `\t\tstatic searchNavigation(query, type) {
\t\t\tif (!query || query.length < 2) return [];
\t\t\tquery = query.toLowerCase();
\t\t\tconst results = [];`;
if (patched.split(navigationSearchTablesNeedle).length !== 2) throw Error('Navigation database search method not found');
patched = patched.replace(navigationSearchTablesNeedle, `${navigationSearchTablesNeedle}
\t\t\tconst elementNames = ["Neutral", "Water", "Earth", "Fire", "Wind", "Poison", "Holy", "Shadow", "Ghost", "Undead"];
\t\t\tconst raceNames = ["Formless", "Undead", "Brute", "Plant", "Insect", "Fish", "Demon", "Demi-Human", "Angel", "Dragon", "Player", "Boss"];
\t\t\tconst sizeNames = ["Small", "Medium", "Large"];`);

const npcResultIdNeedle = `\t\t\t\t\ttype: "NPC",
\t\t\t\t\tid: npcId,
\t\t\t\t\tname: npcName,`;
if (patched.split(npcResultIdNeedle).length !== 2) throw Error('NPC navigation result fields not found');
patched = patched.replace(npcResultIdNeedle, `\t\t\t\t\ttype: "NPC",
\t\t\t\t\tid: npcId,
\t\t\t\t\tspriteId: Number(npc[3]) & 65535,
\t\t\t\t\tname: npcName,`);

const mobResultIdNeedle = `\t\t\t\t\ttype: "MOB",
\t\t\t\t\tid: mobId,
\t\t\t\t\tname: mobName,`;
if (patched.split(mobResultIdNeedle).length !== 2) throw Error('MOB navigation result fields not found');
patched = patched.replace(mobResultIdNeedle, `\t\t\t\t\ttype: "MOB",
\t\t\t\t\tid: mobId,
\t\t\t\t\tspriteId: Number(mob[3]) & 65535,
\t\t\t\t\tspawnCount: Number(mob[3]) >>> 16,
\t\t\t\t\tfrequency: (() => { const count = Number(mob[3]) >>> 16; if (count <= 5) return "Very Low"; if (count <= 15) return "Low"; if (count <= 40) return "Average"; if (count <= 80) return "High"; return "Very High"; })(),
\t\t\t\t\tname: mobName,
\t\t\t\t\tlevel: Number(mob[6]) || 0,
\t\t\t\t\telement: (() => { const code = Number(mob[7]) >>> 16 & 255; const kind = Math.floor(code / 20); const level = code % 20; return (elementNames[kind] || "Unknown") + (level ? " " + level : ""); })(),
\t\t\t\t\trace: raceNames[Number(mob[7]) & 255] || "Unknown",
\t\t\t\t\tsize: sizeNames[Number(mob[7]) >>> 8 & 255] || "Unknown",`);

const navigationSearchLimitNeedle = '\t\t\treturn results.slice(0, 50);';
if (patched.split(navigationSearchLimitNeedle).length !== 2) throw Error('Navigation result limit not found');
patched = patched.replace(navigationSearchLimitNeedle, '\t\t\treturn results.slice(0, 500);');

const navigationMapImageNeedle = `\t\tClient.loadFile("data/texture/" + bmpPath, (dataURI) => {
\t\t\tif (dataURI) _map.src = dataURI;
\t\t\telse _map.src = "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
\t\t});`;
if (patched.split(navigationMapImageNeedle).length !== 2) throw Error('Navigation map image loader not found');
patched = patched.replace(navigationMapImageNeedle, `\t\tconst showFallback = () => loadNavigationFallback(mapBaseName, (fallbackURI) => {
\t\t\t_map.src = fallbackURI || "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==";
\t\t});
\t\tClient.loadFile("data/texture/" + bmpPath, (dataURI) => {
\t\t\tif (dataURI) {
\t\t\t\t_map.src = dataURI;
\t\t\t\treturn;
\t\t\t}
\t\t\tshowFallback();
\t\t}, showFallback);`);

const naviMapGetterNeedle = `\t\tstatic getNaviLinkTable() {
\t\t\treturn NaviLinkTable;
\t\t}`;
if (patched.split(naviMapGetterNeedle).length !== 2) throw Error('Navigation link table getter not found');
patched = patched.replace(naviMapGetterNeedle, `\t\tstatic getNaviMapTable() {
\t\t\treturn NaviMapTable;
\t\t}
\t\t${naviMapGetterNeedle}`);

const navigationHideNeedle = `\tNavigation.hide = function hide() {
\t\tthis.ui.hide();
\t\tterminatePathFindingWorker();
\t};`;
if (patched.split(navigationHideNeedle).length !== 2) throw Error('Navigation hide method not found');
patched = patched.replace(navigationHideNeedle, `\tNavigation.hide = function hide() {
\t\tthis.clear();
\t\t_navigationPreviewModel.render = false;
\t\tif (_navigationPreviewModel.ctx) _navigationPreviewModel.ctx.clearRect(0, 0, _navigationPreviewModel.ctx.canvas.width, _navigationPreviewModel.ctx.canvas.height);
\t\tthis.ui.hide();
\t\tterminatePathFindingWorker();
\t};`);

const check = require('node:child_process').spawnSync(process.execPath, ['--input-type=module', '--check'], {input:patched, encoding:'utf8'});
if(check.status !== 0) throw Error(check.stderr);
fs.mkdirSync(path.dirname(output), {recursive:true});
fs.writeFileSync(output, patched);
const manifest = {
  source: input,
  output,
  originalSHA256: crypto.createHash('sha256').update(original).digest('hex'),
  patchedSHA256: crypto.createHash('sha256').update(patched).digest('hex'),
  generatedAt: new Date().toISOString()
};
console.log(JSON.stringify(manifest));
