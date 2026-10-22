#!/usr/bin/env python3
"""Materialize six managed tool links without changing their payload bytes.

CIPD assigns private numeric storage slots in arrival order. Keep those slots
untouched; snapshot the logical tool paths as regular files before GN/build.
The ordinary checkpoint scanner then hashes every resulting file strictly.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

PIN = 'dca727ba1f8fa8f1e3b12a815d065818bb61d395'


def materialize(src, report):
    depot = src.resolve() / 'third_party/depot_tools'
    assert subprocess.check_output(['git', '-C', str(depot), 'rev-parse', 'HEAD'], text=True).strip() == PIN
    root = depot / '.cipd_bin'
    storage = (root / '.cipd').resolve(strict=True)
    provenance = {}
    files = {}
    for tool in ['crowbar', 'git-credential-luci', 'luci-auth']:
        for relative in [tool, '.versions/' + tool + '.cipd_version']:
            path = root / relative
            assert path.is_symlink(), f'Expected fresh managed link: {path}'
            target = path.resolve(strict=True)
            assert storage in target.parents and target.is_file(), f'Unexpected target: {target}'
            assert target.name == path.name
            before = hashlib.sha256(target.read_bytes()).hexdigest()
            provenance[relative] = {'link': os.readlink(path), 'resolved': str(target)}
            fd, temporary = tempfile.mkstemp(prefix='.checkpoint-tool-', dir=path.parent)
            os.close(fd)
            try:
                shutil.copy2(target, temporary)
                assert hashlib.sha256(Path(temporary).read_bytes()).hexdigest() == before
                os.replace(temporary, path)
            finally:
                Path(temporary).unlink(missing_ok=True)
            assert not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest() == before
            files[relative] = {'sha256': before, 'size': path.stat().st_size,
                               'mode': path.stat().st_mode & 0o777}
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text(json.dumps({'pin': PIN, 'files': files, 'provenance': provenance}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--src', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    materialize(args.src, args.report)
