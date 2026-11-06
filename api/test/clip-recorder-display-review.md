# Recorder source label scroll correction

Before implementation, the user confirmed that a visually blank source input
retains the correct live value, HTML value, color, opacity and dimensions. Focus
changes scrollLeft from 177 to 0; manually setting scrollLeft to 0 restores text
without focus. This establishes a usable correction, not the underlying browser
paint defect. The fixture reproduces stale scroll state in a real text input;
it does not claim to reproduce AMPP's complete MUI rendering bug.

Scope: trusted Recorder workload HTML only, input `root_source` with combobox
role. Reset scrolling after value updates, replacement and blur only while the
input is unfocused. Preserve editing scroll/caret, values, focus, other inputs
and input/change events. Disconnect observers/listeners on pagehide and restart
on pageshow. No polling timers or recording/API changes are required.

Baseline: PR12 commit `c3e8a3160a6f3e8a0483ed2ee981e3ff1ba3ea0e`.
Run the existing unit suite and build, then the new Chromium test against that
unchanged baseline before production edits. Repeat those checks plus relevant
HTML/proxy and routing compatibility checks after implementation. The final PR
review must preserve existing comments and safeguards. No Admin/shared schema
dependency changes are involved.

Manual acceptance: select several long source names, confirm the label remains
visible without clicking, then type/filter and use keyboard selection. Confirm
recording still uses the selected source. Real AMPP/MUI acceptance remains useful
even when the isolated Chromium behavior and compatibility tests pass.

## Validation and diff review

| Check | Baseline | Updated |
| --- | --- | --- |
| Full API unit suite | 324 passed | 332 passed |
| Full HTTP suite | 145 passed; 1 existing bootstrap failure | Same result, including all 36 routing cases |
| API build | Passed | Passed |
| New Chromium scroll fixture | Fails: unfocused/update/replacement/resume offsets remain 177 | Passed: each resets to 0 |
| Existing Chromium GVUI compatibility fixture | Passed | Passed |

The HTTP bootstrap failure is the existing unset `PLATFORM_URL`, followed by
teardown of an app that was never created. No live configuration was substituted.
The new browser helper and proxy scoping tests pass lint. The two existing
production files retain 54 lint findings on unchanged lines; there are no
findings on added lines. Existing response-rewriter tests retain their baseline
lint issues. Diff whitespace checks pass.

The Chromium check verifies unchanged values, no synthetic input/change/focus
events, preserved focus on another field, unchanged caret and scroll during
editing, no changes to other fields, input replacement, pagehide cleanup and
pageshow recovery. It models the observed stale offset; it cannot establish
the cause of AMPP's intermittent blank painting or validate its complete MUI UI.

Three production files change: the proxy recognizes Recorder metadata from the
authorized session and the actual upstream application URL; the response
rewriter opts that HTML into the new helper; the helper corrects only the source
combobox. Two unit-test files, one standalone browser fixture and this review
record the verification. Other application HTML and native JavaScript bytes/cache
policy are covered by scoping/compatibility tests. No external API contract,
session schema, Admin change or dependency update is required.

The final diff preserves existing comments and authorization, route locking,
recording, cancellation, timeout, transport and cache safeguards. The helper
uses one observer and at most one pending animation frame per Recorder document,
removes the old input listener on replacement, and disconnects on pagehide.
There is no polling or change to the selected source/recording commands.

The user has confirmed that the earlier routing fix records the selected source
and that manual `scrollLeft = 0` restores the label. Automatic display correction
with the deployed AMPP page still needs the manual acceptance check above.
