# Temporary GVUI browser diagnostics

Set `AMPP_PROXY_BROWSER_DIAGNOSTICS=true` in the API environment (for local
development, `api/.env`) and restart the API. Production builds need an API
rebuild/restart. The flag defaults to off. No Web, Admin, database, or dependency
changes are required.

The injected script runs only when the top-level page is a proxied GVUI layout.
It observes that layout and its descendant frames. It records diagnostics; it
does not enforce workload/frame matching or fix workload selection.

## Capture a session

1. Open browser developer tools for the new GVUI tab. Enable **Preserve log** and
   show **Info** messages in the Console. Filter on `[AMPP GVUI diagnostics]`.
   Where available, enable automatically opening developer tools for popups so
   initialization logs and call stacks are captured from the start.
2. Open the layout and wait for the four permitted applications to initialize.
   Note whether each GVUI component displays its expected application. SRT Input
   #2 should remain absent.
3. Before closing the tab, select the top frame's Console context and export the
   sanitized in-memory records with the developer tools `copy` helper:

   ```javascript
   copy(JSON.stringify(window.__AMPP_GVUI_DIAGNOSTICS__.state.records, null, 2))
   ```

   Save the clipboard contents to a file, identifying whether that launch was
   correct or incorrect. The buffer holds the latest 3,000 events across all
   frames. Saving the filtered Console also retains earlier events if that
   buffer fills. Sequence numbers identify gaps.
4. Close the tab, reopen GVUI from the selector, and repeat until a failure is
   captured. Save both successful and failed launches. **Preserve log does not
   retain a closed tab's Console in a newly opened tab**; save before closing.
   Keep the existing browser cache for the initial capture, then compare a
   separate run with the developer tools cache disabled if necessary.

Records are kept in the browser Console and in memory only. They are not sent
to the API or written to browser storage, so they will not appear in the
dev-server log. Normal server logs remain useful for comparison.

## Read the records

- `runId` identifies a GVUI document run. A full top-level reload/callback starts
  a new run; developer tools Preserve log retains the preceding Console events.
- `frameId` identifies an iframe element throughout its document navigations.
  `parentFrameId` links nested application frames to their wrappers.
- `documentId` changes on each document load, including authentication callbacks.
- `intendedWorkloadId` retains the component's first workload assignment. Inner
  application frames inherit their wrapper's intended workload, even when the
  proxy URL has already switched to another workload context.
- `contextId` is the document's proxy context; `url.workloadId` is the requested
  target. `differentWorkload` highlights a difference for investigation, not an
  authorization failure. Some cross-workload requests are legitimate.
- `iframe.*` events include `targetFrameId` and `targetIntendedWorkloadId` and
  cover explicit source assignments, inserted/parser-created frames, and actual
  loaded URLs. Compare those events with `fetch`, `xhr`, and `document` events
  to locate the earliest divergence for any of the four workloads.
- `storage.*` events report the storage area, a stable `keyId` fingerprint, and
  references to workload IDs already observed in the frame assignments. Compare
  reads and writes of the same fingerprint across frames. Raw keys and values
  are omitted. The initial scan inspects at most 100 keys in each storage area.
- `message.received` reports recognized workload references and the source
  frame ID when available. No raw message payload is recorded.
- `history.*`, `pageshow`, `pagehide`, `popstate`, and `hashchange` track routing
  and navigation. Callback URLs retain only sanitized route information from
  `redirect_uri` and JSON `state.to`.
- Synchronous hooks include `stack` source paths, line numbers, and columns.
  Insertion observers, load events, and received messages execute asynchronously
  and cannot supply the original caller's stack.

URL summaries omit arbitrary query strings, OAuth token fragments, userinfo, and
unknown path segments. Stack URLs are sanitized the same way. Storage keys are
fingerprinted, storage/message values are never logged, and credential-named
message fields and application getters are skipped. Cookies and request
headers/bodies are not inspected. URLs shown by the browser's own native logs
are outside this diagnostic filter.

The script observes native Storage methods and storage events. It does not wrap
property-style storage access, IndexedDB, service workers, or every possible
cross-frame communication API. Developer tools initiator breakpoints may still
be needed after identifying the first incorrect target. Instrumentation and
developer tools can affect race timing; a successful diagnostic run does not
establish that the issue is resolved.

## Disable or remove

Unset the flag or set it to `false`, restart the API, and close/reopen existing
diagnostic tabs. Already loaded documents retain their hooks until unloaded.

For complete removal, delete:

- `src/ampp-proxy/ampp-browser-diagnostics.ts`
- `src/ampp-proxy/__tests__/ampp-browser-diagnostics.spec.ts`
- this document

Remove the diagnostics import and the marked conditional injection block in
`src/ampp-proxy/ampp-response-rewriter.service.ts`, leaving the original
`this.createRuntimeRewriteScript(responseUrl, workloadId)` call. Remove the flag
from `.env.example` and from deployment/local environments. No other runtime
code depends on the diagnostics module.

## Isolated checks

The diagnostic tests execute the emitted browser script after the actual proxy
bootstrap in a VM with browser API doubles. They cover substitutions involving
all four workloads, frame identity through callbacks and nested re-scoping,
parser-created frames, native request/storage behavior, credential omission,
unavailable storage/console handling, insecure-context ID fallback, and bounded
in-memory collection. They do not reproduce the live AMPP race.

An additional isolated Chromium smoke check exercised the compiled production
script with intercepted fixture pages: callback frame identity, a wrong nested
application, network/storage observation, credential omission, and both disabled
and standalone-page gating passed without page errors. Live AMPP capture is
still required to identify the original selection bug.
