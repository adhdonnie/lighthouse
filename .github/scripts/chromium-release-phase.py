#!/usr/bin/env python3
"""One bounded build phase; no runtime or fix-qualification claim is made."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time


def processes(proc_root=Path('/proc')):
    rows = {}
    for p in proc_root.iterdir():
        if not p.name.isdigit():
            continue
        try:
            fields = (p/'stat').read_text().rsplit(')', 1)[1].split()
            rows[int(p.name)] = {'state': fields[0], 'parent': int(fields[1]),
                                 'group': int(fields[2]), 'start': int(fields[19])}
        except (OSError, ValueError, IndexError):
            continue
    return rows


def main(max_seconds=7200, min_seconds=60):
    src = Path(os.environ['CHROMIUM_SRC']).resolve()
    ev = Path(os.environ['EVIDENCE_DIR'])
    limit = min(max_seconds, int(os.environ['CHROMIUM_DEADLINE']) - int(time.time()) - 9000)
    assert limit >= min_seconds, 'Insufficient reserve for sealing, cache save and evidence'
    before = processes()
    owned = {}
    logpath = ev/'phase-build.log'
    start = time.monotonic()
    forced = False
    killed = False
    with logpath.open('w') as log:
        proc = subprocess.Popen(['autoninja','-C','out/Paired','-j','4','chrome','content_browsertests'],
                                cwd=src, stdout=log, stderr=subprocess.STDOUT,
                                start_new_session=True)

        def observe():
            rows = processes()
            changed = True
            while changed:
                changed = False
                for pid, row in rows.items():
                    if pid in owned and owned[pid] == row['start']:
                        continue
                    if row['group'] == proc.pid or (row['parent'] in owned and
                            rows.get(row['parent'], {}).get('start') == owned[row['parent']]):
                        owned[pid] = row['start']
                        changed = True
            return rows

        while proc.poll() is None:
            observe()
            if time.monotonic()-start >= limit:
                forced = True
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    forced = False  # Natural completion raced the deadline.
                break
            time.sleep(2)
        if forced:
            try:
                proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                    killed = True
                except ProcessLookupError:
                    pass
        code = proc.wait()
        # Wait for normal shutdown/flush. Detached or surviving owned processes
        # make the state unsafe to seal; never kill unrelated runner services.
        for _ in range(30):
            rows = observe()
            live = {pid: row for pid, row in rows.items() if row['state'] != 'Z' and
                    owned.get(pid) == row['start']}
            if not live:
                break
            time.sleep(1)
        unknown = []
        for pid, row in rows.items():
            if pid == os.getpid() or row['state'] == 'Z' or before.get(pid, {}).get('start') == row['start']:
                continue
            try:
                cwd = Path('/proc',str(pid),'cwd').resolve(strict=True)
                if cwd == src or src in cwd.parents:
                    unknown.append(pid)
            except OSError:
                continue
        proof = {'exitCode':code,'budgetSeconds':limit,'budgetExpired':forced,
                 'requiredSigkill':killed,'elapsedSeconds':time.monotonic()-start,
                 'ownedProcesses':owned,'survivingOwned':live,'newSourceCwdProcesses':unknown}
        (ev/'stopped-build-processes.json').write_text(json.dumps(proof,indent=2))
        assert not killed and not live and not unknown, 'Build state not proven stopped/flushed; do not seal'
    text = logpath.read_text()
    failures = re.findall(r'Build Failure:.*?\b(\d+) failed',text)
    if forced:
        assert failures and all(int(x) == 0 for x in failures), 'Timeout lacks clean stopped Siso summary'
        status = 'incomplete-build-progress'
    else:
        assert code == 0 and re.search(r'Build Succeeded:\s+\d+ steps',text), 'Actual compiler/build failure'
        status = 'binaries-built-not-qualified'
        assert all((src/'out/Paired'/x).is_file() and (src/'out/Paired'/x).stat().st_size > 0
                   and os.access(src/'out/Paired'/x,os.X_OK) for x in ['chrome','content_browsertests'])
    out = src/'out/Paired'
    objects = list(out.rglob('*.o'))
    previous_path = Path(os.environ['RUNNER_TEMP'])/'chromium-checkpoint/phase-result.json'
    previous = json.loads(previous_path.read_text()) if previous_path.exists() else None
    if previous:
        assert len(objects) >= previous['completedObjectCount'], 'Previously completed objects disappeared'
    result = {'status':status,'runtimeQualified':False,'securityPolicyQualified':False,
              'previousCompletedObjectCount':previous['completedObjectCount'] if previous else 0,
              'completedObjectCount':len(objects),
              'completedObjectBytes':sum(x.stat().st_size for x in objects),
              'sisoSummaries':re.findall(r'^.*Build (?:Succeeded|Failure):.*$',text,re.M),
              'budgetExpired':forced,'buildExitCode':code}
    (ev/'phase-result.json').write_text(json.dumps(result,indent=2))
    with open(os.environ['GITHUB_OUTPUT'],'a')as f:
        f.write('status='+status+'\n')


if __name__ == '__main__':
    main()
