#!/usr/bin/env python3
"""Tiny, seconds-long pinned-Siso restore experiment. No Chrome or large builds."""
from pathlib import Path
import argparse
import json
import os
import shutil
import subprocess
import tempfile

ap = argparse.ArgumentParser()
ap.add_argument('--siso', required=True)
ap.add_argument('--checkpoint-helper', required=True)
ap.add_argument('--result', type=Path, required=True)
a = ap.parse_args()
root = Path(tempfile.mkdtemp(prefix='chromium-checkpoint-pilot-'))
src = root / 'src'
(src / 'out/Pilot').mkdir(parents=True)
(src / 'input').write_text('fixed source bytes\n')
(src / 'out/Pilot/build.ninja').write_text('rule cp\n  command = cp $in $out\nbuild result: cp ../../input\n')
identity = root / 'identity.json'
identity.write_text(json.dumps({'pilot': True, 'siso': str(a.siso)}))
cp = root / 'checkpoint'
logs = {}

def build(n):
    r = subprocess.run([a.siso, 'ninja', '-o', '-C', 'out/Pilot', 'result'],
                       cwd=src, text=True, capture_output=True)
    logs[n] = r.stdout + r.stderr
    assert r.returncode == 0, logs[n]
    return logs[n]

def checkpoint(mode):
    r = subprocess.run(['python3', a.checkpoint_helper, mode, '--src', str(src),
                        '--out', 'out/Pilot', '--identity', str(identity),
                        '--checkpoint', str(cp)], text=True, capture_output=True)
    logs[mode] = r.stdout + r.stderr
    return r

assert '1 steps' in build('initial')
assert checkpoint('seal').returncode == 0, logs['seal']
# Entire source recreated, same absolute path, content equal, fresh mtimes.
shutil.rmtree(src)
(src / 'out').mkdir(parents=True)
(src / 'input').write_text('fixed source bytes\n')
assert checkpoint('restore').returncode == 0, logs['restore']
logs['successful-restore'] = logs['restore']
assert '0 steps' in build('restored'), logs['restored']
# Same size but changed bytes must be rejected before any timestamp restoration.
(src / 'input').write_text('wrong source bytes\n')
r = checkpoint('restore')
logs['rejected-changed-source'] = logs.pop('restore')
assert r.returncode != 0 and 'content mismatch' in logs['rejected-changed-source'], logs['rejected-changed-source']
# Normal changed-source incremental build must rerun, rather than falsely skip.
assert '1 steps' in build('changed-source'), logs['changed-source']
a.result.parent.mkdir(parents=True, exist_ok=True)
a.result.write_text(json.dumps({'status': 'pass', 'temporaryRoot': str(root),
                                'logs': logs}, indent=2))
print(a.result)
