#!/usr/bin/env python3
"""Make the Discord Rich Presence pictures from the game's own files.

  map_<region>.png  each region's town minimap
  job_<line>.png    each job line's first job, standing, with a default head

Everything is fetched from the running app's asset server and saved as a
512x512 PNG named after its Discord art key, ready to upload under
Rich Presence -> Art Assets.

    python3 make-discord-art.py [output folder] [--port 3338]

Needs the app running (the asset server on :3338). The maps also need
ImageMagick (`magick` or `convert`); the jobs need nothing but Python.
"""
import os, shutil, struct, subprocess, sys, tempfile, urllib.parse, urllib.request, zlib

# Art key -> maps to try, first that exists wins. Keys match REGIONS in
# electron/discord-presence.js.
REGIONS = {
    'prontera': ['prontera'], 'izlude': ['izlude'], 'geffen': ['geffen'],
    'payon': ['payon'], 'morocc': ['morocc'], 'alberta': ['alberta'],
    'aldebaran': ['aldebaran'], 'comodo': ['comodo'], 'juno': ['yuno'],
    'einbroch': ['einbroch'], 'lighthalzen': ['lighthalzen'], 'rachel': ['rachel'],
    'veins': ['veins'], 'hugel': ['hugel'], 'glastheim': ['glast_01'],
    'niflheim': ['niflheim'], 'amatsu': ['amatsu'], 'gonryun': ['gonryun'],
    'louyang': ['louyang'], 'ayothaya': ['ayothaya'], 'umbala': ['umbala'],
    'moscovia': ['moscovia'], 'brasilis': ['brasilis'], 'dewata': ['dewata'],
    'malangdo': ['malangdo'], 'eclage': ['eclage'], 'splendide': ['splendide'],
    'guild': ['prtg_cas01', 'payg_cas01', 'gefg_cas01', 'aldeg_cas01'],
    'pvp': ['pvp_y_1-1', 'pvp_n_1-1', 'guild_vs1', 'prt_are_in'],
}
# Job line -> (race folder, body name, head number). The names are the
# client's own, in its CP949 bytes as roBrowser spells them (JobNameTable.js);
# head 2 is hairstyle 1 for humans (HairIndexTable.js).
HUMAN = '\xc0\xce\xb0\xa3\xc1\xb7'  # 인간족
DORAM = '\xb5\xb5\xb6\xf7\xc1\xb7'  # 도람족
JOBS = {
    'novice': (HUMAN, '\xC3\xCA\xBA\xB8\xC0\xDA', 2),
    'swordman': (HUMAN, '\xB0\xCB\xBB\xE7', 2),
    'mage': (HUMAN, '\xB8\xB6\xB9\xFD\xBB\xE7', 2),
    'archer': (HUMAN, '\xB1\xC3\xBC\xF6', 2),
    'acolyte': (HUMAN, '\xBC\xBA\xC1\xF7\xC0\xDA', 2),
    'merchant': (HUMAN, '\xBB\xF3\xC0\xCE', 2),
    'thief': (HUMAN, '\xB5\xB5\xB5\xCF', 2),
    'taekwon': (HUMAN, '\xc5\xc2\xb1\xc7\xbc\xd2\xb3\xe2', 2),
    'gunslinger': (HUMAN, '\xB0\xC7\xB3\xCA', 2),
    'ninja': (HUMAN, '\xB4\xD1\xC0\xDA', 2),
    'summoner': (DORAM, 'summoner', 1),
    'druid': (HUMAN, 'druid', 2),
}
MALE = '\xb3\xb2'                   # 남
BODY = '\xb8\xf6\xc5\xeb'          # 몸통
HEAD = '\xb8\xd3\xb8\xae\xc5\xeb'  # 머리통


def read_spr(data):
    if data[:2] != b'SP': raise ValueError('not a sprite')
    ver = data[3] + data[2] / 10
    off = 4
    n_pal, = struct.unpack_from('<H', data, off); off += 2
    n_rgba = 0
    if ver > 1.1:
        n_rgba, = struct.unpack_from('<H', data, off); off += 2
    frames = []
    for _ in range(n_pal):
        w, h = struct.unpack_from('<HH', data, off); off += 4
        if ver < 2.1:
            px = data[off:off + w * h]; off += w * h
        else:
            size, = struct.unpack_from('<H', data, off); off += 2
            end = off + size
            out = bytearray()
            while off < end:
                c = data[off]; off += 1
                out.append(c)
                if c == 0:
                    count = data[off]; off += 1
                    if count == 0: out.append(0)
                    else: out.extend(b'\0' * (count - 1))
            px = bytes(out[:w * h]).ljust(w * h, b'\0')
        frames.append(('pal', w, h, px))
    for _ in range(n_rgba):
        w, h = struct.unpack_from('<hh', data, off); off += 4
        frames.append(('rgba', w, h, data[off:off + w * h * 4])); off += w * h * 4
    pal = data[-1024:] if ver > 1.0 else bytes(1024)
    return {'frames': frames, 'rgba_index': n_pal, 'palette': pal}

