#!/usr/bin/env python3
"""Compile and raster the real RIC screen translation units on the host.

No network, embedded build, device access, source rewrites, Pillow or browser fonts.
Generated TFT methods come from the installed dependency, with tracing and the
necessary 64-bit host pointer adaptation, not independently redrawn screen art.
"""
import argparse
import hashlib
import html
import io
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import struct
import subprocess
import sys
import tarfile
import tempfile
import zlib

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
SOURCE_REL = Path('firmware/esp32-pos/src')
SOURCES = ['screens/PaymentScreen.cpp', 'screens/PinScreen.cpp', 'ui/Numpad.cpp']


def run(command, *, cwd=ROOT):
    result = subprocess.run([str(x) for x in command], cwd=cwd, capture_output=True, text=True, timeout=150)
    if result.returncode:
        raise RuntimeError(f"{shlex.join([str(x) for x in command])}\n{result.stdout}{result.stderr}")
    return result


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def import_method(source, signature, injection=''):
    """Installed TFT methods use a column-zero closing brace. Fail on drift."""
    needle = signature + '\n{'
    if source.count(needle) != 1:
        raise RuntimeError('Cannot uniquely import installed TFT method: ' + signature)
    start = source.index(needle)
    end = source.index('\n}', start) + 2
    result = source[start:end]
    if injection:
        result = result.replace('\n{', '\n{\n  ' + injection, 1)
    return result


