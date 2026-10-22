#!/usr/bin/env bash
# A fresh, independent checkout on a disposable GitHub-hosted Linux runner.
set -euo pipefail
: "${RUNNER_TEMP:?}" "${GITHUB_WORKSPACE:?}" "${GITHUB_ENV:?}" "${GITHUB_PATH:?}"
: "${CHROMIUM_REVISION:?}" "${EVIDENCE_DIR:?}"
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
[[ "$CHROMIUM_REVISION" =~ ^[0-9a-f]{40}$ ]]
mkdir -p "$EVIDENCE_DIR"
export CHROMIUM_DEADLINE=$(( $(date +%s) + 345 * 60 ))
export DEPOT_TOOLS_UPDATE=0
export DEPOT_TOOLS_DIR="$RUNNER_TEMP/depot_tools"
export CHROMIUM_SRC="$RUNNER_TEMP/chromium/src"
printf 'CHROMIUM_DEADLINE=%s\nDEPOT_TOOLS_UPDATE=0\nDEPOT_TOOLS_DIR=%s\nCHROMIUM_SRC=%s\n' \
  "$CHROMIUM_DEADLINE" "$DEPOT_TOOLS_DIR" "$CHROMIUM_SRC" >> "$GITHUB_ENV"
df -h / > "$EVIDENCE_DIR/disk-before.txt"
# These SDK directories belong only to this disposable hosted VM.
sudo rm -rf /usr/local/lib/android /usr/share/dotnet /opt/hostedtoolcache \
  /usr/local/.ghcup /usr/local/share/powershell /usr/share/swift
sudo swapoff -a
sudo rm -f /swapfile /mnt/swapfile
sudo fallocate -l 16G /mnt/chromium.swap
sudo chmod 600 /mnt/chromium.swap
sudo mkswap /mnt/chromium.swap
sudo swapon /mnt/chromium.swap
df -h / > "$EVIDENCE_DIR/disk-ready.txt"
free -h > "$EVIDENCE_DIR/memory-ready.txt"
test "$(df --output=avail -BG / | tail -1 | tr -dc '0-9')" -ge 100
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git "$DEPOT_TOOLS_DIR"
git -C "$DEPOT_TOOLS_DIR" checkout f2ac30836f43e58e4f79a8d969a88057e7704ab2
export PATH="$DEPOT_TOOLS_DIR:$PATH"
echo "$DEPOT_TOOLS_DIR" >> "$GITHUB_PATH"
"$DEPOT_TOOLS_DIR/ensure_bootstrap" 2>&1 | tee "$EVIDENCE_DIR/bootstrap.log"
"$DEPOT_TOOLS_DIR/python-bin/python3" --version 2>&1 | tee "$EVIDENCE_DIR/bootstrap-python.txt"
mkdir -p "$RUNNER_TEMP/chromium"
cd "$RUNNER_TEMP/chromium"
gclient config --spec 'solutions = [{"name": "src", "url": "https://chromium.googlesource.com/chromium/src.git", "deps_file": "DEPS", "managed": False, "custom_deps": {}, "custom_vars": {}}]'
gclient sync --verbose --nohooks --no-history --revision "src@$CHROMIUM_REVISION" \
  2>&1 | tee "$EVIDENCE_DIR/sync.log"
cd "$CHROMIUM_SRC"
test "$(git rev-parse HEAD)" = "$CHROMIUM_REVISION"
git rev-parse HEAD > "$EVIDENCE_DIR/chromium-revision.txt"
git -C "$DEPOT_TOOLS_DIR" rev-parse HEAD > "$EVIDENCE_DIR/depot-tools-revision.txt"
cat chrome/VERSION > "$EVIDENCE_DIR/chromium-version.txt"
sudo ./build/install-build-deps.sh --no-prompt --no-arm \
  2>&1 | tee "$EVIDENCE_DIR/dependencies.log"
gclient runhooks 2>&1 | tee "$EVIDENCE_DIR/hooks.log"
df -h / > "$EVIDENCE_DIR/disk-after-sync.txt"