def read_act(data):
    if data[:2] != b'AC': raise ValueError('not an action file')
    ver = data[3] + data[2] / 10
    off = 4
    n_actions, = struct.unpack_from('<H', data, off); off += 2 + 10
    actions = []
    for _ in range(n_actions):
        n_anim, = struct.unpack_from('<I', data, off); off += 4
        anims = []
        for _ in range(n_anim):
            off += 32
            n_layers, = struct.unpack_from('<I', data, off); off += 4
            layers = []
            for _ in range(n_layers):
                x, y, index, mirror = struct.unpack_from('<iiii', data, off); off += 16
                layer = {'x': x, 'y': y, 'index': index, 'mirror': mirror,
                         'color': (255, 255, 255, 255), 'sx': 1.0, 'sy': 1.0, 'angle': 0, 'type': 0}
                if ver >= 2.0:
                    layer['color'] = tuple(data[off:off + 4]); off += 4
                    layer['sx'], = struct.unpack_from('<f', data, off); off += 4
                    layer['sy'] = layer['sx']
                    if ver > 2.3:
                        layer['sy'], = struct.unpack_from('<f', data, off); off += 4
                    layer['angle'], layer['type'] = struct.unpack_from('<ii', data, off); off += 8
                    if ver >= 2.5: off += 8
                layers.append(layer)
            if ver >= 2.0: off += 4  # sound
            anchors = []
            if ver >= 2.3:
                n, = struct.unpack_from('<i', data, off); off += 4
                for _ in range(n):
                    ax, ay = struct.unpack_from('<ii', data, off + 4); off += 16
                    anchors.append((ax, ay))
            anims.append({'layers': layers, 'anchors': anchors})
        actions.append(anims)
    return actions

def frame_pixels(spr, layer):
    """RGBA rows of the sprite frame a layer points at, or None."""
    i = layer['index']
    if i < 0: return None
    if layer['type'] == 1: i += spr['rgba_index']
    if i >= len(spr['frames']): return None
    kind, w, h, px = spr['frames'][i]
    pal = spr['palette']
    out = bytearray(w * h * 4)
    if kind == 'pal':
        for p, c in enumerate(px):
            if c:
                out[p * 4:p * 4 + 4] = bytes((pal[c * 4], pal[c * 4 + 1], pal[c * 4 + 2], 255))
    else:
        for y in range(h):
            for x in range(w):
                s = (y * w + x) * 4
                a, b, g, r = px[s:s + 4]
                d = ((h - 1 - y) * w + x) * 4
                out[d:d + 4] = bytes((r, g, b, a))
    return w, h, out