def generate_tft(tft, build):
    source_path = tft / 'TFT_eSPI.cpp'
    source = source_path.read_text()
    selections = [
        ('void TFT_eSPI::drawCircle(int32_t x0, int32_t y0, int32_t r, uint32_t color)',
         'TraceScope _trace(*this, "drawCircle", x0-r, y0-r, 2*r+1, 2*r+1, color);'),
        ('void TFT_eSPI::drawCircleHelper( int32_t x0, int32_t y0, int32_t rr, uint8_t cornername, uint32_t color)', ''),
        ('void TFT_eSPI::fillCircle(int32_t x0, int32_t y0, int32_t r, uint32_t color)',
         'TraceScope _trace(*this, "fillCircle", x0-r, y0-r, 2*r+1, 2*r+1, color);'),
        ('void TFT_eSPI::fillCircleHelper(int32_t x0, int32_t y0, int32_t r, uint8_t cornername, int32_t delta, uint32_t color)', ''),
        ('void TFT_eSPI::drawRect(int32_t x, int32_t y, int32_t w, int32_t h, uint32_t color)',
         'TraceScope _trace(*this, "drawRect", x, y, w, h, color);'),
        ('void TFT_eSPI::drawRoundRect(int32_t x, int32_t y, int32_t w, int32_t h, int32_t r, uint32_t color)',
         'TraceScope _trace(*this, "drawRoundRect", x, y, w, h, color);'),
        ('void TFT_eSPI::fillRoundRect(int32_t x, int32_t y, int32_t w, int32_t h, int32_t r, uint32_t color)',
         'TraceScope _trace(*this, "fillRoundRect", x, y, w, h, color);'),
        ('void TFT_eSPI::drawLine(int32_t x0, int32_t y0, int32_t x1, int32_t y1, uint32_t color)',
         'TraceScope _trace(*this, "drawLine", min(x0,x1), min(y0,y1), abs(x1-x0)+1, abs(y1-y0)+1, color);'),
        ('void TFT_eSPI::drawTriangle(int32_t x0, int32_t y0, int32_t x1, int32_t y1, int32_t x2, int32_t y2, uint32_t color)',
         'TraceScope _trace(*this, "drawTriangle", min({x0,x1,x2}), min({y0,y1,y2}), max({x0,x1,x2})-min({x0,x1,x2})+1, max({y0,y1,y2})-min({y0,y1,y2})+1, color);'),
        ('void TFT_eSPI::fillTriangle ( int32_t x0, int32_t y0, int32_t x1, int32_t y1, int32_t x2, int32_t y2, uint32_t color)',
         'TraceScope _trace(*this, "fillTriangle", min({x0,x1,x2}), min({y0,y1,y2}), max({x0,x1,x2})-min({x0,x1,x2})+1, max({y0,y1,y2})-min({y0,y1,y2})+1, color);'),
        ('int16_t TFT_eSPI::textWidth(const char *string, uint8_t font)', ''),
        ('int16_t TFT_eSPI::fontHeight(int16_t font)', ''),
        ('uint16_t TFT_eSPI::decodeUTF8(uint8_t *buf, uint16_t *index, uint16_t remaining)', ''),
        ('int16_t TFT_eSPI::drawChar(uint16_t uniCode, int32_t x, int32_t y, uint8_t font)', ''),
        ('int16_t TFT_eSPI::drawString(const char *string, int32_t poX, int32_t poY, uint8_t font)',
         'TraceScope _trace(*this);'),
    ]
    preamble = '''// Generated from installed TFT_eSPI. See dependency-license.txt.
#include <TFT_eSPI.h>
#define LOAD_FONT2
#define LOAD_RLE
#define transpose(a,b) std::swap(a,b)
#include <Fonts/Font16.h>
#include <Fonts/Font32rle.h>
#include <Fonts/Font64rle.h>
struct FontInfo {
  const unsigned char* const* chartbl;
  const unsigned char* widthtbl;
  uint8_t height, baseline;
};
static const FontInfo fontdata[9] = {
  {nullptr,nullptr,0,0}, {nullptr,nullptr,0,0},
  {chrtbl_f16,widtbl_f16,chr_hgt_f16,baseline_f16}, {nullptr,nullptr,0,0},
  {chrtbl_f32,widtbl_f32,chr_hgt_f32,baseline_f32}, {nullptr,nullptr,0,0},
  {chrtbl_f64,widtbl_f64,chr_hgt_f64,baseline_f64},
  {nullptr,nullptr,0,0}, {nullptr,nullptr,0,0}
};
'''
    methods = []
    manifest = []
    for signature, injection in selections:
        original = import_method(source, signature)
        method = import_method(source, signature, injection)
        if 'TFT_eSPI::drawChar' in signature:
            old = 'uint32_t flash_address = 0;'
            if method.count(old) != 1:
                raise RuntimeError('Installed TFT flash-pointer representation changed')
            method = method.replace(old, 'uintptr_t flash_address = 0;')
        if 'TFT_eSPI::drawString' in signature:
            marker = '  int8_t xo = 0;'
            if method.count(marker) != 1:
                raise RuntimeError('Installed TFT datum calculation changed')
            method = method.replace(marker, '  _trace.text(string, poX, poY, cwidth, cheight, font);\n' + marker)
        methods.append(method)
        manifest.append({'signature': signature, 'sha256': hashlib.sha256(original.encode()).hexdigest()})
    generated = build / 'tft-software.cpp'
    generated.write_text(preamble + '\n\n'.join(methods) + '\n')
    shutil.copyfile(tft / 'license.txt', build / 'dependency-license.txt')
    return generated, manifest


def source_root(revision, build):
    if not revision:
        return ROOT / SOURCE_REL, None
    commit = run(['git', 'rev-parse', '--verify', revision + '^{commit}']).stdout.strip()
    archive = subprocess.run(['git', 'archive', commit, str(SOURCE_REL)], cwd=ROOT,
                             capture_output=True, check=True, timeout=30).stdout
    destination = build / 'revision'
    destination.mkdir()
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        for member in tar.getmembers():
            target = destination / member.name
            if not target.resolve().is_relative_to(destination.resolve()) or member.issym() or member.islnk():
                raise RuntimeError('Unsafe source archive entry: ' + member.name)
        tar.extractall(destination)
    return destination / SOURCE_REL, commit


