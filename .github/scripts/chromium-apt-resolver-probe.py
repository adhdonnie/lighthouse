#!/usr/bin/env python3
"""Bounded, read-only install simulation. No Chromium checkout or apt install."""
import argparse
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
import urllib.request

REV = '0e66b94549a8bd85f03fbdf189b752d6e7b63c32'
SHA = 'a71e5ed8e3cbcaf87b255ff124c424cda73b48bcb3fd6a4d44bed2de42c68f19'
LIMIT = 5 * 1024**2  # Each stream: resolver debug <=10MiB total.


def installer_query(args, env):
    # The real bootstrap invokes the installer through sudo. Reproduce its
    # effective UID and locale without inheriting unrelated runner variables.
    keys = ['LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ']
    cmd = ['sudo', '-n', 'env']
    for key in keys:
        cmd.extend(['-u', key])
    cmd.extend(f'{key}={env[key]}' for key in keys if key in env)
    return cmd + ['apt-get', *args]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--case', choices=['native','normalized'], required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--packages-only', action='store_true')
    a = parser.parse_args()
    out = a.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    initial = {k:os.environ.get(k) for k in ['LANG','LANGUAGE','LC_ALL','LC_CTYPE','TZ']}
    if a.case == 'normalized':
        os.environ.update(LC_ALL='C.UTF-8',LANG='C.UTF-8',TZ='UTC')
    parent = dict(os.environ)
    query_env = dict(parent)
    query_env.update(LANGUAGE='en',LANG='C')  # Exact installer find_missing_packages.
    (out/'environment.json').write_text(json.dumps({'case':a.case,'initial':initial,
        'parent':{k:parent.get(k) for k in initial},
        'aptQuery':{k:query_env.get(k) for k in initial},
        'runnerImage':os.environ.get('ImageVersion'),'imageOS':os.environ.get('ImageOS'),
        'kernel':os.uname().release},indent=2))

    def snapshot(label, proc):
        target = out / f'{label}-proc-{int(time.monotonic())}.txt'
        commands = [['ps','-eo','pid,ppid,pgid,stat,pcpu,pmem,etime,wchan:32,args','--forest'],
                    ['free','-h'],['df','-h','/']]
        with target.open('w') as f:
            for cmd in commands:
                p = subprocess.run(cmd,capture_output=True,text=True,timeout=10)
                f.write('\nCOMMAND '+repr(cmd)+'\n'+p.stdout+p.stderr)
            # Capture direct apt child's counters. No private process environment.
            for name in ['status','wchan','io','sched']:
                try:f.write('\n/proc/'+str(proc.pid)+'/'+name+'\n'+Path('/proc',str(proc.pid),name).read_text())
                except (OSError,PermissionError) as e:f.write(str(e)+'\n')

    def bounded(label, cmd, env, seconds=300):
        start=time.monotonic()
        p=subprocess.Popen(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
        counts={'stdout':0,'stderr':0}
        def drain(stream,name):
            with (out/(label+'.'+name+'.log')).open('wb') as f:
                for b in iter(lambda:stream.read(65536),b''):
                    room=max(0,LIMIT-counts[name]);f.write(b[:room]);counts[name]+=len(b)
        threads=[threading.Thread(target=drain,args=(stream,name),daemon=True)
                 for stream,name in [(p.stdout,'stdout'),(p.stderr,'stderr')]]
        for t in threads:t.start()
        timed_out=False
        while p.poll() is None:
            if time.monotonic()-start>=seconds:
                timed_out=True;snapshot(label+'-timeout',p)
                os.killpg(p.pid,signal.SIGTERM)
                try:p.wait(timeout=10)
                except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL)
                break
            snapshot(label,p)
            try:p.wait(timeout=min(30,max(.1,seconds-(time.monotonic()-start))))
            except subprocess.TimeoutExpired:pass
        p.wait()
        for t in threads:t.join(timeout=10)
        row={'argv':cmd,'timeoutSeconds':seconds,'timedOut':timed_out,'exitCode':p.returncode,
             'elapsedSeconds':time.monotonic()-start,'bytes':counts,
             'truncated':{k:v>LIMIT for k,v in counts.items()}}
        (out/(label+'.json')).write_text(json.dumps(row,indent=2));return row

    url=f'https://chromium.googlesource.com/chromium/src/+/{REV}/build/install-build-deps.py?format=TEXT'
    data=base64.b64decode(urllib.request.urlopen(url,timeout=60).read())
    assert hashlib.sha256(data).hexdigest()==SHA,'Pinned installer changed'
    source=out/'install-build-deps.py';source.write_bytes(data)
    spec=importlib.util.spec_from_file_location('pinned_install',source)
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
    opts=mod.parse_args(['--no-prompt','--no-arm'])
    (out/'options.json').write_text(json.dumps(vars(opts),indent=2))
    # Reproduce the installer's own apt metadata update, without installing any
    # package or changing requested dependencies. Exact options have lib32 false.
    code='import importlib.util,sys;s=importlib.util.spec_from_file_location("i",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.apt_update(m.parse_args(["--no-prompt","--no-arm"]))'
    update=bounded('apt-update',[sys.executable,'-c',code,str(source)],parent,300)
    if update['timedOut'] or update['exitCode']:
        (out/'summary.json').write_text(json.dumps({'case':a.case,'phase':'apt-update','result':update},indent=2));return 1
    bounded('installed-packages',['dpkg-query','-W','-f','${binary:Package}\t${Version}\t${Architecture}\n'],parent,30)
    bounded('foreign-architectures',['dpkg','--print-foreign-architectures'],parent,30)
    bounded('apt-config',['apt-config','dump'],parent,30)
    bounded('apt-version',['apt-get','--version'],parent,30)
    bounded('locale',['locale'],parent,30)
    package_code='import importlib.util,sys,json;s=importlib.util.spec_from_file_location("i",sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps(m.package_list(m.parse_args(["--no-prompt","--no-arm"]))))'
    package_result=bounded('extract-packages',[sys.executable,'-c',package_code,str(source)],parent,60)
    if package_result['timedOut'] or package_result['exitCode']:
        raise RuntimeError('Pinned installer package-list extraction did not complete')
    packages=json.loads((out/'extract-packages.stdout.log').read_text())
    (out/'requested-packages.json').write_text(json.dumps(packages,indent=2))
    (out/'requested-packages.sha256').write_text(hashlib.sha256('\n'.join(packages).encode()).hexdigest()+'\n')
    bounded('package-policy',['apt-cache','policy',*packages],parent,60)
    if a.packages_only:return 0
    # stdout=PIPE matches check_output; both streams drained, stderr recorded.
    bounded('query-root-identity',['sudo','-n','id'],parent,30)
    exact=bounded('exact-simulation',installer_query(['--just-print','install',*packages],query_env),query_env,300)
    debug=None
    if exact['timedOut']:
        debug=bounded('resolver-debug',installer_query(['--just-print','-o','Debug::pkgProblemResolver=true',
            '-o','Debug::pkgDepCache::AutoInstall=true','install',*packages],query_env),query_env,60)
    # Repeat against the same package metadata and installed state, changing
    # only LC_ALL. The two jobs use opposite orders to expose cache/order effects.
    alternate_env = dict(query_env)
    if a.case == 'native':
        alternate_env['LC_ALL'] = 'C.UTF-8'
    else:
        alternate_env.pop('LC_ALL', None)
    alternate = bounded('alternate-simulation',
        installer_query(['--just-print','install',*packages],alternate_env), alternate_env, 300)
    (out/'summary.json').write_text(json.dumps({'case':a.case,'phase':'completed-probe',
        'exactSimulation':exact,'resolverDebug':debug,'packageCount':len(packages),
        'alternateSimulation':alternate,
        'localeOrder':[query_env.get('LC_ALL'),alternate_env.get('LC_ALL')]},indent=2))
    # Diagnostic completion is not an assertion that apt/Chromium validation passed.
    # Preserve both timeout and success results; no automatic repetition.
    return 0


if __name__=='__main__':
    sys.exit(main())
