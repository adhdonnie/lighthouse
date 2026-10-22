#!/usr/bin/env python3
"""Snapshot each component browser for the matched-diagnostics comparison."""
import hashlib
import json
from pathlib import Path
import shutil
import sys

source = Path(sys.argv[1]).resolve()
destination = Path(sys.argv[2]).resolve()
if not (source / 'chrome').is_file() or destination.exists():
    raise SystemExit('Require a built browser and a fresh snapshot directory')
destination.mkdir(parents=True)
names = {'chrome', 'chrome_crashpad_handler', 'chrome_sandbox', 'vk_swiftshader_icd.json'}
for item in sorted(source.iterdir()):
    if item.is_file() and (item.name in names or
                          item.suffix in {'.so', '.pak', '.dat', '.bin'} or '.so.' in item.name):
        target = destination / item.name
        shutil.copy2(item, target)
    elif item.is_dir() and item.name in {'locales', 'resources', 'swiftshader', 'hyphen-data',
                                            'MEIPreload', 'PrivacySandboxAttestationsPreloaded'}:
        shutil.copytree(item, destination / item.name)

manifest = []
for target in sorted(destination.rglob('*')):
    if not target.is_file():
        continue
    digest = hashlib.sha256()
    with target.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    manifest.append({'name': str(target.relative_to(destination)),
                     'bytes': target.stat().st_size, 'sha256': digest.hexdigest()})
(destination / 'runtime-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'runtime': str(destination), 'runtimeFiles': len(manifest)}))
