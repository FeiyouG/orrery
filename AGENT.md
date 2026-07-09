# AGENT.md — repo guide for AI agents

Single-page 3D "brand solar system": a Node/Express server serves a static
Three.js frontend plus one JSON endpoint. A separate fetch script pulls brand
data from Monid and writes a normalized snapshot the frontend renders.

## Structure

```
.
├── server.mjs              # Express :4321 — serves public/, /api/data, /vendor/three
├── scripts/
│   └── fetch-data.mjs      # Monid pipeline: ~18 endpoints -> data/company.json
├── public/
│   ├── index.html          # HUD markup: header, legend, scan panel, codex, tour controls
│   ├── main.js             # THE 3D engine (one file, ~1400 lines) — see map below
│   └── style.css           # all HUD styling
├── data/
│   ├── company.json        # normalized snapshot of the CURRENT subject (gitignored — regenerable)
│   └── raw/<subject>/*.json # cached raw API responses per subject (committed — paid data)
├── .env                    # SUBJECT, SUBJECT_TYPE, MONID_API_KEY, MONID_API_BASE_URL (never commit)
└── .env.example            # documented template
```

## Data flow

```
scripts/fetch-data.mjs ──> data/company.json ──> server.mjs /api/data ──> public/main.js
        (paid API calls)      { company, sources[] }                        (render only)
```

- The frontend NEVER calls Monid. It renders whatever `/api/data` returns.
- The subject can be a **company** ("OpenAI") or a **topic** ("GPT-5.6").
  Auto-detected via PDL lookup (override with `SUBJECT_TYPE`). Company mode
  adds account-based sources (own X timeline, LinkedIn/Instagram/TikTok
  accounts, Akta intel, workplace reviews); topic mode is keyword-search only
  (X search, Reddit, HN, YouTube, news, GitHub, XHS, Google Trends) and the
  output carries `company.subjectType` so the frontend adapts labels.
- `company.json` is gitignored but fully regenerable per subject:
  `SUBJECT="X" npm run fetch` rebuilds it from `data/raw/<subject-slug>/`.
- `npm run fetch` is CACHE-FIRST: cached endpoints are free; misses fetch
  live and COST REAL MONEY (announced per endpoint: "cache miss ... will be
  charged"). `npm run fetch:fresh` ignores the cache and re-pays for
  everything — confirm with the user before fresh runs on new subjects, and
  report cost after (wallet balance is printed).

## scripts/fetch-data.mjs

- `runEndpoint(label, provider, endpoint, input)` — POST `/v1/run` with
  `{ input: { queryParams } }`, polls `/v1/runs/:id`, caches raw output to
  `data/raw/<subject-slug>/<label>.json`. Cache-first by default; `--fresh`
  bypasses the cache. Subject-type detection requires PDL to return a website
  plus a corporate fact (employee_count/founded/linkedin_url) — PDL happily
  echoes invented records for topics, so don't loosen this.
- Per-source parser blocks call `addSource({id, name, color, metrics,
  magnitude, activity, items, url}, texts)` — keyword + sentiment extraction
  happens inside `addSource`.
- Derived stats at the bottom: `engagementRate`, `kwDiversity`, damped
  `sentiment`, `company.trend` (Google Trends), `company.intel` (Akta:
  valuation/revenue/users/market position; feeds the sun's scan panel).
- Gotchas: Akta enrichment 500s unless `sections` is scoped; test keys only
  work against `https://api.dev.monid.ai`.

### Adding a data source

1. Add a `runEndpoint(...)` call to the `Promise.all` (inspect the schema
   first: `monid inspect -p <provider> -e <endpoint>`).
2. Add a parser block mapping the raw shape to `addSource(...)`.
3. `npm run fetch` (cache-first: only the new label fetches live).
4. Reload — the planet appears automatically; no frontend changes needed.

## public/main.js map (search for these)

| Section | What it owns |
|---|---|
| `classifyPlanet` / `TYPE_LABEL` | data -> planet type (gas/lava/desert/barren/terran/ocean/ice), size, rings, cities, satellites |
| `rockySkin`, `terranSkin`, `gasSkin`, ... | procedural canvas textures, seeded by source id (`mulberry32`) |
| `buildSun` | sun size=popularity, color=sentiment, flare=trend delta |
| `buildPlanet` | mesh + ring + keyword moons + satellites + name label |
| `flyTo` + tween block in `animate` | camera flights — slerps direction around the sun + lerps radius (do NOT revert to straight lerp: it flips when crossing the core) |
| `focusPlanet` | sun-lit framing (~46° sunward), centers planet in the viewport area left of the scan panel; tween endpoints track orbital motion mid-flight |
| `focusSun` / `openCompanyPanel` | sun click -> PDL + Akta intel panel |
| `runTour` | cinematic tour: far shot -> overview -> sun -> selected planets -> retreat |
| label LOD in `animate` | planet labels hide < ~6px apparent radius (hysteresis) and scale font with screen size |

Conventions that will bite you if ignored:

- Three.js is served from local `node_modules` via importmap (`/vendor/three/...`).
  No bundler, no build step — plain ES modules.
- CSS2D labels: toggle `label.visible` on the CSS2DObject, NOT
  `element.style.display` (the renderer overwrites element styles).
- All visuals must stay data-driven. If you add a visual, add its mapping to
  the VISUAL CODEX panel in `index.html` and to README "What the visuals mean".
- Sizes/orbits are tuned together (`orbitR = 27 + i * 9.5 + size * 1.8`);
  changing one usually requires rechecking sun scale, belt radius, FAR_POS.

## Verify changes

```bash
node --check public/main.js        # syntax
npm start                          # then open http://localhost:4321
kill $(lsof -ti :4321)             # stop server
```

Headless browsers usually lack WebGL — use a headed browser for screenshots.
Expected console: only a THREE.Clock deprecation warning. Check FPS stays
near 60 with all planets + tour running.
