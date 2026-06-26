"""Verify extension package before loading in Chrome."""
import json
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
MANIFEST = ROOT / 'manifest.json'

errors = []
warnings = []

def check_path_ascii():
    path_str = str(ROOT)
    if not path_str.isascii():
        warnings.append(
            '扩展路径含非 ASCII 字符（如中文）：%s\n'
            '  Chrome 可能无法加载后台脚本，请复制到 D:\\chrome-link-monitor' % path_str
        )

def load_manifest():
    if not MANIFEST.is_file():
        errors.append('missing manifest.json')
        return None
    return json.loads(MANIFEST.read_text(encoding='utf-8'))

def collect_manifest_files(mf):
    files = set()
    sw = mf.get('background', {}).get('service_worker')
    if sw:
        files.add(sw)
    for cs in mf.get('content_scripts', []):
        for js in cs.get('js', []):
            files.add(js)
    action = mf.get('action', {})
    popup = action.get('default_popup')
    if popup:
        files.add(popup)
    icons = mf.get('icons', {})
    for path in icons.values():
        files.add(path)
    action_icons = action.get('default_icon', {})
    for path in action_icons.values():
        files.add(path)
    for war in mf.get('web_accessible_resources', []):
        for res in war.get('resources', []):
            if '*' not in res:
                files.add(res)
    # Referenced by background
    files.add('content/portal-extract.js')
    files.add('background/background.entry.js')
    return files

def check_files(files):
    for rel in sorted(files):
        path = ROOT / rel.replace('/', os.sep)
        if not path.is_file():
            errors.append('missing file: %s' % rel)

def check_js_syntax():
    js_files = list(ROOT.rglob('*.js'))
    for path in js_files:
        if 'sw-modules.js' in path.name:
            continue
        try:
            subprocess.run(
                ['node', '--check', str(path)],
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as e:
            errors.append('syntax error: %s\n%s' % (path.relative_to(ROOT), e.stderr or e.stdout))
        except FileNotFoundError:
            warnings.append('node not found — skipped JS syntax check')
            break

def check_service_worker():
    sw = ROOT / 'background' / 'background.js'
    if not sw.is_file():
        errors.append('missing background/background.js')
        return
    text = sw.read_text(encoding='utf-8')
    if 'importScripts' in text:
        errors.append('background.js still uses importScripts — run: python bundle_sw.py')
    if 'var MSG' not in text:
        errors.append('background.js missing MSG — bundle incomplete')

def main():
    check_path_ascii()
    mf = load_manifest()
    if mf:
        check_files(collect_manifest_files(mf))
    check_service_worker()
    check_js_syntax()

    print('Extension root:', ROOT)
    if mf:
        print('Version:', mf.get('version'))
    print()
    for w in warnings:
        print('WARNING:', w)
        print()
    for e in errors:
        print('ERROR:', e)
        print()
    if errors:
        print('FAILED — %d error(s)' % len(errors))
        return 1
    print('OK — extension package looks valid')
    if warnings:
        print('(%d warning(s))' % len(warnings))
    return 0

if __name__ == '__main__':
    sys.exit(main())
