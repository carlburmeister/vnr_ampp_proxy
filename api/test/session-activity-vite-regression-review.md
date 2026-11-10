# Session activity loading in Vite development

## Scope and baseline evidence

PR #13 loads the unchanged public tracker with a runtime dynamic import. In
Vite development, import analysis wraps the root-relative variable URL in
`injectQuery(url, 'import')`, even with `@vite-ignore`. The resulting
`/session-activity.js?import` skips public-file middleware and fails in the source
loader with ERR_LOAD_PUBLIC_URL. The production-build fixture did not exercise
Vite and missed this restriction.

Affected paths are the React hook's tracker import, the public tracker URL,
and the browser fixture. Existing throttling, timeout, cancellation, logout,
hidden-page behavior, native-fetch proxy routing, and embedded-document input
tracking must remain intact. Evidence comes from the existing 30 web tests and
the production browser fixture, now also run through real Vite in `--dev` mode.
The API's session store, authentication and database schema do not change.

The Admin repository was previously checked for shared-session compatibility;
this loader-only correction changes no shared database/API contract and needs
no Admin change.

## Smallest correction

Resolve the static tracker path against `window.location.origin` before the
existing ignored runtime import. An absolute HTTP URL is passed to native
browser import unchanged by Vite's query helper, so its public middleware serves
the file normally. It resolves to the same public asset in production. Preserve
the existing cancellation check and cleanup callback; no Vite configuration,
overlay settings, public-file format, API or database changes are required.

## Validation (dbacf9b baseline versus correction)

| Check | Baseline | Updated |
| --- | --- | --- |
| Real Vite 8.0.13 / Chromium browser fixture (`node test/session-metadata-browser.cjs --dev`) | Reproduces the overlay after login and fails | Passes without an overlay or browser errors |
| Production-build Chromium fixture (`node test/session-metadata-browser.cjs`) | Passes | Passes |
| Web unit/lifecycle tests (`cd web && npm test`) | 30 pass | Same 30 pass |
| Web production build (`cd web && npm run build`) | Previously passed in PR #13 | Passes |

Both browser modes verify the public tracker request has no `import` query,
login loads it, trusted input reports activity, idle polling does not report
interaction, logout cancels tracking, and separate proxied pages/iframes retain
their native-fetch activity reporting. The dev fixture uses the repository's
actual Vite config with an ephemeral local port and fixture API upstream.

The changed hook passes ESLint, the browser script passes its syntax check, and
the diff passes whitespace checks. Diff review confirms only the hook's URL
construction changes at runtime. Existing cancellation, cleanup, timestamp
semantics, module exports and public asset path are preserved. No Vite settings
or overlay controls are changed. No API/store/database tests were repeated
because their implementation is unchanged by this correction.

Validation uses local fixtures in Chromium; the user's macOS/Nginx deployment
was not accessed. The absolute URL derives from the browser's current origin
and retains the same host/protocol/port when using the existing reverse proxy.