def read_ppm(path):
    with path.open('rb') as stream:
        if stream.readline() != b'P6\n':
            raise ValueError('Expected P6 host framebuffer')
        width, height = map(int, stream.readline().split())
        if stream.readline() != b'255\n':
            raise ValueError('Expected 8-bit RGB')
        pixels = stream.read()
    if len(pixels) != width * height * 3:
        raise ValueError('Truncated host framebuffer')
    return width, height, pixels


def png_bytes(width, height, pixels):
    def chunk(name, data):
        return struct.pack('>I', len(data)) + name + data + struct.pack('>I', zlib.crc32(name + data) & 0xffffffff)
    rows = b''.join(b'\0' + pixels[y * width * 3:(y + 1) * width * 3] for y in range(height))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(rows, 9)) + chunk(b'IEND', b''))


def export_svg(width, height, pixels, operations, label):
    # Row runs are actual framebuffer pixels, not browser text or substitute art.
    colors = {}
    for y in range(height):
        x = 0
        while x < width:
            color = pixels[(y * width + x) * 3:(y * width + x) * 3 + 3]
            end = x + 1
            while end < width and pixels[(y * width + end) * 3:(y * width + end) * 3 + 3] == color:
                end += 1
            colors.setdefault(color.hex(), []).append(f'M{x},{y}h{end-x}v1h-{end-x}z')
            x = end
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
             f'<title>{html.escape(label)}: actual host-rasterized TFT output</title>',
             '<g id="framebuffer" shape-rendering="crispEdges">']
    for color, runs in colors.items():
        parts.append(f'<path fill="#{color}" d="{"".join(runs)}"/>')
    parts.append('</g><g id="text-bounds" fill="none" stroke="#00ffff" stroke-width="0.5" style="display:none">')
    for op in operations:
        if op['kind'] != 'text':
            continue
        rect = op['rect']
        parts.append(f'<rect x="{rect["x"]}" y="{rect["y"]}" width="{rect["w"]}" height="{rect["h"]}"><title>{html.escape(op["text"])}</title></rect>')
    parts.append('</g></svg>\n')
    return ''.join(parts)


def intersection(a, b):
    x, y = max(a['x'], b['x']), max(a['y'], b['y'])
    right, bottom = min(a['x'] + a['w'], b['x'] + b['w']), min(a['y'] + a['h'], b['y'] + b['h'])
    return {'x': x, 'y': y, 'w': right - x, 'h': bottom - y} if right > x and bottom > y else None


def layout_metrics(trace):
    texts = [op for op in trace['operations'] if op['kind'] == 'text' and op['text'].strip()]
    overlaps = []
    for i, left in enumerate(texts):
        for right in texts[i + 1:]:
            overlap = intersection(left['rect'], right['rect'])
            if overlap:
                overlaps.append({'texts': [left['text'], right['text']], 'intersection': overlap})
    clipped = [op for op in texts if op['rect']['x'] < 0 or op['rect']['y'] < 0 or
               op['rect']['x'] + op['rect']['w'] > trace['width'] or op['rect']['y'] + op['rect']['h'] > trace['height']]
    occluded = [op for op in texts if op['visibleInkPixels'] < op['inkPixels']]
    return {'textOverlaps': overlaps, 'clippedText': clipped, 'occludedText': occluded, 'textCount': len(texts)}


