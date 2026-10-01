// The backdrop: a harbour town at dusk, seen from a ship's deck. Drawn as an
// SVG from code, so the mod ships no artwork of anyone's -- change the seed,
// the colours or the skyline here and every screen follows.

function random(seed) {
	let s = seed >>> 0;
	return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

// A ridge line across the width: midpoint displacement, smoothed.
function ridge(rand, y, roughness, steps = 7) {
	let points = [[0, y], [1600, y]];
	let spread = roughness;
	for (let i = 0; i < steps; i++) {
		const next = [];
		for (let j = 0; j < points.length - 1; j++) {
			const [x1, y1] = points[j];
			const [x2, y2] = points[j + 1];
			next.push(points[j], [(x1 + x2) / 2, (y1 + y2) / 2 + (rand() - 0.5) * spread]);
		}
		next.push(points[points.length - 1]);
		points = next;
		spread *= 0.55;
	}
	return `M0,900 ${points.map(([x, py]) => `L${x.toFixed(0)},${py.toFixed(1)}`).join(' ')} L1600,900 Z`;
}

function town(rand) {
	const parts = [];
	const base = 600;
	let x = 140;
	while (x < 900) {
		const w = 26 + rand() * 34;
		const h = 22 + rand() * 46 + (x > 420 && x < 640 ? 30 : 0);
		const wall = ['#c8ae8c', '#b99b7a', '#d6c09c', '#a98c6e'][Math.floor(rand() * 4)];
		const roof = ['#7a3f33', '#5f3a3a', '#8a4a35', '#4f3b46'][Math.floor(rand() * 4)];
		const top = base - h;
		parts.push(`<rect x="${x}" y="${top}" width="${w}" height="${h}" fill="${wall}"/>`);
		parts.push(`<path d="M${x - 3},${top} L${x + w / 2},${top - 10 - rand() * 12} L${x + w + 3},${top} Z" fill="${roof}"/>`);
		for (let wy = top + 7; wy < base - 8; wy += 12) {
			for (let wx = x + 5; wx < x + w - 6; wx += 9) {
				if (rand() < 0.45) parts.push(`<rect x="${wx}" y="${wy}" width="3" height="5" fill="#ffd27a" opacity="${0.6 + rand() * 0.4}"/>`);
			}
		}
		x += w - 4 + rand() * 6;
	}
	// The cathedral: a drum, a dome and a lantern.
	parts.push('<rect x="500" y="470" width="90" height="130" fill="#d9c7a6"/>');
	parts.push('<rect x="515" y="430" width="60" height="44" fill="#cdb894"/>');
	parts.push('<path d="M512,432 Q545,360 578,432 Z" fill="#9fb0c4"/>');
	parts.push('<rect x="540" y="372" width="10" height="20" fill="#cdb894"/><path d="M538,374 L545,358 L552,374 Z" fill="#7d8ea3"/>');
	for (let i = 0; i < 4; i++) parts.push(`<rect x="${522 + i * 15}" y="445" width="5" height="16" rx="2" fill="#ffcf73" opacity=".85"/>`);
	return parts.join('');
}

// The ship's rail and deck, planks running to a vanishing point.
function deck() {
	const top = 735, vx = 800, vy = 260;
	const t = (top - vy) / (900 - vy);
	const parts = [`<rect y="${top}" width="1600" height="${900 - top}" fill="url(#deck)"/>`];
	for (let x = -2400; x <= 4000; x += 120) {
		parts.push(`<path d="M${(vx + (x - vx) * t).toFixed(1)},${top} L${x},900" stroke="#2a180d" stroke-opacity=".55" stroke-width="2"/>`);
	}
	for (let y = top + 8, gap = 8; y < 900; gap *= 1.35, y += gap) {
		parts.push(`<rect y="${y.toFixed(1)}" width="1600" height="1.2" fill="#2a180d" opacity=".35"/>`);
	}
	// The rail: a beam on posts, along the deck's edge.
	parts.push(`<rect y="${top - 6}" width="1600" height="8" fill="#3b2414"/>`);
	for (let x = 10; x < 1600; x += 58) {
		parts.push(`<rect x="${x}" y="${top - 58}" width="11" height="54" fill="#4d2f1b"/><rect x="${x}" y="${top - 58}" width="3" height="54" fill="#6d4529"/>`);
	}
	parts.push(`<rect y="${top - 70}" width="1600" height="14" fill="#5c3a22"/><rect y="${top - 70}" width="1600" height="3" fill="#8a5c38"/>`);
	parts.push(`<rect y="${top}" width="1600" height="${900 - top}" fill="url(#deckShade)"/>`);
	return parts.join('');
}

export function scene(seed = 7) {
	const rand = random(seed);
	const stars = Array.from({ length: 70 }, () =>
		`<circle cx="${(rand() * 1600).toFixed(0)}" cy="${(rand() * 330).toFixed(0)}" r="${(0.6 + rand() * 1.1).toFixed(1)}" fill="#fff" opacity="${(0.25 + rand() * 0.6).toFixed(2)}"/>`).join('');
	const clouds = Array.from({ length: 7 }, () => {
		const cx = rand() * 1600, cy = 90 + rand() * 260, w = 140 + rand() * 260;
		return `<ellipse cx="${cx.toFixed(0)}" cy="${cy.toFixed(0)}" rx="${w.toFixed(0)}" ry="${(10 + rand() * 12).toFixed(0)}" fill="url(#cloud)" filter="url(#soft)"/>`;
	}).join('');
	const boats = [[1180, 650], [1320, 662]].map(([bx, by]) =>
		`<path d="M${bx - 22},${by} L${bx + 22},${by} L${bx + 16},${by + 7} L${bx - 16},${by + 7} Z" fill="#2a2235"/>` +
		`<path d="M${bx},${by - 34} L${bx},${by} L${bx + 18},${by - 4} Z" fill="#e8dcc8" opacity=".85"/>`).join('');
	return `<svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
		<defs>
			<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
				<stop offset="0" stop-color="#141c3d"/><stop offset=".35" stop-color="#33467e"/>
				<stop offset=".58" stop-color="#8c7aa6"/><stop offset=".7" stop-color="#f0a46e"/><stop offset=".74" stop-color="#f7cf95"/>
			</linearGradient>
			<filter id="soft" x="-20%" y="-200%" width="140%" height="500%"><feGaussianBlur stdDeviation="7"/></filter>
			<radialGradient id="sun" cx=".5" cy=".5" r=".5">
				<stop offset="0" stop-color="#fff6cf"/><stop offset=".25" stop-color="#ffd98a" stop-opacity=".9"/>
				<stop offset="1" stop-color="#ff9a5a" stop-opacity="0"/>
			</radialGradient>
			<linearGradient id="cloud" x1="0" y1="0" x2="0" y2="1">
				<stop offset="0" stop-color="#ffd8c4" stop-opacity=".55"/><stop offset="1" stop-color="#8a6f9c" stop-opacity=".15"/>
			</linearGradient>
			<linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
				<stop offset="0" stop-color="#e2a276"/><stop offset=".12" stop-color="#5d77a8"/>
				<stop offset=".55" stop-color="#28457a"/><stop offset="1" stop-color="#14233f"/>
			</linearGradient>
			<linearGradient id="deck" x1="0" y1="0" x2="0" y2="1">
				<stop offset="0" stop-color="#8a5a36"/><stop offset=".5" stop-color="#6a4227"/><stop offset="1" stop-color="#43291a"/>
			</linearGradient>
			<radialGradient id="deckShade" cx=".5" cy=".1" r=".8">
				<stop offset="0" stop-color="#ffcf8a" stop-opacity=".2"/><stop offset="1" stop-color="#000" stop-opacity=".45"/>
			</radialGradient>
			<linearGradient id="haze"x1="0" y1="0" x2="0" y2="1">
				<stop offset="0" stop-color="#f3b68a" stop-opacity="0"/><stop offset="1" stop-color="#f3b68a" stop-opacity=".45"/>
			</linearGradient>
		</defs>
		<rect width="1600" height="900" fill="url(#sky)"/>
		${stars}
		<circle cx="1020" cy="560" r="230" fill="url(#sun)"/>
		${clouds}
		<path d="${ridge(rand, 470, 260)}" fill="#5a5a8c" opacity=".9"/>
		<path d="${ridge(rand, 530, 160)}" fill="#3e4475"/>
		<rect y="430" width="1600" height="180" fill="url(#haze)"/>
		${town(rand)}
		<rect y="600" width="1600" height="300" fill="url(#sea)"/>
		<g opacity=".5">${Array.from({ length: 22 }, (_, i) =>
			`<rect x="${(930 + (rand() - 0.5) * (40 + i * 9)).toFixed(0)}" y="${612 + i * 9}" width="${(30 + rand() * 90).toFixed(0)}" height="2" fill="#ffe0a8"/>`).join('')}</g>
		<g opacity=".18">${Array.from({ length: 30 }, () =>
			`<rect x="${(rand() * 1600).toFixed(0)}" y="${(615 + rand() * 280).toFixed(0)}" width="${(20 + rand() * 70).toFixed(0)}" height="1.5" fill="#fff"/>`).join('')}</g>
		${boats}
		${deck()}
	</svg>`;
}
