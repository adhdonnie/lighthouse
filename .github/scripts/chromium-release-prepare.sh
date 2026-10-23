#!/usr/bin/env bash
# Baseline Chrome and policy-test binaries share the same Release object graph.
set -euo pipefail
bash "$GITHUB_WORKSPACE/.github/scripts/chromium-checkpoint-pilot-prepare.sh"
cd "$CHROMIUM_SRC"
git apply --check "$GITHUB_WORKSPACE/.github/patches/chromium-policy-test-155.patch"
git apply "$GITHUB_WORKSPACE/.github/patches/chromium-policy-test-155.patch"
git diff --check
git cl format --upstream=HEAD --dry-run --diff -- content/browser/renderer_host/render_frame_host_impl_browsertest.cc \
  > "$EVIDENCE_DIR/policy-source-format.log" 2>&1
git diff > "$EVIDENCE_DIR/baseline-source.patch"
python3 - <<'PY'
import hashlib,json,os,pathlib
repo=pathlib.Path(os.environ['GITHUB_WORKSPACE']);ev=pathlib.Path(os.environ['EVIDENCE_DIR'])
p=ev/'checkpoint-identity.json';d=json.loads(p.read_text())
d['role']='release-chrome-and-policy-baseline'
d['target']=['chrome','content_browsertests']
d['validationCommit']=os.environ['GITHUB_SHA']
for name in ['.github/patches/chromium-policy-test-155.patch',
             '.github/patches/chromium-safe-parent-fix-155.patch',
             '.github/patches/chromium-policy-no-clear-155.patch',
             '.github/scripts/chromium-release-prepare.sh',
             '.github/scripts/chromium-release-phase.py',
             '.github/scripts/chromium-release-phase-test.py',
             '.github/workflows/chromium-release-continuation.yml']:
    d['files'][name]=hashlib.sha256((repo/name).read_bytes()).hexdigest()
encoded=json.dumps(d,sort_keys=True,indent=2)
p.write_text(encoded)
identity=hashlib.sha256(encoded.encode()).hexdigest()
previous=os.environ.get('PREVIOUS_CACHE_KEY','')
prefix='chromium-release-'+identity+'-'
if previous and not previous.startswith(prefix):
    raise SystemExit('Previous exact cache key does not match independently measured identity')
key=prefix+os.environ['GITHUB_SHA']+'-'+os.environ['GITHUB_RUN_ID']+'-'+os.environ['GITHUB_RUN_ATTEMPT']
with open(os.environ['GITHUB_ENV'],'a')as f:
    f.write('CHECKPOINT_ID='+identity+'\nCHECKPOINT_SAVE_KEY='+key+'\n')
(ev/'phase-provenance.json').write_text(json.dumps({'validationCommit':os.environ['GITHUB_SHA'],
    'previousExactCacheKey':previous,'saveKey':key,'identity':identity},indent=2))
PY