def qr_metrics(trace, width, height, pixels):
    qr = trace['qr']
    if not qr['size']:
        return None
    # The linker observes each real qrcode_getModule query and associates the
    # next fillRect with its encoded (column,row). No color/rectangle guess,
    # no requirement that the firmware explicitly paints white modules.
    modules = [op for op in trace['operations'] if 'qrModule' in op]
    if not modules:
        return {'error': 'encoder succeeded but no query-linked QR paint found'}
    module = modules[0]['rect']['w']
    origins = set()
    for op in modules:
        rect, cell = op['rect'], op['qrModule']
        if module <= 0 or rect['w'] != module or rect['h'] != module:
            return {'error': 'rendered QR modules have inconsistent/non-square dimensions'}
        if not (0 <= cell['x'] < qr['size'] and 0 <= cell['y'] < qr['size']):
            return {'error': 'rendered QR module queried outside the encoded grid'}
        origins.add((rect['x'] - cell['x'] * module, rect['y'] - cell['y'] * module))
    if len(origins) != 1:
        return {'error': 'rendered QR query coordinates do not form one uniform grid'}
    x0, y0 = origins.pop()
    size = qr['size'] * module

    def pixel(x, y):
        if x < 0 or y < 0 or x >= width or y >= height:
            return None
        start = (y * width + x) * 3
        return pixels[start:start + 3]

    mismatches = 0
    for row in range(qr['size']):
        for col in range(qr['size']):
            expected = b'\0\0\0' if qr['modules'][row * qr['size'] + col] == '1' else b'\xff\xff\xff'
            for dy in range(module):
                for dx in range(module):
                    mismatches += pixel(x0 + col * module + dx, y0 + row * module + dy) != expected
    quiet = module * 4
    bad, examples = 0, []
    for y in range(y0 - quiet, y0 + size + quiet):
        for x in range(x0 - quiet, x0 + size + quiet):
            if x0 <= x < x0 + size and y0 <= y < y0 + size:
                continue
            if pixel(x, y) != b'\xff\xff\xff':
                bad += 1
                if len(examples) < 12:
                    examples.append({'x': x, 'y': y})
    bounds = {'x': x0 - quiet, 'y': y0 - quiet, 'w': size + 2 * quiet, 'h': size + 2 * quiet}
    overlaps = [{'text': op['text'], 'intersection': intersection(bounds, op['rect'])}
                for op in trace['operations'] if op['kind'] == 'text' and intersection(bounds, op['rect'])]
    return {'version': qr['version'], 'modules': qr['size'], 'modulePx': module,
            'dataRect': {'x': x0, 'y': y0, 'w': size, 'h': size}, 'requiredQuietRect': bounds,
            'quietZoneModules': 4, 'quietZonePixels': quiet, 'nonWhiteQuietPixels': bad,
            'nonWhiteExamples': examples, 'dataPixelMismatches': mismatches, 'textOverlaps': overlaps}


