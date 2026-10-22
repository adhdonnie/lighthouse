#!/usr/bin/env bash
# Shared by both independent Linux jobs; prepare identical runtime inputs.
set -euo pipefail
: "${CHROMIUM_SRC:?}" "${EVIDENCE_DIR:?}" "${GITHUB_WORKSPACE:?}"
cd "$CHROMIUM_SRC"
test "$(git rev-parse HEAD)" = 0e66b94549a8bd85f03fbdf189b752d6e7b63c32
git diff --exit-code
for patch in chromium-sink-tracing.patch chromium-undrawn-state-tracing.patch chromium-frame-timing-state.patch; do
  git apply --check "$GITHUB_WORKSPACE/.github/patches/$patch"
  git apply "$GITHUB_WORKSPACE/.github/patches/$patch"
done
git diff --check
git diff > "$EVIDENCE_DIR/common-diagnostics.patch"
export PILOT_GN_ARGS='is_debug=false is_component_build=true symbol_level=0 blink_symbol_level=0 v8_symbol_level=0 use_remoteexec=false use_siso=true'
export PILOT_OBJECT='obj/base/base/at_exit.o'
export PILOT_SOURCE='base/at_exit.cc'
# No GN generation here: jobB must retain graph/state from jobA after restore.
python3 - <<'PY'
import hashlib,json,os,pathlib,subprocess
src=pathlib.Path(os.environ['CHROMIUM_SRC']);repo=pathlib.Path(os.environ['GITHUB_WORKSPACE'])
def sha(p):
    h=hashlib.sha256()
    with p.open('rb')as f:
        for b in iter(lambda:f.read(1024**2),b''):h.update(b)
    return h.hexdigest()
names=['.github/patches/'+x for x in ['chromium-sink-tracing.patch','chromium-undrawn-state-tracing.patch','chromium-frame-timing-state.patch']]
names+=['.github/scripts/'+x for x in ['chromium-checkpoint.py','checkpoint-pilot.py','chromium-checkpoint-pilot-prepare.sh','chromium-validation-bootstrap.sh']]
obj={'chromium':'0e66b94549a8bd85f03fbdf189b752d6e7b63c32',
     'depotTools':subprocess.check_output(['git','-C',os.environ['DEPOT_TOOLS_DIR'],'rev-parse','HEAD'],text=True).strip(),
     'target':os.environ['PILOT_OBJECT'],'out':'out/Paired','gnArgs':os.environ['PILOT_GN_ARGS'],
     'architecture':os.uname().machine,'runnerImage':os.environ.get('ImageVersion'),
     'files':{n:sha(repo/n)for n in names},
     'sisoSha256':sha(src/'third_party/siso/cipd/siso'),
     'clangSha256':sha(src/'third_party/llvm-build/Release+Asserts/bin/clang')}
p=pathlib.Path(os.environ['EVIDENCE_DIR'])/'checkpoint-identity.json'
p.write_text(json.dumps(obj,indent=2,sort_keys=True))
PY
printf 'PILOT_GN_ARGS=%s\nPILOT_OBJECT=%s\nPILOT_SOURCE=%s\n' "$PILOT_GN_ARGS" "$PILOT_OBJECT" "$PILOT_SOURCE" >> "$GITHUB_ENV"
