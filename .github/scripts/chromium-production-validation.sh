#!/usr/bin/env bash
# Deterministic production-patch proof. All source/checkouts are job-local.
set -euo pipefail
suite=${1:?suite cc/viz/policy required}
: "${CHROMIUM_SRC:?}" "${CHROMIUM_REVISION:?}" "${EVIDENCE_DIR:?}" "${GITHUB_WORKSPACE:?}"
scripts="$GITHUB_WORKSPACE/.github/scripts"
budget="$scripts/chromium-validation-budget.sh"
checker="$scripts/chromium-validation-gtest.py"
cd "$CHROMIUM_SRC"
test "$(git rev-parse HEAD)" = "$CHROMIUM_REVISION"
mkdir -p "$EVIDENCE_DIR"
resolve_patch() { if [[ "$1" = /* ]]; then printf '%s\n' "$1"; else printf '%s/%s\n' "$GITHUB_WORKSPACE" "$1"; fi; }
apply_patch() { local patch; patch=$(resolve_patch "$1"); test -s "$patch"; git apply --check "$patch"; git apply "$patch"; }
format_and_record() {
  local stage=$1
  git diff --check
  cp .clang-format "$EVIDENCE_DIR/source.clang-format"
  mapfile -d '' paths < <(git diff --name-only -z)
  test "${#paths[@]}" -gt 0
  git cl format --upstream=HEAD --dry-run --diff -- "${paths[@]}" 2>&1 | tee "$EVIDENCE_DIR/$stage-format.log"
  git diff > "$EVIDENCE_DIR/$stage.patch"
  git status --short > "$EVIDENCE_DIR/$stage-status.txt"
  python3 - "$EVIDENCE_DIR/$stage-source-hashes.json" "${paths[@]}" <<'PY'
import hashlib,json,pathlib,sys
pathlib.Path(sys.argv[1]).write_text(json.dumps([{'file':f,'sha256':hashlib.sha256(pathlib.Path(f).read_bytes()).hexdigest()}for f in sys.argv[2:]],indent=2))
PY
}
check_paths() {
  python3 - "$@" <<'PY'
import subprocess,sys
actual=set(subprocess.check_output(['git','diff','--name-only'],text=True).splitlines())
assert actual==set(sys.argv[1:]),(actual,sys.argv[1:])
PY
}
initial_build() {
  local reserve=$1 target=$2
  bash "$budget" 14400 "$reserve" autoninja -C out/Validation -j 4 "$target" \
    2>&1 | tee "$EVIDENCE_DIR/initial-build.log"
}
rebuild() {
  local reserve=$1 target=$2 stage=$3
  bash "$budget" 1200 "$reserve" autoninja -C out/Validation -j 4 "$target" \
    2>&1 | tee "$EVIDENCE_DIR/$stage-build.log"
}
run_test() {
  local target=$1 filter=$2 name=$3 expectation=$4
  shift 4
  local prefix="$EVIDENCE_DIR/$name" status
  set +e
  bash "$budget" 600 300 vpython3 testing/xvfb.py "out/Validation/$target" \
    "--gtest_filter=$filter" --gtest_repeat=1 --gtest_shuffle=0 --test-launcher-jobs=1 \
    --test-launcher-retry-limit=0 --test-launcher-print-test-stdio=always \
    "--gtest_output=json:$prefix.json" "--test-launcher-summary-output=$prefix.launcher.json" \
    2>&1 | tee "$prefix.log"
  status=${PIPESTATUS[0]}
  set -e
  echo "$status" > "$prefix.exit-code.txt"
  if [ "$expectation" = fail ]; then
    python3 "$checker" "$prefix" --exit "$status" --expect-failure "$@"
  else
    python3 "$checker" "$prefix" --exit "$status" "$@"
  fi
}
case "$suite" in
  cc)
    apply_patch "${CC_TEST_PATCH:?}"
    check_paths cc/trees/layer_tree_host_unittest.cc
    ;;
  viz)
    apply_patch "${CC_FIX_PATCH:?}"
    check_paths cc/trees/layer_tree_host.cc
    ;;
  policy)
    apply_patch "${POLICY_TEST_PATCH:?}"
    check_paths content/browser/renderer_host/render_frame_host_impl_browsertest.cc
    ;;
  *) echo "Unknown suite $suite" >&2; exit 64;;
esac
format_and_record initial
buildtools/linux64/gn gen out/Validation --args='is_debug=false is_component_build=true symbol_level=0 blink_symbol_level=0 v8_symbol_level=0 use_remoteexec=false use_siso=true' \
  2>&1 | tee "$EVIDENCE_DIR/gn.log"
cp out/Validation/args.gn "$EVIDENCE_DIR/args.gn"
case "$suite" in
  cc)
    parent='*LayerTreeHostTestSameSizeParentSurfaceBlocksStaleFrames*'
    child='LayerTreeHostTestSameSizeChildSurfaceAckKeepsDrawing'
    unchanged='LayerTreeHostTestUnchangedSurfaceKeepsDrawing'
    initial_build 3000 cc_unittests
    run_test cc_unittests "$parent" baseline-parent fail
    run_test cc_unittests "*$child*:*$unchanged*" baseline-boundaries pass \
      --require "$child" --require "$unchanged"
    apply_patch "${CC_FIX_PATCH:?}"
    check_paths cc/trees/layer_tree_host.cc cc/trees/layer_tree_host_unittest.cc
    format_and_record fixed
    rebuild 1200 cc_unittests fixed
    run_test cc_unittests "$parent:*$child*:*$unchanged*:*LocalSurface*:*SurfaceId*" fixed-cc pass \
      --require SameSizeParentSurfaceBlocksStaleFrames --require "$child" --require "$unchanged"
    ;;
  viz)
    initial_build 1800 viz_unittests
    run_test viz_unittests '*CompositorFrameSinkSupportTest*:*VideoCadenceThrottlingTest*:DisplayTest.BeginFrameThrottling*:DisplayTest.DontThrottleWhenParentBlocked' viz pass \
      --require CompositorFrameSinkSupportTest --require BeginFrameThrottling \
      --require BeginFrameThrottlingMultipleSurfaces --require DontThrottleWhenParentBlocked
    ;;
  policy)
    test_filter='SameRFHNoPaintHoldingBrowserTest.ExcludesOldSurfaceWhileNewDocumentPaintIsBlocked'
    initial_build 4800 content_browsertests
    run_test content_browsertests "$test_filter" baseline-policy pass --require "$test_filter"
    if [ -n "${POLICY_NEGATIVE_PATCH:-}" ]; then
      apply_patch "$POLICY_NEGATIVE_PATCH"
      check_paths content/browser/renderer_host/render_frame_host_impl_browsertest.cc \
        content/browser/renderer_host/render_frame_host_manager.cc
      format_and_record negative-policy
      rebuild 2400 content_browsertests negative-policy
      run_test content_browsertests "$test_filter" negative-policy fail \
        --failure-test SameRFHNoPaintHoldingBrowserTest \
        --failure-text 'first_new_surface|IsInRangeInclusive' --require "$test_filter"
      git apply --reverse "$(resolve_patch "$POLICY_NEGATIVE_PATCH")"
    else
      echo 'PENDING: no negative-control patch supplied; only positive policy checks run.' \
        | tee "$EVIDENCE_DIR/negative-policy-PENDING.txt"
    fi
    apply_patch "${CC_FIX_PATCH:?}"
    check_paths cc/trees/layer_tree_host.cc \
      content/browser/renderer_host/render_frame_host_impl_browsertest.cc
    format_and_record fixed-policy
    rebuild 900 content_browsertests fixed-policy
    run_test content_browsertests "$test_filter" fixed-policy pass --require "$test_filter"
    ;;
esac
df -h / > "$EVIDENCE_DIR/disk-after-build.txt"
