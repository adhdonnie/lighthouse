# Chromium undrawn-frame throttling backport review

The proposed mitigation is the existing reviewed Chromium change [187751477c43dd00c681fd53db91be73271b7cea](https://chromium.googlesource.com/chromium/src/+/187751477c43dd00c681fd53db91be73271b7cea), [Gerrit 8563860](https://chromium-review.googlesource.com/c/chromium/src/+/8563860), authored by Phil Yan and reviewed by Jonathan Ross. It exempts an undrawn active surface from BeginFrame throttling while an active embedder awaits a newer surface. Attribution and the upstream implementation are retained.

The exemption preserves immediate old-content clearing and the default cross-origin paint-holding security policy. It does not suppress obsolete CC submissions. The new feature is enabled by default, with its upstream disabled-feature control retained. No Lighthouse scoring or launcher defaults change.

## Exact patch inputs

| Target | Pinned Chromium revision | Patch | SHA-256 |
| --- | --- | --- | --- |
| 155.0.8059.85 | `0e66b94549a8bd85f03fbdf189b752d6e7b63c32` | [155 backport](chromium-upstream-viz-backport-155.patch) | `24d5a09c5516d2d6023e348b8e120d68aff5ec25a59841952442c576da7e7536` |
| 157.0.8103.15 | `1aa07b638799e59656559ae6c6649d4b197f555e` | [157 backport](chromium-upstream-viz-backport-157.patch) | `e92fa46313208eb7174ab6bb3b250f01934ae05839ccf32973832996ba342315` |

Only the feature declaration/definition hunk contexts are rebased; seven other upstream file hunks apply unchanged. These are backports of an existing main fix, not a new current-main speed fix. On pinned main `f540c88ff79eebb05a89521a3a2dd682ae04b44f`, the original baseline already contains the mitigation and the alternate CC candidate does not show timing recovery (normal observed FCP medians 542 versus 541 ms).

## Executed qualification

The baseline and fixed arms include the same upstream helper APIs and tests. The baseline removes only the exemption block, and its decision source is required to match the original target revision byte for byte. The named regression gate is `DisplayTest.DontThrottleUndrawnFramesWhileEmbedderAwaitsSurface`: the baseline must fail its intended `ShouldSendBeginFrame` assertion, rather than crash or time out. Four disabled-feature/boundary controls must pass.

| Evidence | Linux 155 controlled fixture | Windows 157 |
| --- | --- | --- |
| Intended baseline assertion and four controls | Passed | Passed |
| Fixed affected Viz tests | 183 passed | 183 passed |
| Stock CC LocalSurface/SurfaceId coverage | 13 passed | 14 passed |
| Browser old-surface exclusion security positive | Passed in both arms | Passed in both arms under an ordinary account |
| Security-removal diagnostic negative | Not repeated in this comparison | Intended assertion failure; original policy restored |
| Matched mobile runtime collection | 12 captures | 12 captures in a controlled Server console fixture |

Linux captures use matched Release ABBAAB runs, actual viewport 412 × 823 and DPR 1.75, with no added source diagnostics. Standard tracing remains enabled. Runtime manifests differ only in the Viz service library and its TOC metadata; CC production and the security manager remain unchanged.

| Linux fixture | Baseline median observed FCP | Fixed median observed FCP |
| --- | --- | --- |
| Normal | 1392 ms | 581 ms |
| Amplified | 1391 ms | 577 ms |

Native renderer scheduler review finds approximately 1016 ms baseline delivery gaps and no corresponding one-second gap in fixed captures. Five fixed captures take the new exemption; one never reaches the throttle threshold. One fixed capture has a single all-sink throttle decision, so these results do not establish zero global throttling. The preserved automatic counter-based detector labels the diagnostic-free captures inconclusive because its added counter events are absent; timing acceptance rests on the separate source, component and native scheduler review.

Windows captures also use matched Release ABBAAB runs with actual viewport 412 × 823 and DPR 1.75, no added source diagnostics and standard tracing. All 1035 runtime files in each arm were hashed before and after collection; only `components_viz_service.dll` differs between arms. Runtime copies retain the source build output’s standard read/execute permissions for restricted application packages. No source, binary, sandbox or scoring change was used to resolve test-host startup prerequisites.

| Windows fixture | Baseline median observed FCP | Fixed median observed FCP | Conclusion |
| --- | --- | --- | --- |
| Normal | 536 ms | 535 ms | Baseline did not reproduce the stall; recovery is inconclusive |
| Amplified scrollbar timing | 1365 ms | 531 ms | Recovery in the controlled amplified fixture |

Each of the three amplified baseline captures has 60 native undrawn-throttle decisions and a renderer scheduler delivery gap of approximately 1016–1017 ms. Each amplified fixed capture takes the new exemption and has no corresponding one-second gap. Native decision counts cover all sinks: one amplified fixed capture and one normal fixed capture each contain a single global throttle decision. These results do not show zero global throttling or prove a normal Windows scoring improvement. Native surface labels can abbreviate embedding tokens; the native review is assessed alongside exact source, runtime and named component/security controls rather than presented as an independent full-token identity proof.

## Limits and review disposition

The Linux normal/amplified and Windows amplified results establish controlled fixture results. The fixture disables TreesInViz. They do not establish universal Lighthouse score recovery, recovery in the non-reproducing normal Windows case, Android-device behavior, or all compositor configurations. Windows browser security checks passed under an ordinary account with controlled host setup, including the intended assertion-negative when the original protection was removed diagnostically. The original policy was restored before accepted fixed tests and runtime collection. Host diagnostics and failed capture attempts remain separate from accepted evidence; diagnostic binaries are excluded from performance qualification.

The alternate narrow CC candidate and its independent functional/full-token/scheduler evidence are retained separately. A redundant current-main speed-fix submission is on hold. This package supports review of the existing upstream mitigation and its exact release backports; remaining platform limits must accompany any review request.
