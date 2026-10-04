#!/usr/bin/env python3
"""Make the Basic Information menu scroll instead of overflowing its frame.

Both BasicInfoV4 and BasicInfoV5 draw their shortcut grid in a panel made for
fifteen buttons: three rows of 32px buttons with 6px margins, five to a row,
over a frame 132px tall. The Companions button we add (patch-client.sh) is one
more than the panel was drawn for, and every mod that adds a button pushes it
further. In V5 the last button -- Reputation Status -- wrapped onto a fourth row
below the panel and its frame (#390); V4 grew past its artwork the same way.

The panel keeps its size and scrolls, with the client's own scrollbar, which
attaches itself to any element that is overflow-y:auto and takes its width out
of the panel only while there is something to scroll. Fifteen buttons or fewer
look exactly as before.

V4 also gets the Reputation Status button V5 has. Its markup had that button
commented out, so a character that is not a fourth class -- who is given V4 --
could earn reputation but had no way to open the window. Any job can: the
server stores a score as a plain character variable and sends it at login.

A button's name used to be drawn inside the button, above it. A scrolling panel
clips that, so it is drawn once, centred below the frame, where nothing clips it.
"""
from pathlib import Path
import sys

rb = Path(sys.argv[1])

CSS_MARK = '/* Ragnarok Offline: the menu scrolls */'
JS_MARK = '// Ragnarok Offline: the menu scrolls'

# Per version: the markup of a button, the rule that lays the panel out, where
# the panel sits (large and small window), and the grid-only lines V4 needs.
VERSIONS = {
    'BasicInfoV5': {
        'button': 'div',
        'panel_old': ['\tposition: absolute;', '\tleft: 0px;', '\ttop: 9px;', '\twidth: 220px;', '\theight: 132px;'],
        'panel_new': ['\theight: 132px;', '\toverflow-x: hidden;', '\toverflow-y: auto;'],
        'panel_top': {'large': 160, 'small': 80},
        # V5 puts the new-item mark on Inventory 13px up and 7px left of its button.
        'overlay': True,
    },
    'BasicInfoV4': {
        'button': 'button',
        # A grid, so its rows would stretch to fill a panel taller than they are.
        'panel_old': ['\tposition: absolute;', '\tleft: 0px;', '\ttop: 9px;', '\twidth: 220px;', '\tdisplay: grid;'],
        'panel_new': ['\theight: 132px;', '\toverflow-x: hidden;', '\toverflow-y: auto;', '\talign-content: start;'],
        'panel_top': {'large': 144, 'small': 62},
    },
}
PANEL_HEIGHT = 132
TIP_GAP = 4


def read(path):
    # newline='' keeps the file's own line endings (the fork's files are CRLF).
    with path.open(newline='') as f:
        text = f.read()
    return text, '\r\n' if '\r\n' in text else '\n'


def write(path, text):
    with path.open('w', newline='') as f:
        f.write(text)


def lines(eol, *rows):
    return eol.join(rows) + eol


def patch_css(path, name, spec):
    css, eol = read(path)
    if CSS_MARK in css:
        print(f'{path.name}: menu already scrolls')
        return
    head = f'#{name} .buttons {{'
    old = lines(eol, head, *spec['panel_old'])
    if css.count(old) != 1:
        sys.exit(f'{path.name}: the .buttons block no longer matches (found {css.count(old)}); re-check the patch')
    # V5 already has the height; V4 does not, and its block is replaced whole.
    if spec['panel_new'][0] == spec['panel_old'][-1]:
        new = lines(eol, head, *spec['panel_old'], *spec['panel_new'][1:])
    else:
        new = lines(eol, head, *spec['panel_old'], *spec['panel_new'])
    css = css.replace(old, new, 1)

    child = f"{spec['button']}[id]"
    top = spec['panel_top']
    css += eol + lines(
        eol,
        CSS_MARK,
        '/* The scrollbar takes 13px of the panel only while it scrolls. Five buttons',
        '   still fit in what is left if their side margins give up 2px each. */',
        f"#{name} .buttons[style*='padding-right: 13px'] > {child} {{",
        '\tmargin: 6px 4px;',
        '}',
        '',
        '/* Names are drawn below the frame, not inside the button, so a scrolling',
        '   panel cannot clip them. */',
        f"#{name} .buttons {spec['button']}:hover .name {{",
        '\tdisplay: none;',
        '}',
        f'#{name} .menu_tip {{',
        '\tdisplay: none;',
        '\tposition: absolute;',
        '\tleft: 110px;',
        '\ttransform: translateX(-50%);',
        '\tz-index: 10;',
        '\tpointer-events: none;',
        '\tbackground-color: rgba(0, 0, 0, 0.6);',
        '\ttext-shadow: 1px 1px black;',
        '\tcolor: white;',
        '\tpadding: 5px;',
        '\twhite-space: nowrap;',
        '\tfont-size: 0.6rem;',
        '}',
        f"#{name}.large .menu_tip {{",
        f"\ttop: {top['large'] + PANEL_HEIGHT + TIP_GAP}px; /* the panel is at {top['large']}px, {PANEL_HEIGHT}px tall */",
        '}',
        f"#{name}.small .menu_tip {{",
        f"\ttop: {top['small'] + PANEL_HEIGHT + TIP_GAP}px; /* the panel is at {top['small']}px, {PANEL_HEIGHT}px tall */",
        '}',
    )
    write(path, css)
    print(f'{path.name}: menu now scrolls')


