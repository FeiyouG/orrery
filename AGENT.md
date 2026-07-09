# AGENT.md — repo guide for AI agents

**Pure static site**: a Three.js frontend that renders "signal universes" —
solar systems built from internet discourse about a subject (company or
topic). Data comes from monid.ai, fetched **in the browser** with the user's
own credentials (OAuth or API key), or pre-baked by a Node CLI. There is no
backend; production only (`api.monid.ai`).

## Structure

```
.
├── public/                  # THE APP — deployable as-is to any static host
│   ├── index.html           # HUD markup: header, legend, scan panel, codex, tour, subject modal
│   ├── main.js              # 3D engine + UI (~1700 lines) — see map below
│   ├── pipeline.js          # SHARED data pipeline (browser + Node): Monid calls -> universe snapshot
│   ├── oauth.js             # Connect Monid: OAuth code + PKCE, public client (no secret exists)
│   ├── style.css            # all styling
│   └── data/                # shipped demo universes: index.json manifest + <slug>.json snapshots
├── scripts/fetch-data.mjs   # thin CLI wrapper around pipeline.js (fetch/bake demo universes)
├── server.mjs               # OPTIONAL dev static server :3000 (no logic; not needed in prod)
├── .github/workflows/pages.yml  # auto-deploys public/ to GitHub Pages on push to main
├── data/raw/<slug>/*.json   # CLI's per-subject endpoint cache (committed — paid data)
├── .env                     # SUBJECT, SUBJECT_TYPE, MONID_API_KEY — CLI only (never commit)
└── .env.example             # documented template
```

## Data flow

```
BROWSER: user connects Monid (OAuth/key) -> pipeline.js buildUniverse()
         -> raw runs cached in IndexedDB "runs", snapshot in "universes"
         -> localStorage.activeUniverse -> reload -> main.js renders

CLI:     npm run fetch|bake -> same buildUniverse(), cache = data/raw/<slug>/
         -> data/company.json (+ public/data/<slug>.json with --bake)
```

- **Auth**: OAuth (client_id `mFx1imRrM8bKuVPU`, PKCE, tokens in
  localStorage — an OAuth access token is passed to the pipeline exactly like
  an API key) or a pasted `monid_live_` key. No client secret exists anywhere
  in this repo, by design. `.env` is only read by the CLI.
- **Cache-first everywhere**: cached endpoints are free; misses fetch live and
  COST REAL MONEY. Failures (incl. provider 4xx) are cached too so rebuilds
  don't re-pay. A 402 from Monid aborts the scan with `err.payment = true`
  → UI links to https://app.monid.ai/wallet.
- Subject can be a **company** ("OpenAI") or **topic** ("GPT-5.6") —
  auto-detected: PDL must return a website + a corporate fact
  (employee_count/founded/linkedin_url), otherwise topic. PDL happily echoes
  invented records for topics — don't loosen this check.
- Company mode adds account sources (own X timeline, LinkedIn, Instagram,
  Akta intel, workplace reviews). TikTok is ALWAYS keyword search (discourse,
  not the brand's own videos). Topic mode is keyword-search everywhere.
- Every scan item carries a `url` back to the original post/video/article —
  keep this when adding sources.

## public/pipeline.js

- `buildUniverse({subject, apiKey, workspaceId?, cache?, fresh?, onProgress})`
  → `{snapshot, subjectType, balance, workspaceId}`. Storage-agnostic `cache`
  adapter: `{get(label), set(label, run)}`.
- `runEndpoint(label, provider, endpoint, input)` — POST `/v1/run`, poll
  `/v1/runs/:id`. Workspace resolves lazily (fully-cached runs never touch
  the network). `onProgress` phases: `cached | miss | done | error | normalized`.
- Gotcha: Akta enrichment 500s unless `sections` is scoped.

### Adding a data source

1. Add a `runEndpoint(...)` call to the `Promise.all` in pipeline.js
   (inspect the schema first: `monid inspect -p <provider> -e <endpoint>`).
2. Add a parser block calling `addSource({id, name, color, metrics, magnitude,
   activity, items (with per-item url!), url}, texts)`.
3. `npm run bake` (cache-first: only the new label fetches live) to refresh
   shipped demos.
4. Reload — the planet appears automatically; no frontend changes needed.

## public/main.js map (search for these)

| Section | What it owns |
|---|---|
| `classifyPlanet` / `TYPE_LABEL` | data -> planet type (gas/lava/desert/barren/terran/ocean/ice), size, rings, cities, satellites |
| `rockySkin`, `terranSkin`, `gasSkin`, ... | procedural canvas textures, seeded by source id (`mulberry32`) |
| `buildSun` | sun size=popularity, color=sentiment, flare=trend delta |
| `flyTo` + tween block in `animate` | camera flights — slerps direction around the sun + lerps radius (do NOT revert to straight lerp: it flips when crossing the core) |
| `focusPlanet` | sun-lit framing (~46° sunward), centers planet left of the scan panel; tween endpoints track orbital motion mid-flight |
| `focusSun` / `openCompanyPanel` | sun click -> subject core panel (Akta intel for companies) |
| `runTour` | cinematic tour: far shot -> overview -> sun -> selected planets -> retreat |
| `idbOpen/idbGet/idbSet/idbAll` | IndexedDB "signal-solar": stores `runs` + `universes` |
| `openSubjectModal` / `scanSubject` / `resolveAuth` | subject switcher modal, in-browser scans with live progress + cost, OAuth/key resolution, 402 wallet link |
| `handleOAuthCallback` | completes PKCE exchange on redirect return, resumes pending scan |
| label LOD in `animate` | planet labels hide < ~6px apparent radius (hysteresis) and scale font with screen size |
| `LOW_POWER` / `?stats` | perf: pixelRatio clamp 1.5, half-res bloom, 30fps cap toggle, live stats overlay |

Conventions that will bite you if ignored:

- Three.js comes from a **pinned CDN importmap** (jsdelivr). No bundler, no
  build step, all paths relative (`./`) so GitHub Pages subpaths work.
- CSS2D labels: toggle `label.visible` on the CSS2DObject, NOT
  `element.style.display` (the renderer overwrites element styles).
- All visuals must stay data-driven. If you add a visual, add its mapping to
  the VISUAL CODEX panel in `index.html` and to README "What the visuals mean".
- Sizes/orbits are tuned together (`orbitR = 27 + i * 9.5 + size * 1.8`);
  changing one usually requires rechecking sun scale, belt radius, FAR_POS.
- Monid environment is selected by the hidden `STAGE` env var (`dev`|`prod`,
  default prod; stage maps live in pipeline.js/oauth.js). Deliberately
  undocumented in README/.env.example — keep it that way.

## Verify changes

```bash
node --check public/main.js public/pipeline.js   # syntax
npm start                                        # http://localhost:3000
kill $(lsof -ti :3000)                           # stop server
```

Headless browsers usually lack WebGL — use a headed browser for screenshots.
Expected console: only a THREE.Clock deprecation warning. `?stats` shows
fps / draw calls / heap. OAuth end-to-end needs the site origin registered in
the Monid OAuth app's redirect URIs + api.monid.ai CORS allowlist.
