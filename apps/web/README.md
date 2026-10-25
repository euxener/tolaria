# Tolaria Web

The web target of Tolaria: the shared React/BlockNote shell in `src/`, built as a static web app with no Tauri runtime. AGPL-3.0-or-later, like the rest of this repository.

This directory holds build and test configuration only. It does not copy `src/`; it builds it.

| Command (from the repo root) | What it does |
|---|---|
| `pnpm build:web` | Builds the shell into `apps/web/dist` |
| `pnpm preview:web` | Serves `apps/web/dist` on `127.0.0.1:4173` |
| `pnpm playwright:web` | Checks the bundle in Chromium, WebKit, iPhone 15 and iPad emulation (build first) |
| `pnpm bench:web` | Big-vault bench: a 6,000-note vault against its budgets (build first; see `docs/PERFORMANCE.md`) |
| `pnpm test:web-config` | Unit tests for the preview options, the bench budgets, the convergence report and the Sentry build helpers |
| `pnpm upload:web-sourcemaps` | Uploads the hidden source maps of the last build to Sentry; skipped without `SENTRY_AUTH_TOKEN` ([telemetry](../../docs/web/telemetry.md)) |

| File | Purpose |
|---|---|
| `vite.config.ts` | Web build and preview config, layered on the root `vite.config.ts` |
| `previewOptions.ts` | Host, port and allowed-host resolution from `TOLARIA_WEB_*` |
| `playwright.config.ts`, `tests/` | Browser checks for the static bundle |
| `playwright.bench.config.ts`, `bench/`, `bigVaultBudgets.ts` | Big-vault performance bench and its budgets |
| `tests/convergence.spec.ts`, `tests/convergenceTargets.ts`, `convergenceReport.ts`, `playwright.convergence.config.ts` | Two-device convergence of a shared note (TOL-239), locally or against a deployment; see below |
| `sentryWebBuild.ts`, `sourcemapUpload.ts`, `scripts/upload-sourcemaps.ts` | Web error telemetry: the build's own Sentry DSN and release, hidden source maps in `sourcemaps/` (never in `dist`), and their upload ([docs/web/telemetry.md](../../docs/web/telemetry.md)) |

Today the bundle runs on demo data from `src/mock-tauri/`. The remote backend that replaces it plugs in through `VaultBackend` (`src/lib/vaultBackend/`).

- Inventory, `VaultBackend`, collaboration notes and the server surface: [docs/web/s1-tauri-inventory.md](../../docs/web/s1-tauri-inventory.md)
- Testing on an iPad or iPhone: [docs/web/s2-device-test.md](../../docs/web/s2-device-test.md)
- Deliberate UI departures from desktop: [docs/web/ui-departures.md](../../docs/web/ui-departures.md)
- Decision record: [ADR 0185](../../docs/adr/0185-tolaria-web-target-and-vault-backend-seam.md)

The preview server binds to loopback by default. Read the safety rules in the device-test guide before binding it to any other address.

## Collaborative note page (spike S4, TOL-8)

`collab.html` is a second page of this build only: one note opened as a live document, with presence avatars, live cursors and a sync status. It talks to a [Tolaria server](../server/README.md) on its own origin; the preview server forwards `/v1` (websockets included) when `TOLARIA_REMOTE_URL` is set.

```bash
pnpm build:web
TOLARIA_REMOTE_URL=http://127.0.0.1:8787 pnpm preview:web
# http://127.0.0.1:4173/apps/web/collab.html?note=welcome.md
```

`pnpm playwright:web` runs the `collab` project too: it starts a server with a throwaway vault and has desktop Chromium, desktop WebKit and an iPhone viewport edit one note at once. See `docs/web/s4-spike-report.md`.

## Two-device convergence (TOL-239)

`tests/convergence.spec.ts` has a vault's owner (desktop Chromium) and an editor they shared a note with (iPhone 15 in WebKit) type into that note in turn. Each sample types a unique marker in one window, and a `MutationObserver` in each page notes when it first shows there; both browsers share the machine's clock, so the difference is the convergence time. It takes 20 samples each way after a warm-up, writes `convergence.md` and `convergence.json` (p50, p95 and max per direction and overall), and fails if p95 is not under 1000 ms or any edit is lost (`convergenceReport.ts`). The owner creates and shares the note through the API, as the Share dialog does, and revokes and deletes it at the end.

- **Locally** it runs in the `collab` project of `pnpm playwright:web`, against the run's server behind the share front of `tests/shareFront.ts`.
- **Against a deployment** nothing is started locally:

  ```bash
  TOLARIA_CONVERGENCE_BASE_URL=https://… \
  TOLARIA_CONVERGENCE_OWNER_SESSION=… TOLARIA_CONVERGENCE_EDITOR_SESSION=… \
  TOLARIA_CONVERGENCE_EDITOR=editor@example.com \
  TOLARIA_CONVERGENCE_ACCESS_CLIENT_ID=… TOLARIA_CONVERGENCE_ACCESS_CLIENT_SECRET=… \
  TOLARIA_CONVERGENCE_OUT_DIR=/tmp/convergence \
  npx playwright test --config apps/web/playwright.convergence.config.ts
  ```

  The sessions are the two accounts' `session` cookies, `TOLARIA_CONVERGENCE_EDITOR` is the editor's email (or `@` and a GitHub login), and the optional Access service token headers only go to that origin. The config records no traces or videos, which would hold those values. The hosted deployment runs this on a schedule from its own repository.