def independent_font_check(tft, trace, width, pixels):
    # Independent tiny decoders for one glyph in each installed data format.
    # These validate the adapter path against raw resource bytes, not itself.
    checks = []
    for font, file, symbol, x0, y0, w, h in [
        (2, 'Font16.c', 'chr_f16_30', 10, 10, 8, 16),
        (4, 'Font32rle.c', 'chr_f32_30', 40, 10, 14, 26),
    ]:
        content = re.sub(r'//[^\n]*', '', (tft / 'Fonts' / file).read_text())
        match = re.search(r'\b' + symbol + r'\[[^\]]*\]\s*=\s*\{(.*?)\};', content, re.S)
        if not match:
            raise RuntimeError('Cannot independently decode installed font glyph ' + symbol)
        body = re.sub(r'//[^\n]*', '', match[1])
        data = [int(value, 16) for value in re.findall(r'0x[0-9a-fA-F]+', body)]
        expected = []
        if font == 2:
            row_bytes = (w + 6) // 8
            for y in range(h):
                for x in range(w):
                    expected.append(bool(data[y * row_bytes + x // 8] & (0x80 >> (x % 8))) if x < row_bytes * 8 else False)
        else:
            for value in data:
                expected.extend([bool(value & 128)] * ((value & 127) + 1))
        if len(expected) != w * h:
            raise RuntimeError('Independent glyph decoder length mismatch')
        mismatches = 0
        for i, lit in enumerate(expected):
            p = ((y0 + i // w) * width + x0 + i % w) * 3
            mismatches += pixels[p:p + 3] != (b'\xff\xff\xff' if lit else b'\0\0\0')
        checks.append({'font': font, 'resource': str(tft / 'Fonts' / file), 'glyph': '0',
                       'pixels': len(expected), 'inkPixels': sum(expected), 'pixelMismatches': mismatches})
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=Path(os.environ.get('RIC_DISPLAY_OUT', '/home/kongzi/.hermes/ric-review/render')))
    parser.add_argument('--revision', default=os.environ.get('RIC_DISPLAY_REVISION'), help='Render real source from a git commit, without checkout or edits')
    parser.add_argument('--deps', type=Path, default=ROOT / 'firmware/esp32-pos/.pio/libdeps/esp32dev')
    args = parser.parse_args()
    out = args.out.resolve(); out.mkdir(parents=True, exist_ok=True)
    (HERE / '.build').mkdir(exist_ok=True)
    build = Path(tempfile.mkdtemp(prefix='host-', dir=HERE / '.build'))
    src, revision = source_root(args.revision, build)
    tft, qr = args.deps / 'TFT_eSPI', args.deps / 'QRCode/src'
    required = [src / p for p in SOURCES] + [tft / 'TFT_eSPI.cpp', qr / 'qrcode.c', qr / 'qrcode.h']
    required += [tft / 'Fonts' / p for p in ['Font16.h', 'Font16.c', 'Font32rle.h', 'Font32rle.c', 'Font64rle.h', 'Font64rle.c']]
    for path in required:
        if not path.is_file():
            raise RuntimeError(f'Missing prerequisite: {path}. Install the project PlatformIO dependencies first; no fake fonts/QR fallback is allowed.')
    # Follow only includes reachable from the translation units being compiled.
    # Unrelated worker/API/OTA/NFC/Journal edits must not invalidate a UI render.
    generated, methods = generate_tft(tft, build)
    include_roots = [HERE / 'adapters', src, qr, tft]
    pending = required + [HERE / 'host.cpp', HERE / 'main.cpp', generated, Path(__file__)]
    watched = set()
    while pending:
        path = pending.pop().resolve()
        if path in watched:
            continue
        watched.add(path)
        if path.suffix not in ('.c', '.cpp', '.h'):
            continue
        for quote, include in re.findall(r'^\s*#\s*include\s*([<"])([^>"\n]+)[>"]', path.read_text(), re.M):
            roots = ([path.parent] if quote == '"' else []) + include_roots
            for directory in roots:
                dependency = directory / include
                if dependency.is_file():
                    pending.append(dependency)
                    break
    hashes = {str(path): sha(path) for path in sorted(watched)}
    commands = [
        ['gcc', '-std=c99', '-O2', '-I', qr, '-c', qr / 'qrcode.c', '-o', build / 'qrcode.o'],
        ['g++', '-std=c++17', '-O2', '-Wall', '-Wextra', '-Wno-sign-compare',
         '-I', HERE / 'adapters', '-I', src, '-I', qr, '-I', tft,
         HERE / 'host.cpp', generated, HERE / 'main.cpp', *[src / p for p in SOURCES],
         build / 'qrcode.o', '-Wl,--wrap=qrcode_initText', '-Wl,--wrap=qrcode_getModule',
         '-o', build / 'ric-display-host'],
    ]
    logs = []
    for command in commands:
        result = run(command)
        logs.append('$ ' + shlex.join([str(x) for x in command]) + '\n' + result.stdout + result.stderr)
    for path, digest in hashes.items():
        if sha(Path(path)) != digest:
            raise RuntimeError(f'Source/dependency changed during compile: {path}. Rerun for a consistent render.')
    result = run([build / 'ric-display-host', out])
    logs.append(result.stdout + result.stderr)
    (out / 'build.log').write_text('\n'.join(logs))
    native = json.loads((out / 'native.json').read_text())
    scenes = {}
    for name in native['scenes']:
        trace = json.loads((out / (name + '.json')).read_text())
        width, height, pixels = read_ppm(out / (name + '.ppm'))
        (out / (name + '.png')).write_bytes(png_bytes(width, height, pixels))
        (out / (name + '.svg')).write_text(export_svg(width, height, pixels, trace['operations'], name))
        scenes[name] = {'png': str(out / (name + '.png')), 'ppm': str(out / (name + '.ppm')),
                        'svg': str(out / (name + '.svg')), 'trace': str(out / (name + '.json')),
                        'layout': layout_metrics(trace), 'qr': qr_metrics(trace, width, height, pixels)}
    # Keep the dense acceptance case, but isolate a known unsafe library call
    # so its crash is reported without losing every baseline canvas.
    dense_command = [str(build / 'ric-display-host'), str(out), '--dense', '1050']
    dense_log = out / 'dense-render.log'
    try:
        dense_result = subprocess.run(dense_command, cwd=ROOT, capture_output=True, text=True, timeout=20)
        dense_code = dense_result.returncode
        dense_output = dense_result.stdout + dense_result.stderr
    except subprocess.TimeoutExpired as error:
        dense_code = 124
        dense_output = 'Dense render timed out after 20 seconds\n' + str(error)
    dense_log.write_text('$ ' + shlex.join(dense_command) + '\nexitCode=' + str(dense_code) + '\n' + dense_output)
    dense = {'payloadLength': 1050, 'returnCode': dense_code, 'log': str(dense_log), 'qr': None}
    if dense_code == 0:
        name = 'payment-dense'
        trace = json.loads((out / (name + '.json')).read_text())
        width, height, pixels = read_ppm(out / (name + '.ppm'))
        (out / (name + '.png')).write_bytes(png_bytes(width, height, pixels))
        (out / (name + '.svg')).write_text(export_svg(width, height, pixels, trace['operations'], name))
        dense['qr'] = qr_metrics(trace, width, height, pixels)
        dense['texts'] = [op['text'] for op in trace['operations'] if op['kind'] == 'text']
        scenes[name] = {'png': str(out / (name + '.png')), 'ppm': str(out / (name + '.ppm')),
                        'svg': str(out / (name + '.svg')), 'trace': str(out / (name + '.json')),
                        'layout': layout_metrics(trace), 'qr': dense['qr']}
        native['scenes'].append(name)
    font_trace = json.loads((out / 'font-proof.json').read_text())
    width, _, pixels = read_ppm(out / 'font-proof.ppm')
    report = {**native, 'scenes': scenes, 'denseRender': dense, 'fontChecks': independent_font_check(tft, font_trace, width, pixels),
              'provenance': {'mode': 'git-revision' if revision else 'working-tree', 'revision': revision,
                             'firmwareSources': [str(src / path) for path in SOURCES], 'sha256': hashes,
                             'tftMethods': methods, 'commands': [[str(x) for x in cmd] for cmd in commands],
                             'binary': str(build / 'ric-display-host'), 'generatedTft': str(generated)},
              'verificationBoundary': 'Real screen C++, installed QR encoder, actual TFT font resources and software raster routines. Host adapters replace Arduino time/String and TFT bus writes. Not a device framebuffer capture, SPI/touch calibration test, or QR camera-scan proof.'}
    (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    cards = []
    for name in native['scenes']:
        cards.append(f'<figure><img src="{name}.png" width="640" height="480" alt="{name}"><figcaption>{name} <a href="{name}.svg">SVG</a> <a href="{name}.json">trace</a></figcaption></figure>')
    (out / 'index.html').write_text('<!doctype html><meta charset="utf-8"><title>RIC host render review</title><style>body{background:#111;color:#ddd;font:16px sans-serif;margin:24px}main{display:flex;flex-wrap:wrap;gap:20px}figure{margin:0}img{image-rendering:pixelated;max-width:100%;height:auto}figcaption{padding:8px 0}a{color:#f7a93c}</style><h1>RIC host render review</h1><p>' + html.escape(report['verificationBoundary']) + '</p><p><a href="report.json">Behavior and geometry report</a></p><main>' + ''.join(cards) + '</main>\n')
    print(json.dumps({'report': str(out / 'report.json'), 'gallery': str(out / 'index.html'), 'sceneCount': len(scenes), 'build': str(build)}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('ric-display: ' + str(error), file=sys.stderr)
        sys.exit(1)
