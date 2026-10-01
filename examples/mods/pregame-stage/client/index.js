// pregame-stage: the screens before the game, drawn by a mod.
//
// api.screens.replace(screen, { show, update, hide }) hands a screen to this
// plugin. The client's own window keeps doing the work -- it still holds the
// character list and sends the packets -- and `view` carries its data and its
// buttons: view.play(), view.create(), view.login(user, password)...
// view.root is a full-window layer (a shadow root) that is ours to fill, and
// is emptied and removed for us when the screen closes.

import { scene } from './scene.js';

const css = new URL('./style.css', import.meta.url).href;

const SCENE = `
	<div class="scene">${scene()}</div>
	<div class="vignette"></div>
	<div class="wordmark">Ragnarok<small>OFFLINE</small></div>`;

function frame(view, html) {
	view.root.innerHTML = `<link rel="stylesheet" href="${css}"><div class="screen">${SCENE}${html}</div>`;
	return view.root.querySelector('.screen');
}

const esc = text => String(text).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const number = value => Number(value).toLocaleString();

export default function init(params, api) {
	if (!api?.screens?.supported?.()) {
		// An older client: nothing to do, and the stock screens stay.
		return;
	}

	// --- Login -----------------------------------------------------------
	if (params?.login !== false) {
		api.screens.replace('login', {
			show(view) {
				const screen = frame(view, `
					<form class="login panel">
						<h2>WELCOME BACK</h2>
						<label for="user">Account</label>
						<input id="user" type="text" autocomplete="username" maxlength="23">
						<label for="pass">Password</label>
						<input id="pass" type="password" autocomplete="current-password" maxlength="23">
						<label class="remember"><input type="checkbox" class="save"> Remember my account</label>
						<button class="go primary" type="submit">LOG IN</button>
						<div class="row">
							<button type="button" class="signup quiet">Create account</button>
							<button type="button" class="exit quiet">Exit</button>
						</div>
					</form>`);
				const user = screen.querySelector('#user');
				const pass = screen.querySelector('#pass');
				const save = screen.querySelector('.save');
				user.value = view.savedId;
				save.checked = view.saveId;
				(view.savedId ? pass : user).focus();
				screen.querySelector('form').addEventListener('submit', event => {
					event.preventDefault();
					if (!user.value) return user.focus();
					// The same path as the client's Connect button.
					view.login(user.value, pass.value, { saveId: save.checked });
				});
				screen.querySelector('.signup').addEventListener('click', () => view.signup());
				screen.querySelector('.exit').addEventListener('click', () => view.exit());
			},
			// Nothing on this screen changes while it is up.
			update() {},
		});
	}

	// --- Character select ---------------------------------------------------
	let select = null; // what show() built, for update() and hide()

	function slotRow(view, slot) {
		const who = view.characters.find(c => c.slot === slot);
		const row = document.createElement('div');
		row.className = `slot${who ? '' : ' empty'}${slot === view.index ? ' selected' : ''}`;
		row.dataset.slot = slot;
		row.innerHTML = who
			? `<div class="portrait"><canvas width="56" height="56"></canvas><img alt=""></div>
				<div><div class="name">${esc(who.name)}</div>
				<div class="sub">Lv. ${who.level} ${esc(who.jobName)}</div>
				${who.deletePending ? '<div class="deleting">Waiting to be deleted</div>' : ''}</div>`
			: '<div class="portrait empty"></div><div><div class="name">Empty slot</div></div>';
		if (who) {
			// A head-and-shoulders crop: the feet are below the canvas.
			const portrait = api.screens.stage(row.querySelector('canvas'), { scale: 1 });
			portrait.add(who.look, { x: 0.5, y: 1.9 });
			select.portraits.push(portrait);
			api.screens.image(`renewalparty/icon_jobs_${who.job}.bmp`).then(url => {
				if (url) row.querySelector('img').src = url;
			});
		}
		row.addEventListener('click', () => view.select(slot));
		row.addEventListener('dblclick', () => (who ? view.play(slot) : view.create(slot)));
		return row;
	}

	function drawSelect(view) {
		const screen = select.screen;
		select.portraits.splice(0).forEach(stage => stage.dispose());
		const list = screen.querySelector('.slots');
		const keep = list.scrollTop;
		list.replaceChildren(...Array.from({ length: view.maxSlots }, (_, slot) => slotRow(view, slot)));
		list.scrollTop = keep;

		const who = view.selected;
		select.stage.clear();
		if (who) select.stage.add(who.look, { x: 0.5, y: 0.9, action: who.deletePending ? 'sit' : 'ready' });

		const info = screen.querySelector('.info');
		info.hidden = !who;
		if (who) {
			info.innerHTML = `<h3>${esc(who.name)}</h3><div class="job">Lv. ${who.level} / ${who.jobLevel} ${esc(who.jobName)}</div>
				<dl><dt>Location</dt><dd>${esc(who.mapName || who.map)}</dd>
				<dt>HP</dt><dd>${number(who.hp)} / ${number(who.maxHp)}</dd>
				<dt>SP</dt><dd>${number(who.sp)} / ${number(who.maxSp)}</dd>
				<dt>Zeny</dt><dd>${number(who.zeny)}</dd></dl>
				<div class="stats">${Object.entries(who.stats).map(([k, v]) => `<span>${k.toUpperCase()} ${v}</span>`).join('')}</div>`;
		}
		const play = screen.querySelector('.play');
		play.textContent = who ? 'PLAY' : 'CREATE';
		play.disabled = !view.enabled || Boolean(who?.deletePending);
		const del = screen.querySelector('.delete');
		del.hidden = !who;
		del.textContent = who?.deletePending ? 'Cancel deletion' : 'Delete';
		select.view = view;
	}

	api.screens.replace('charSelect', {
		show(view) {
			const screen = frame(view, `
				<div class="title">CHARACTER SELECTION</div>
				<div class="slots panel"></div>
				<div class="spot"></div><canvas class="stage" width="300" height="300"></canvas>
				<div class="info panel"></div>
				<div class="actions">
					<button class="play primary">PLAY</button>
					<div class="row"><button class="logout danger">Logout</button><button class="delete danger">Delete</button></div>
				</div>`);
			select = { screen, view, portraits: [], stage: api.screens.stage(screen.querySelector('canvas.stage'), { scale: 2 }) };
			screen.querySelector('.play').addEventListener('click', () => (select.view.selected ? select.view.play() : select.view.create()));
			screen.querySelector('.logout').addEventListener('click', () => select.view.exit());
			screen.querySelector('.delete').addEventListener('click', () =>
				select.view.selected?.deletePending ? select.view.cancelDelete() : select.view.requestDelete());
			drawSelect(view);
		},
		update: view => drawSelect(view),
		hide() {
			select?.portraits.forEach(stage => stage.dispose());
			select?.stage.dispose();
			select = null;
		},
	});

	// --- Character creation ---------------------------------------------------
	if (params?.create === false) return;
	let make = null;

	function drawMaker() {
		const { screen, view, look } = make;
		const race = view.races.find(r => r.job === look.job) || view.races[0];
		screen.querySelectorAll('.race button').forEach(b => b.classList.toggle('on', Number(b.dataset.job) === look.job));
		screen.querySelectorAll('.sex button').forEach(b => b.classList.toggle('on', Number(b.dataset.sex) === look.sex));
		screen.querySelector('.hair output').textContent = `${look.head} / ${race.hair.max}`;
		const swatches = screen.querySelector('.swatches');
		if (swatches.childElementCount !== race.hairColor.max - race.hairColor.min + 1) {
			swatches.replaceChildren();
			for (let color = race.hairColor.min; color <= race.hairColor.max; color++) {
				const button = document.createElement('button');
				button.dataset.color = color;
				button.title = `Colour ${color}`;
				button.textContent = color;
				// The client's own swatches, where the game data has them.
				api.screens.image(`make_character_ver2/color0${color + 1}_off.bmp`).then(url => {
					if (url) { button.textContent = ''; button.style.background = `url(${url}) center / cover`; }
				});
				button.addEventListener('click', () => { make.look.headpalette = color; drawMaker(); });
				swatches.append(button);
			}
		}
		swatches.querySelectorAll('button').forEach(b => b.classList.toggle('on', Number(b.dataset.color) === look.headpalette));
		make.actor.set(look);
	}

	api.screens.replace('charCreate', {
		show(view) {
			const screen = frame(view, `
				<div class="title">CHARACTER CREATION</div>
				<div class="maker panel">
					${view.races.length > 1 ? `<h4>Race</h4><div class="choice race">${view.races
						.map(r => `<button data-job="${r.job}">${r.job === 0 ? 'Human' : esc(r.name || 'Doram')}</button>`).join('')}</div>` : ''}
					${view.chooseSex ? '<h4>Body</h4><div class="choice sex"><button data-sex="1">Male</button><button data-sex="0">Female</button></div>' : ''}
					<h4>Hairstyle</h4>
					<div class="stepper hair"><button class="prev">&lt;</button><output></output><button class="next">&gt;</button></div>
					<h4>Hair colour</h4>
					<div class="swatches"></div>
				</div>
				<div class="spot"></div><canvas class="stage" width="300" height="300"></canvas>
				<div class="namebar">
					<div class="turn"><button class="left">&lt;</button><button class="right">&gt;</button></div>
					<input class="name" type="text" maxlength="23" placeholder="Name">
					<div class="row"><button class="make primary">Create</button><button class="cancel quiet">Cancel</button></div>
				</div>`);
			const race = view.races[0];
			const look = { job: race.job, sex: view.sex, head: race.hair.min, headpalette: race.hairColor.min };
			const stage = api.screens.stage(screen.querySelector('canvas.stage'), { scale: 2 });
			let direction = 0;
			make = { screen, view, look, stage, actor: stage.add(look, { x: 0.5, y: 0.9, direction }) };

			screen.querySelectorAll('.race button').forEach(b => b.addEventListener('click', () => {
				const next = view.races.find(r => r.job === Number(b.dataset.job));
				Object.assign(make.look, { job: next.job, head: next.hair.min, headpalette: next.hairColor.min });
				screen.querySelector('.swatches').replaceChildren();
				drawMaker();
			}));
			screen.querySelectorAll('.sex button').forEach(b => b.addEventListener('click', () => { make.look.sex = Number(b.dataset.sex); drawMaker(); }));
			const step = delta => {
				const r = view.races.find(x => x.job === make.look.job) || race;
				const span = r.hair.max - r.hair.min + 1;
				make.look.head = r.hair.min + ((make.look.head - r.hair.min + delta + span) % span);
				drawMaker();
			};
			screen.querySelector('.hair .prev').addEventListener('click', () => step(-1));
			screen.querySelector('.hair .next').addEventListener('click', () => step(1));
			const turn = delta => { direction = (direction + delta + 8) % 8; make.actor.place({ direction }); };
			screen.querySelector('.left').addEventListener('click', () => turn(1));
			screen.querySelector('.right').addEventListener('click', () => turn(-1));
			const name = screen.querySelector('.name');
			const create = () => view.create({ name: name.value.trim(), job: make.look.job, sex: make.look.sex,
				hair: make.look.head, hairColor: make.look.headpalette });
			screen.querySelector('.make').addEventListener('click', create);
			name.addEventListener('keydown', event => { if (event.key === 'Enter') create(); });
			screen.querySelector('.cancel').addEventListener('click', () => view.exit());
			name.focus();
			drawMaker();
		},
		update(view) { if (make) make.view = view; },
		hide() { make?.stage.dispose(); make = null; },
	});
}