class Canvas:
    def __init__(self, size=400):
        self.size = size
        self.px = bytearray(size * size * 4)

    def draw(self, spr, layer, ox, oy):
        got = frame_pixels(spr, layer)
        if not got: return
        w, h, src = got
        tint = layer['color']
        dw, dh = max(1, round(w * abs(layer['sx']))), max(1, round(h * abs(layer['sy'])))
        cx = self.size // 2 + layer['x'] + ox
        cy = self.size * 2 // 3 + layer['y'] + oy
        left, top = cx - dw // 2, cy - dh // 2
        for y in range(dh):
            sy = min(h - 1, int(y * h / dh))
            ty = top + y
            if not 0 <= ty < self.size: continue
            for x in range(dw):
                sx = min(w - 1, int(x * w / dw))
                if layer['mirror']: sx = w - 1 - sx
                tx = left + x
                if not 0 <= tx < self.size: continue
                s = (sy * w + sx) * 4
                a = src[s + 3] * tint[3] // 255
                if not a: continue
                d = (ty * self.size + tx) * 4
                for k in range(3):
                    c = src[s + k] * tint[k] // 255
                    self.px[d + k] = (c * a + self.px[d + k] * (255 - a)) // 255
                self.px[d + 3] = a + self.px[d + 3] * (255 - a) // 255

    def cropped_square(self, out_size=512, margin=0.08):
        n = self.size
        xs, ys = [], []
        for y in range(n):
            row = self.px[y * n * 4:(y + 1) * n * 4]
            for x in range(n):
                if row[x * 4 + 3]: xs.append(x); ys.append(y)
        if not xs: return None
        x0, x1, y0, y1 = min(xs), max(xs) + 1, min(ys), max(ys) + 1
        side = max(x1 - x0, y1 - y0)
        scale = max(1, int(out_size * (1 - 2 * margin) // side))
        out = bytearray(out_size * out_size * 4)
        ox = (out_size - (x1 - x0) * scale) // 2
        oy = (out_size - (y1 - y0) * scale) // 2
        for y in range(y0, y1):
            for x in range(x0, x1):
                s = (y * n + x) * 4
                if not self.px[s + 3]: continue
                pixel = self.px[s:s + 4]
                for dy in range(scale):
                    d = ((oy + (y - y0) * scale + dy) * out_size + ox + (x - x0) * scale) * 4
                    out[d:d + 4 * scale] = pixel * scale
        return out_size, out

def png(w, h, rgba):
    raw = b''.join(b'\0' + bytes(rgba[y * w * 4:(y + 1) * w * 4]) for y in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def job_picture(port, race, body, head):
    """The standing, front-facing first frame of a body with a head on it."""
    base = f'data/sprite/{race}'
    parts = []
    for path in (f'{base}/{BODY}/{MALE}/{body}_{MALE}', f'{base}/{HEAD}/{MALE}/{head}_{MALE}'):
        spr, act = fetch(port, path + '.spr'), fetch(port, path + '.act')
        if not spr or not act:
            return None
        parts.append((read_spr(spr), read_act(act)[0][0]))
    canvas = Canvas()
    (body_spr, body_frame), (head_spr, head_frame) = parts
    for layer in body_frame['layers']:
        canvas.draw(body_spr, layer, 0, 0)
    # The game puts the head's anchor on the body's.
    ox = oy = 0
    if body_frame['anchors'] and head_frame['anchors']:
        ox = body_frame['anchors'][0][0] - head_frame['anchors'][0][0]
        oy = body_frame['anchors'][0][1] - head_frame['anchors'][0][1]
    for layer in head_frame['layers']:
        canvas.draw(head_spr, layer, ox, oy)
    return canvas.cropped_square()

FOLDER = '유저인터페이스/map'  # "user interface", as the GRFs spell it

def fetch(port, path):
    url = f'http://127.0.0.1:{port}/' + urllib.parse.quote(path)
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            return r.read()
    except Exception:
        return None

def minimap(port, name):
    for folder in (FOLDER, FOLDER.encode('cp949').decode('latin-1')):
        data = fetch(port, f'data/texture/{folder}/{name}.bmp')
        if data:
            return data
    return None

def main():
    args = sys.argv[1:]
    port = 3338
    if '--port' in args:
        i = args.index('--port'); port = int(args[i + 1]); del args[i:i + 2]
    out = os.path.expanduser(args[0] if args else '~/Pictures/discord-art')
    magick = shutil.which('magick') or shutil.which('convert')
    if not magick:
        sys.exit('ImageMagick is missing: sudo pacman -S imagemagick')
    if fetch(port, 'api/health') is None:
        sys.exit(f'Nothing answered on port {port}. Is Ragnarok Offline running?')
    os.makedirs(out, exist_ok=True)
    missing = []
    with tempfile.TemporaryDirectory() as tmp:
        for key, maps in REGIONS.items():
            for name in maps:
                data = minimap(port, name)
                if data:
                    src = os.path.join(tmp, name + '.bmp')
                    with open(src, 'wb') as f:
                        f.write(data)
                    dst = os.path.join(out, f'map_{key}.png')
                    # Magenta is the game's "see-through" colour.
                    subprocess.run([magick, src, '-fuzz', '2%', '-transparent', '#ff00ff',
                                    '-resize', '512x512', '-background', 'none',
                                    '-gravity', 'center', '-extent', '512x512', dst], check=True)
                    print(f'map_{key}.png  <- {name}')
                    break
            else:
                missing.append('map_' + key)
    for key, (race, body, head) in JOBS.items():
        try:
            got = job_picture(port, race, body, head)
        except Exception as e:
            got = None
            print(f'job_{key}: could not read its sprite ({e})')
        if got:
            size, rgba = got
            with open(os.path.join(out, f'job_{key}.png'), 'wb') as f:
                f.write(png(size, size, rgba))
            print(f'job_{key}.png')
        else:
            missing.append('job_' + key)
    total = len(REGIONS) + len(JOBS)
    print(f'\nSaved {total - len(missing)} of {total} pictures in {out}')
    if missing:
        print('Not found: ' + ', '.join(missing))

if __name__ == '__main__':
    main()
