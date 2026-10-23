#!/usr/bin/env python3
"""Bounded trusted-workflow checkpoint; never suppresses a changed source input.

Use only at a stopped Siso build, after the same pinned bootstrap, patches and GN
args on both machines. A successful tiny graph pilot is required before using this
for an expensive graph. This is a proposed CI transport, not Chromium validation.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

LIMIT = 8 * 1024**3
LOG_LINKS = {'siso.INFO', 'siso.WARNING', 'siso.ERROR', 'siso.FATAL'}


def digest(p):
    h = hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda: f.read(1024**2), b''):
            h.update(b)
    return h.hexdigest()


def scan(root, output=False):
    result = {}
    for parent, dirs, files in os.walk(root, followlinks=False):
        directory = Path(parent)
        st = directory.stat()
        result[directory.relative_to(root).as_posix()] = {
            'directory': True, 'mtime_ns': st.st_mtime_ns,
            'mode': st.st_mode & 0o777}
        dirs[:] = sorted(d for d in dirs if output or d not in {'.git', '.cipd', 'out'})
        # Directory symlinks are data, not directories to traverse.
        for n in list(dirs):
            p = Path(parent, n)
            if p.is_symlink():
                files.append(n)
                dirs.remove(n)
        for n in sorted(files):
            if not output and n == '.git':
                continue
            p = Path(parent, n)
            rel = p.relative_to(root).as_posix()
            if output and p.is_symlink() and n in LOG_LINKS:
                continue
            st = p.lstat()
            if p.is_symlink():
                result[rel] = {'link': os.readlink(p), 'mtime_ns': st.st_mtime_ns}
            elif p.is_file():
                result[rel] = {'sha256': digest(p), 'size': st.st_size,
                               'mtime_ns': st.st_mtime_ns, 'mode': st.st_mode & 0o777}
            else:
                raise ValueError(f'Unexpected special file {p}')
    return result


def same_content(expected, actual, report=None):
    def stable(rows):
        return {k: {a: b for a, b in v.items() if a != 'mtime_ns'}
                for k, v in rows.items()}
    if stable(expected) != stable(actual):
        keys = []
        for k in sorted(set(expected) | set(actual)):
            a = {x: y for x, y in expected.get(k, {}).items() if x != 'mtime_ns'}
            b = {x: y for x, y in actual.get(k, {}).items() if x != 'mtime_ns'}
            if a != b:
                keys.append(k)
        if report:
            report.parent.mkdir(parents=True, exist_ok=True)
            report.write_text(json.dumps({'mismatchCount': len(keys),
                'first1000': {k: {'expected': expected.get(k), 'actual': actual.get(k)}
                              for k in keys[:1000]}}, indent=2))
        raise ValueError(f'Checkpoint content mismatch: {keys[:30]} ({len(keys)} paths)')


def stamps(root, rows):
    # GN records directory inputs for glob/listing operations. Their mtimes
    # must follow the file restores, rather than being lost after extraction.
    ordered = sorted(rows.items(), key=lambda item: (
        bool(item[1].get('directory')), -len(Path(item[0]).parts)))
    for name, row in ordered:
        if 'mtime_ns' in row:
            os.utime(root / name, ns=(row['mtime_ns'], row['mtime_ns']),
                     follow_symlinks='link' not in row)
            assert (root / name).lstat().st_mtime_ns == row['mtime_ns'], \
                f'Exact timestamp restore failed: {name}'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mode', choices=['seal', 'restore'])
    ap.add_argument('--src', type=Path, required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--identity', type=Path, required=True)
    ap.add_argument('--checkpoint', type=Path, required=True)
    ap.add_argument('--mismatch-report', type=Path)
    args = ap.parse_args()
    src = args.src.resolve()
    out = Path(args.out)
    if out.is_absolute() or len(out.parts) != 2 or out.parts[0] != 'out' or '..' in out.parts:
        raise ValueError('Expected out/<one build directory>')
    for parent in [src / 'out', src / out]:
        if parent.is_symlink():
            raise ValueError(f'Output path is a symlink: {parent}')
    cp = args.checkpoint.resolve()
    if cp == src or src in cp.parents:
        raise ValueError('Checkpoint must be outside source')
    identity = json.loads(args.identity.read_text())
    # Identity must describe source/depot revisions, compiler/sysroot versions,
    # exact GN args, patch content and the checkpoint helper itself.
    archive = cp / 'out.tar.zst'
    manifest = cp / 'manifest.json.gz'
    ready = cp / 'READY.json'
    if args.mode == 'seal':
        cp.mkdir(parents=True, exist_ok=True)
        ready.unlink(missing_ok=True)
        rows = {'schema': 2, 'identity': identity, 'absoluteSource': str(src), 'out': str(out),
                'source': scan(src), 'outputs': scan(src / out, True)}
        # Refuse to upload a partial/truncated checkpoint. Cap compressed bytes
        # before writing, leaving room within the default included cache quota.
        tar = subprocess.Popen(['tar', '-C', str(src), '--format=pax',
                                *[f'--exclude={out}/{n}' for n in sorted(LOG_LINKS)],
                                '-cf', '-', str(out)],
                               stdout=subprocess.PIPE)
        zst = subprocess.Popen(['zstd', '-T2', '-3', '-c'], stdin=tar.stdout,
                               stdout=subprocess.PIPE)
        tar.stdout.close()
        size = 0
        try:
            with archive.open('wb') as f:
                for b in iter(lambda: zst.stdout.read(1024**2), b''):
                    size += len(b)
                    if size > LIMIT:
                        raise ValueError('Compressed checkpoint exceeds 8 GiB; stop, do not upload')
                    f.write(b)
            if zst.wait() or tar.wait():
                raise RuntimeError('Archive command failed')
        except BaseException:
            zst.kill()
            tar.kill()
            zst.wait()
            tar.wait()
            archive.unlink(missing_ok=True)
            raise
        with gzip.open(manifest, 'wt') as f:
            json.dump(rows, f, separators=(',', ':'))
        if archive.stat().st_size + manifest.stat().st_size > LIMIT:
            raise ValueError('Checkpoint plus manifest exceeds 8 GiB; do not upload')
        ready.write_text(json.dumps({'archiveSha256': digest(archive),
                                     'manifestSha256': digest(manifest),
                                     'compressedBytes': archive.stat().st_size,
                                     'outputBytes': sum(r.get('size', 0) for r in rows['outputs'].values()),
                                     'sourceFiles': len(rows['source']),
                                     'outputFiles': len(rows['outputs'])}, indent=2))
    else:
        header = json.loads(ready.read_text())
        assert digest(archive) == header['archiveSha256'], 'Archive hash mismatch'
        assert digest(manifest) == header['manifestSha256'], 'Manifest hash mismatch'
        with gzip.open(manifest, 'rt') as f:
            rows = json.load(f)
        assert rows.get('schema') == 2, 'Directory timestamp manifest required'
        assert rows['identity'] == identity, 'Identity mismatch'
        assert rows['absoluteSource'] == str(src), 'Absolute checkout path changed'
        assert rows['out'] == str(out), 'Output path changed'
        same_content(rows['source'], scan(src), args.mismatch_report)
        if shutil.disk_usage(src).free < header['outputBytes'] + 5 * 1024**3:
            raise ValueError('Insufficient restore disk space')
        # Archive is from a same-key trusted workflow. Check the full path list
        # before extraction; reject links that could redirect a later member.
        dec = subprocess.Popen(['zstd', '-d', '-c', str(archive)], stdout=subprocess.PIPE)
        try:
            with tarfile.open(fileobj=dec.stdout, mode='r|') as tf:
                for member in tf:
                    name = Path(member.name)
                    if name.is_absolute() or '..' in name.parts or name.parts[:2] != out.parts:
                        raise ValueError(f'Unexpected archive member {member.name}')
                    if member.islnk() or member.issym():
                        raise ValueError('Archive links need explicit qualification; refusing')
                    if not (member.isfile() or member.isdir()):
                        raise ValueError('Special archive member')
                    tf.extract(member, src)
            if dec.wait():
                raise ValueError('Archive decompression failed')
        finally:
            if dec.poll() is None:
                dec.kill()
                dec.wait()
        same_content(rows['outputs'], scan(src / out, True), args.mismatch_report)
        stamps(src, rows['source'])
        stamps(src / out, rows['outputs'])
        print(json.dumps({'status': 'restored-content-and-exact-mtimes', **header}))


if __name__ == '__main__':
    main()