OVERLAY_MARK = '/* The new-item mark on the Inventory button'


def patch_overlay(path, name, spec):
    """Put V5's new-item mark where V4 does, over the button it marks."""
    if not spec.get('overlay'):
        return
    css, eol = read(path)
    if OVERLAY_MARK in css:
        print(f'{path.name}: new-item mark already over its button')
        return
    css += eol + lines(
        eol,
        OVERLAY_MARK + ' is a 35x40 picture whose tile starts 6px below its top',
        '   and flush left. V5 placed it 13px up and 7px left, so it hung up and to the left of',
        '   the button it marks, and past the top of the panel, where a scrolling panel clips it.',
        '   V4 places the same picture at these offsets. */',
        f'#{name} .buttons .btn_overlay {{',
        '\ttop: -6px;',
        '\tleft: 0;',
        '}',
    )
    write(path, css)
    print(f'{path.name}: new-item mark now over its button')


def patch_js(path, name, spec):
    js, eol = read(path)
    if JS_MARK in js:
        print(f'{path.name}: menu names already drawn below the frame')
        return
    anchor = 'export default createBasicInfo({'
    if js.count(anchor) != 1:
        sys.exit(f'{path.name}: createBasicInfo export no longer matches (found {js.count(anchor)}); re-check the patch')
    js = js.replace(anchor, f'const {name} = createBasicInfo({{', 1)
    js = js.rstrip() + eol + eol + lines(
        eol,
        JS_MARK,
        '// A scrolling panel clips the name each button drew above itself, so one is drawn',
        '// below the frame instead, centred, from whichever button the pointer is on (#390).',
        f'const createdInit = {name}.init;',
        f'{name}.init = function init() {{',
        '\tcreatedInit.call(this);',
        '\tconst root = this.getRoot();',
        f"\tconst inner = root.querySelector('#{name}');",
        "\tconst buttons = root.querySelector('.buttons');",
        '\tif (!inner || !buttons) {',
        '\t\treturn;',
        '\t}',
        "\tconst tip = document.createElement('div');",
        "\ttip.className = 'menu_tip';",
        '\tinner.appendChild(tip);',
        '\tconst hide = () => {',
        "\t\ttip.style.display = 'none';",
        '\t};',
        "\tbuttons.addEventListener('mouseover', event => {",
        f"\t\tconst button = event.target.closest('.buttons > {spec['button']}[id]');",
        "\t\tconst name = button && button.querySelector('.name');",
        '\t\tif (!name || !name.textContent.trim()) {',
        '\t\t\thide();',
        '\t\t\treturn;',
        '\t\t}',
        '\t\ttip.textContent = name.textContent;',
        "\t\ttip.style.display = 'block';",
        '\t});',
        "\tbuttons.addEventListener('mouseleave', hide);",
        "\tbuttons.addEventListener('scroll', hide);",
        '};',
        '',
        f'export default {name};',
    )
    write(path, js)
    print(f'{path.name}: menu names now drawn below the frame')


REPUTE_COMMENT = '<!--<button class="reputation" data-background="menu_icon/" data-hover="menu_icon/" data-down="menu_icon/"></button> -->'


def patch_html(path):
    """Give V4 the Reputation Status button V5 has."""
    html, eol = read(path)
    if 'id="repute"' in html:
        print(f'{path.name}: already has the Reputation Status button')
        return
    if html.count(REPUTE_COMMENT) != 1:
        sys.exit(f'{path.name}: the commented-out reputation button no longer matches (found {html.count(REPUTE_COMMENT)}); re-check the patch')
    line = next(l for l in html.split(eol) if REPUTE_COMMENT in l)
    indent = line[: len(line) - len(line.lstrip())]
    button = lines(
        eol,
        f'{indent}<button',
        f'{indent}\tid="repute"',
        f'{indent}\tclass="event_add_cursor"',
        f'{indent}\tdata-background="menu_icon/bt_repute.bmp"',
        f'{indent}\tdata-down="menu_icon/bt_repute_press.bmp"',
        f'{indent}>',
        f'{indent}\t<span class="name">Reputation Status</span>',
        f'{indent}</button>',
    ).rstrip(eol)
    write(path, html.replace(line, button, 1))
    print(f'{path.name}: added the Reputation Status button')


for name, spec in VERSIONS.items():
    folder = rb / 'src/UI/Components/BasicInfo' / name
    css_path, js_path = folder / f'{name}.css', folder / f'{name}.js'
    if not css_path.exists() or not js_path.exists():
        print(f'{name}: not in this checkout, skipped')
        continue
    patch_css(css_path, name, spec)
    patch_overlay(css_path, name, spec)
    patch_js(js_path, name, spec)
    html_path = folder / f'{name}.html'
    if name == 'BasicInfoV4' and html_path.exists():
        patch_html(html_path)
