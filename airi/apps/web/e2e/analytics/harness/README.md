# Outcomes browser QA harness

This local harness mounts the actual `AnalyticsLayout` with `JourneyAnalytics` (or `DashboardPageClient`)
with the web app's en/ru/kz catalogs, global CSS, Tailwind plugin, Jotai provider,
and a fresh SWR cache, using the fixture member `qa-member`. The browser runner intercepts API requests with fixtures;
the harness has no authenticated backend. Only `next/link`, `next/navigation`
and `next/dynamic` are substituted for the client render. Links retain the
production hrefs; following them does not exercise production routing.

The temporary analytics harness was the starting candidate, but its absolute
machine paths and unrelated dashboard/specialist setup prevented portable,
Outcomes-only reuse. Vite is resolved from the existing widget package; no
dependencies or application contracts are added.

Install the existing workspace dependencies with `pnpm install` if needed.
Run these commands from `apps/web` in two terminals.

Terminal 1:

```sh
node e2e/analytics/harness/server.mjs
```

Terminal 2:

```sh
node e2e/analytics/outcomes-browser.cjs
```

The default URL is `http://127.0.0.1:3015`. To select another port in PowerShell:

```powershell
# Terminal 1
$env:ANALYTICS_QA_PORT = '3018'
node e2e/analytics/harness/server.mjs

# Terminal 2
$env:ANALYTICS_QA_URL = 'http://127.0.0.1:3018'
node e2e/analytics/outcomes-browser.cjs
```

Open `/?view=outcomes&locale=en` (or `ru` / `kz`) to inspect the screen manually.
Without intercepted requests, the component displays its normal API error
states. The runner owns theme, viewport, API fixtures, interactions, and evidence.

Open `/?view=bulk&locale=en` (or `ru` / `kz`) to mount the actual bulk analytics
component, including its campaign-health and recipient-evidence requests. Use
controlled browser route responses for those requests; this mount has no
authenticated backend and does not contact a live provider. It preserves the
existing bulk component's filters, cursor pagination and workbook download.

Open `/?view=dashboards&locale=en` to mount the customizable Dashboards home
(`DashboardPageClient` with the personal board controller) instead. With
`ANALYTICS_QA_DEMO=1` it reads a full `/api/dashboard` fixture, AI and campaign
summaries, and a preference API that recommends the Growth template, so the
dashboards list, template gallery, editing, drag-to-resize and saved layouts can
be checked without production. `next/dynamic` is replaced by a client-only
`React.lazy` shim (`dynamic.jsx`) for this view.

For a manually reviewable fixture demo, set `ANALYTICS_QA_DEMO=1` before starting
the server. Only `qa-workspace` API paths are served, using the same fixture module
as the runner. Personal layout revisions persist in server memory until restart;
other API paths are rejected and no live API is contacted. Demo epoch boundaries
use UTC; local browser date labels can differ, so cross-scope efficiency stays
unavailable. Authenticated persistence and real data are outside this harness.

The runner checks the three default reports, all seven added reports, saved
layouts, editing, failure/conflict recovery, and numerical/provider edge cases.
`ANALYTICS_QA_PREVIEW=1` captures only the first desktop/mobile screenshots.
`ANALYTICS_QA_GROUP=matrix|layout|preferences|edges` runs one bounded group.
Set `ANALYTICS_QA_OUTPUT` to choose the evidence directory. The App Router's actual
layout/page nesting is separately covered by `route-composition.test.tsx`.
Run `node --test e2e/analytics/transport-diagnostics.test.cjs` to check fixture
defaults and error classification without starting a browser.

When a local Next build/dev output exists, the harness reuses emitted Inter and
Geist Mono font faces/assets from `apps/web/.next/static`. A fresh checkout uses
the declared Arial/monospace fallback until Next has emitted those fonts; visual
font fidelity is unverified in that case. No font assets are copied or downloaded.
Restart the harness after a Next build changes those emitted font assets.
Stop the server with Ctrl+C after the run.
