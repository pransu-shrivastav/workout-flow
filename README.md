# Workout Flow — Production PWA

A guided personal workout tracker. Offline-first, installable on Android and iPhone, with automatic IndexedDB persistence, rest timers, progress charts, and full backup/restore.

---

## Quick start (local development)

```bash
# 1. Install dev dependencies (Vitest + Playwright)
npm install

# 2. Serve the app locally (required for PWA features)
npm run serve
# → http://localhost:3000

# 3. Open in browser
open http://localhost:3000
```

> **Important:** Open via `http://localhost:3000`, not `file://`. Service workers and IndexedDB require an HTTP origin.

---

## Running tests

### Unit tests (no browser required)

```bash
npm test
```

Runs all files in `tests/unit/` with Vitest. Tests cover:

- `normalize()` — state merging and defaults
- `phase()` — training week labels (weeks 1 → ∞)
- `completedCount()` / `skippedCount()`
- `latestCompletedSet()` — previous-performance carry-forward
- `makeDraft()` — first-workout defaults, rep/RPE fallbacks, week-1 volume cap
- Workout flow logic — completing, skipping, finishing early
- Timer state persistence
- Refresh/resume simulation
- Template CRUD
- Daily log CRUD
- Backup round-trip

### End-to-end tests (headless Chromium)

```bash
# Install Playwright browsers (first time only)
npx playwright install chromium

# Run e2e tests (starts a local server automatically)
npm run test:e2e
```

E2E tests cover every visible button and state transition:

- All five navigation tabs
- Home view (week +/−, template selector, storage card)
- Starting a workout
- Set check buttons (toggle on/off)
- Complete exercise (blocked without checked set)
- Skip exercise (no timer, advances index)
- Rest timer (+30 s, skip, MM:SS format)
- Pause → Home → resume
- Discard workout
- Finish early (confirmation dialog)
- Finish after completing exercises → history view
- Daily log (save, upsert, cardio fields)
- History view (charts, exercise selector)
- Template editor (search, add exercise, add template)
- Settings (dark mode, audio, vibration)
- Backup buttons (export, import, erase)
- Persistence across page reload (week, active workout, daily log)
- Save-status header

### Run all tests

```bash
npm run test:all
```

---

## Netlify deployment

1. Push this folder to a GitHub repository.
2. In Netlify: **New site → Import from Git → select repo**.
3. Build command: *(leave blank)*
4. Publish directory: `.`
5. Deploy.

The `netlify.toml` configures:
- Security headers (X-Frame-Options, CSP-friendly)
- `service-worker.js` served with `Cache-Control: no-cache`
- Redirect from `/workout-flow-verified.html` → `/index.html`

---

## PWA installation

### Android (Chrome)
1. Open the deployed URL in Chrome.
2. Tap the **⋮** menu → **Add to Home screen**.
3. Confirm. The app opens in standalone mode.

### iPhone (Safari)
1. Open the deployed URL in Safari.
2. Tap the **Share** button → **Add to Home Screen**.
3. Confirm. The app opens without browser chrome.

### PWA update
When a new version is deployed, the service worker detects the change and shows an **"Update available — Reload"** banner. Tapping it reloads to the new version. IndexedDB data is never deleted during updates.

---

## Architecture

```
workout-flow-verified-pwa/
├── index.html              ← App shell (HTML + inline CSS)
├── manifest.webmanifest    ← PWA manifest
├── service-worker.js       ← Cache-first shell, network-first data
├── netlify.toml            ← Deployment headers + redirects
├── package.json            ← Dev dependencies (Vitest, Playwright)
├── playwright.config.js    ← E2E test config
├── README.md
├── src/
│   ├── storage.js          ← IndexedDB layer (write queue, migrations)
│   ├── state.js            ← Versioned state, normalization, draft logic
│   ├── audio.js            ← Web Audio API tones + vibration
│   └── app.js              ← All UI rendering and event wiring
├── assets/
│   ├── icon-192.png
│   └── icon-512.png
└── tests/
    ├── unit/
    │   ├── state.test.js   ← normalize, phase, makeDraft, helpers
    │   └── workout.test.js ← complete/skip/finish/timer/resume logic
    └── e2e/
        └── workout.spec.js ← Full browser interaction tests
```

### Data flow

