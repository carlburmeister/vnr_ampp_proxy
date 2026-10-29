# GVUI workload redirect isolation

The AMPP wrapper stores its post-authentication route in session storage under
`gv_redirect_<clientId>`, with `gv_redirect_fallback_<clientId>` as a one-shot
fallback. Native workload frames in a GVUI tab share that storage and OAuth
client ID. A callback that reuses an already valid shared token can therefore
restore another frame's route.

The emitted browser bootstrap now installs a small storage adapter in proxied
`/app/wrapper/` documents beneath a GVUI tab. For the wrapper's configured OAuth
client, only these two session-storage keys map to:

```text
ampp-proxy:<workloadId>:gv_redirect_<clientId>
ampp-proxy:<workloadId>:gv_redirect_fallback_<clientId>
```

The workload ID is normalized and remains stable through wrapper callbacks and
renewal documents. Get, set, and remove operations use the same mapping. Legacy
shared redirect entries are ignored and left intact for unmodified callers.
Token, ID-token, expiry, local-storage, other-client, and ordinary application
keys retain their existing behavior. OAuth parameters, workload permissions,
and server sessions are unchanged. Standalone wrappers, dashboards, and inner
application documents retain their existing storage behavior.

The fix is independent of `AMPP_PROXY_BROWSER_DIAGNOSTICS` and the removable
diagnostic module. Removing diagnostics does not remove redirect isolation.
No Admin, schema, dependency, or Web source changes are required. Rebuild/restart
the API, then close/reopen existing GVUI tabs so every wrapper receives the new
bootstrap. The vendor JavaScript bundle is not modified or checked into the repo.

## Regression checks

`src/ampp-proxy/__tests__/ampp-redirect-storage.spec.ts` executes the emitted
bootstrap in separate frame contexts sharing a session store. Its AMPP auth
behavioral fixture follows the supplied bundle's `getRedirect` and `storeToken`
logic. It covers all 24 callback orders for the four workloads, including reuse
of a valid shared token, independent fallback consumption and removal, stale
shared redirects, callback/renewal stability, and unchanged storage behavior
outside the two targeted keys. The callback-order tests fail against the old
bootstrap and pass with isolation.

The API build, 182 unit tests, and 27 isolated HTTP tests passed. Combining this
fix with the diagnostic change also passed its build and all 192 unit tests.
An isolated Chromium check executed the inspected `getRedirect` and `storeToken`
methods from the supplied AMPP bundle: disabling the adapter reproduced three
wrong frames; all 24 callback orders loaded the correct inner applications with
the adapter, both with and without diagnostics. Shared tokens and standalone
behavior were preserved, and the existing proxy policy denied SRT Input #2 for
the test grants. These fixture checks did not contact live AMPP.

## Live AMPP acceptance

Keep the current diagnostics enabled for this check if available:

1. Repeatedly close and reopen GVUI with the normal browser cache, then compare
   a separate run with cache disabled. Include simultaneous GVUI tabs.
2. Confirm Flow Monitor, Audio Mixer, Mini Mixer, and SRT Input #1 remain in their
   intended components after authentication and continue to function. SRT Input
   #2 must remain excluded by the existing client restriction.
3. Compare diagnostic intended workload IDs with callback routes, first discovery
   requests, and loaded inner application URLs. Requests for legitimate node or
   cross-workload resources are not automatically failures.
4. Retest standalone workloads, dashboards, and authentication/renewal. Save each
   tab's diagnostic export before closing it.

With diagnostics installed after the adapter, storage-operation fingerprints
identify the SDK's logical key; initial storage snapshots see the physical
namespaced keys. Identical logical fingerprints across frames are therefore
expected. Verify the selected routes and workload IDs, rather than treating
matching fingerprints as a continued collision.

Automated tests and isolated browser checks do not establish live AMPP acceptance.
The real deployment still needs this repeated-launch verification.
