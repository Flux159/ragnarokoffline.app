'use strict';
// The login window's Google/Apple buttons (patches/client/SignIn.mjs), against
// a stand-in DOM. Unit contract only: the built client is not run here.
const { test } = require('node:test');
const assert = require('node:assert/strict');

class Element {
    constructor(tag, className = '', id = '') { Object.assign(this, { tag, className, id, children: [], style: {}, listeners: {}, value: '', textContent: '', disabled: false }); }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    click() { for (const fn of this.listeners.click || []) fn({ stopImmediatePropagation() {} }); }
    get firstElementChild() { return this.children[0] || null; }
    all() { return [this, ...this.children.flatMap(c => c.all())]; }
    querySelector(selector) {
        return this.all().slice(1).find(node => selector.startsWith('#') ? node.id === selector.slice(1) : node.className === selector.slice(1)) || null;
    }
}

function loginWindow() {
    const root = new Element('shadow'), win = new Element('div', 'win_login', 'WinLogin');
    const user = new Element('input', 'user'), pass = new Element('input', 'pass'), connect = new Element('button', 'connect');
    const submitted = [];
    connect.addEventListener('click', () => submitted.push([user.value, pass.value]));
    win.append(user, pass, connect); root.append(win);
    return { root, win, user, pass, submitted };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 10));

test('the login window gets sign-in buttons only where the friend gateway says sign-in is on', async () => {
    globalThis.document = { createElement: tag => new Element(tag) };
    globalThis.getComputedStyle = node => ({ position: node.style.position || 'absolute' });
    const calls = [];
    let status = { status: 404, body: {} };
    globalThis.fetch = async (url, options = {}) => {
        calls.push([url, options.method || 'GET']);
        const answer = url.endsWith('/token') ? { status: 200, body: { username: 'new_friend', token: '~AbCdEfGhIjKlMnOpQrStUv' } } : status;
        return { ok: answer.status === 200, json: async () => answer.body };
    };
    const navigations = [];
    globalThis.location = { set href(value) { navigations.push(value); } };
    const { default: Runtime } = await import('../patches/client/ExtensionRuntime.mjs');
    const { install } = await import('../patches/client/SignIn.mjs');
    install();
    const open = name => { const view = loginWindow(); Runtime.appendComponent({ name, getRoot: () => view.root, _host: {} }); return view; };

    // The host's own window, or a host with no keys: nothing added.
    let view = open('WinLogin');
    await settle();
    assert.equal(view.root.querySelector('.ro-sign-in'), null);
    status = { status: 200, body: { enabled: false } };
    view = open('WinLoginV3'); await settle();
    assert.equal(view.root.querySelector('.ro-sign-in'), null);
    // Other windows are never touched.
    status = { status: 200, body: { enabled: true, providers: ['google', 'apple'], signedIn: false } };
    const before = calls.length;
    open('CharSelect'); await settle();
    assert.equal(calls.length, before);

    // Not signed in: one button per provider, each a navigation to the gateway.
    view = open('WinLoginV2'); await settle();
    const panel = view.root.querySelector('.ro-sign-in');
    assert.deepEqual(panel.children.map(b => b.textContent), ['Sign in with Google', 'Sign in with Apple']);
    panel.children[1].click();
    assert.deepEqual(navigations, ['/_friend/sign-in/start?provider=apple']);

    // Signed in: Continue fetches a one-time token and submits it like Connect,
    // and does not leave it in the field afterwards.
    status = { status: 200, body: { enabled: true, providers: ['google'], signedIn: true, needsAccount: false, email: 'friend@example.com', username: 'new_friend' } };
    view = open('WinLoginV3'); await settle();
    const button = view.root.querySelector('.ro-sign-in').children[0];
    assert.equal(button.textContent, 'Continue as friend@example.com');
    button.click(); await settle();
    assert.deepEqual(view.submitted, [['new_friend', '~AbCdEfGhIjKlMnOpQrStUv']]);
    assert.equal(view.pass.value, '');
    assert.deepEqual(calls.at(-1), ['/_friend/sign-in/token', 'POST']);

    // Reopened after signing out: the old panel is replaced, not stacked.
    status = { status: 200, body: { enabled: true, providers: ['google'], signedIn: false } };
    Runtime.appendComponent({ name: 'WinLoginV3', getRoot: () => view.root, _host: {} }); await settle();
    const panels = view.root.all().filter(node => node.className === 'ro-sign-in');
    assert.equal(panels.length, 1);
    assert.equal(panels[0].children[0].textContent, 'Sign in with Google');
});