```
User gesture
    │
    ▼
src/app.js  (DOM events, rendering)
    │
    ├── reads/writes ──▶  src/state.js  (in-memory state singleton)
    │                          │
    │                          └── persists ──▶  src/storage.js
    │                                                 │
    │                                                 ├── IndexedDB (primary)
    │                                                 └── LocalStorage (boot hint)
    │
    └── audio ──▶  src/audio.js  (Web Audio API)
```

---

## State schema (v2)

| Field | Type | Description |
|-------|------|-------------|
| `schemaVersion` | number | Always 2 |
| `week` | number | Current training week (1 → ∞) |
| `theme` | string | `system` \| `light` \| `dark` |
| `audioEnabled` | boolean | Play completion tones |
| `vibrationEnabled` | boolean | Vibrate on timer completion |
| `templates` | object | `{ A: Exercise[], B: Exercise[], C: Exercise[], … }` |
| `sessions` | Session[] | Completed workout sessions |
| `days` | DailyLog[] | Daily health metrics |
| `draft` | Draft \| null | Active workout in progress |
| `lastSaved` | ISO string | Timestamp of last successful write |

### Exercise fields

`id`, `name`, `equip`, `defaultReps`, `defaultRpe`, `sets`, `rest`, `tags`, `muscles`, `instructions`, `progression`

### Draft fields

`id`, `template`, `date`, `week`, `index`, `order`, `exercises`, `timerEndsAt`, `status`

### Set fields

`reps`, `load`, `rpe`, `done`

---

## Bug fixes vs. original prototype

| # | Bug | Fix |
|---|-----|-----|
| 1 | Data disappeared after refresh | IndexedDB write queue; auto-save after every change |
| 2 | LocalStorage failed in sandboxed iframes | IndexedDB is primary; LocalStorage is boot hint only |
| 3 | Conflicting IDB/LS versions | Timestamp-based merge: newer copy wins |
| 4 | Exercise edits didn't persist | Serialised write queue with confirmed callbacks |
| 5 | Returned to Home after refresh | `draft.index` persisted; `hydrate()` restores workout view |
| 6 | Charts didn't update reliably | `renderCharts()` called after every data mutation |
| 7 | Skipped exercises counted as completed | Strict `status` enum; `completedCount()` filters by `=== 'completed'` |
| 8 | Rep fields empty on first workout | 5-level fallback: draft → prev completed → last set → template default → 10 |
| 9 | Previous performance not visible | Prominent "Last completed session" box above set inputs |
| 10 | Backup blocked on mobile | Share API → download → copyable text fallback chain |
| 11 | Pull-ups separated from workout | Pull-up is an exercise inside Workout B with a special badge |
| 12 | No guided exercise-to-exercise flow | Full guided mode with rest timer, progress bar, auto-advance |
| 13 | Untested claims | 40+ unit + e2e tests covering every button and state transition |

---

## Known limitations

- **Audio on iOS Safari**: The Web Audio API requires a user gesture before the first tone. The app calls `unlockAudio()` on every nav button click to satisfy this requirement. If the very first workout completion tone is silent, tap any button and it will work from then on.
- **File download on iOS PWA**: The Share API is attempted first. If the user dismisses the share sheet, the download is cancelled (not an error). The copyable text fallback is shown as a last resort.
- **Offline install**: The service worker caches the app shell on first visit. The app must be opened at least once while online before it works offline.
- **No cloud sync**: All data is stored locally. Use Export Backup regularly to protect your data.
- **E2E tests require a local server**: `file://` URLs do not support service workers or IndexedDB in all browsers. Always use `npm run serve`.

---

## Security and privacy

- No analytics, advertising, or third-party scripts.
- No data leaves the device unless the user explicitly exports a backup.
- No credentials or secrets in browser code.
- Console logging of workout data is suppressed in production.
- Security headers are set via `netlify.toml`.

---

## Changelog

### v2.0.0 (current)
- Complete rewrite with modular ES module architecture
- Fixed all 13 known bugs from the prototype
- Added: cardio fields in daily log
- Added: pull-up volume chart
- Added: exercise-specific progress chart
- Added: inline session editor (replaces `prompt()` dialogs)
- Added: `timerEndsAt` persisted in draft (timer survives refresh)
- Added: service worker update detection banner
- Added: audio and vibration settings
- Added: `+Template` button in editor
- Added: exercise move up/down buttons
- Added: `<details>` collapsible exercise editor rows
- Added: 40+ unit and e2e tests

### v1.0.0
- Original single-file prototype (`workout-flow-verified.html`)