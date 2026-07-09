# Signal Solar System

An interactive, sci-fi 3D visualization of internet discourse around any subject — a **company** ("OpenAI") or a **topic** ("GPT-5.6") — rendered as a living solar system.

The **sun** is the subject (its size = popularity, its color = public sentiment). Every **planet** is a data source — X/Twitter, LinkedIn, TikTok, YouTube, GitHub, Reddit, Hacker News, Instagram, news coverage, Google Search, and more. Orbit distance, planet type, rings, moons, city lights, and ship traffic are all derived from real data pulled via [Monid](https://monid.ai). Click anything to scan it, or hit **▶ CINEMATIC TOUR** to fly through the whole system.

![sci-fi solar system with planets labeled by platform](docs/screenshot.png)

## Just use it — no install

The app is a **pure static site**: open the hosted page, explore the shipped demo universes free, and click the subject name to scan any company or topic yourself. Scanning uses *your own* [Monid](https://monid.ai) account:

- **▸ CONNECT MONID** — one-click OAuth sign-in (recommended). Tokens stay in your browser.
- or paste an API key from [app.monid.ai/access/api-keys](https://app.monid.ai/access/api-keys)

You pay Monid directly for what you scan (a few cents to ~$1 per new subject); everything already scanned in your browser is cached in IndexedDB and free to revisit. Out of balance? The scan stops with a link to [top up your wallet](https://app.monid.ai/wallet).

## Self-host / develop

**Prerequisites:** Node.js 18+ (only for the dev server & CLI — the site itself is static files in `public/`).

```bash
npm install             # dotenv only
npm start               # static server -> http://localhost:3000
```

Deploys to GitHub Pages automatically on push to `main` (`.github/workflows/pages.yml`) — or host `public/` on any static host.

### Pre-baking demo universes (CLI, optional)

Maintainers can fetch universes from the terminal and ship them as free demos:

```bash
cp .env.example .env    # set SUBJECT and MONID_API_KEY (monid_live_...)
npm run fetch           # cache-first: only uncached endpoints are paid
npm run bake            # same + publishes to public/data/ for the static site
npm run fetch:fresh     # ignore cache, re-pay for everything
```

## Setup with an AI agent

Paste this into your coding agent (Claude Code, Cursor, Codex, etc.):

```text
Set up this project for me:

1. Read AGENT.md in this repo to understand the structure.
2. npm install && npm start, then open http://localhost:3000 and verify the
   shipped demo universes render.
3. If I want to pre-bake a new demo universe: follow https://monid.ai/skill.md
   to set up the Monid CLI, cp .env.example .env with my SUBJECT and
   MONID_API_KEY, then npm run bake (paid Monid calls — confirm with me first
   and report the cost after).
```

## Using it

| Action | How |
|---|---|
| Switch universe | click the subject name (top left) — pick a cached subject or type a new one and hit ⏎ |
| Look around | drag to rotate · scroll to zoom · right-drag to pan |
| Scan a planet | click it (or use the legend, left side) — opens the planetary scan panel with metrics, keywords, and top posts (each links to the original tweet/video/article) |
| Scan the company core | click the sun — valuation, revenue, users, market position (PDL + Akta intel) |
| Back to overview | `Esc` or ✕ on the panel |
| Understand the visuals | **◈ VISUAL CODEX** button (bottom left) explains every visual mapping |
| Cinematic tour | **▶ CINEMATIC TOUR** (top right) — flies from deep space through the sun and every selected planet, then back out |
| Tour options | ⚙ next to the tour button: playback speed (0.5–2.5×) and which stops to visit |

The tour is designed to be easy to screen-record (e.g. macOS `⌘⇧5` or QuickTime) — steady flights, timed dwells on each scan panel, and a clean pull-back ending.

## What the visuals mean

Everything is data-driven — nothing is decorative:

- **Sun** — size/glow = brand popularity · color temperature = overall sentiment (red dwarf = hostile, white-hot = loved) · flare activity = rising search interest
- **Orbit distance** — discussion heat; the hottest platforms orbit closest
- **Planet size** — audience reach (biggest reach → gas giants)
- **Planet type** — ocean/terran = positive sentiment · lava/barren = negative · ice = calm outer worlds · desert = hot inner worlds
- **Rings** — top-3 platforms by keyword diversity
- **Moons** — the platform's top keywords (labels appear when focused)
- **City lights** (night side) — high engagement
- **Satellites** — high posting activity
- **Ship traffic** — inbound activity/engagement rate

## Caching (browser and CLI)

Everything is **cache-first** — an endpoint already fetched is never paid for twice:

- **In the browser**: raw responses + universes persist per subject in IndexedDB. Re-scanning a subject only pays for missing endpoints; the scan log shows each endpoint's status and cost live.
- **In the CLI**: same logic, backed by `data/raw/<subject-slug>/*.json` (committed, so demo universes rebuild free forever).

## Companies vs topics

`SUBJECT` accepts anything people talk about:

```bash
SUBJECT="OpenAI"  npm run fetch     # company mode
SUBJECT="GPT-5.6" npm run fetch     # topic mode
```

The mode is auto-detected (PDL company lookup). **Company mode** adds account-based planets — the company's own X timeline, LinkedIn profile, Instagram/TikTok accounts, workplace reviews, and Akta intel (valuation, revenue, market position) on the sun. **Topic mode** builds every planet from keyword search across X, Reddit, Hacker News, YouTube, news, GitHub, Xiaohongshu, and Google Trends. Force a mode with `SUBJECT_TYPE=company|topic` if the auto-detection guesses wrong.

Once a subject has been fetched, switching between them is free — either click the subject name in the webapp, or:

```bash
SUBJECT="OpenAI" npm run fetch && npm start
```
