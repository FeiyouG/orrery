/**
 * Signal Solar System — CLI wrapper around the shared pipeline
 * (public/pipeline.js). Used by maintainers/power users to fetch from the
 * terminal and to pre-bake demo universes for the static site.
 *
 * Usage: npm run fetch                    (SUBJECT from .env; cache-first)
 *        SUBJECT="GPT-5.6" npm run fetch
 *        npm run fetch:fresh              (ignore cache, refetch everything)
 *        npm run fetch -- --bake          (also publish to public/data/ for
 *                                          the static site + manifest)
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildUniverse, slugify, DEFAULT_API_BASE, API_BASES } from "../public/pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const PUB_DATA = path.join(ROOT, "public", "data");

const SUBJECT = process.env.SUBJECT || process.env.COMPANY_NAME;
const SUBJECT_TYPE = (process.env.SUBJECT_TYPE || "auto").toLowerCase();
const KEY = process.env.MONID_API_KEY;
const BASE = API_BASES[process.env.STAGE] || DEFAULT_API_BASE;
const FRESH = process.argv.includes("--fresh");
const BAKE = process.argv.includes("--bake");

if (!SUBJECT || !KEY) {
  console.error("Missing SUBJECT (or COMPANY_NAME) or MONID_API_KEY in .env");
  process.exit(1);
}

const SLUG = slugify(SUBJECT);
const RAW_DIR = path.join(DATA_DIR, "raw", SLUG);
fs.mkdirSync(RAW_DIR, { recursive: true });

// file-backed cache: one JSON per endpoint label, per subject
const cache = {
  async get(label) {
    const f = path.join(RAW_DIR, `${label}.json`);
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
  },
  async set(label, run) {
    fs.writeFileSync(path.join(RAW_DIR, `${label}.json`), JSON.stringify(run, null, 2));
  },
};

function onProgress(ev) {
  if (ev.phase === "cached") console.log(`${ev.ok ? "ok " : "ERR"} ${ev.label.padEnd(14)} (cached)`);
  else if (ev.phase === "miss") console.log(`    ${ev.label.padEnd(14)} cache miss — fetching live, this will be charged`);
  else if (ev.phase === "done") console.log(`${ev.ok ? "ok " : "ERR"} ${ev.label.padEnd(14)} http=${ev.httpStatus} ${(ev.ms / 1000).toFixed(1)}s${ev.cost ? ` $${ev.cost}` : ""}`);
  else if (ev.phase === "retry") console.log(`    ${ev.label.padEnd(14)} transient ${ev.httpStatus} — retrying once`);
  else if (ev.phase === "error") console.log(`ERR ${ev.label.padEnd(14)} ${ev.error}`);
  else if (ev.phase === "normalized") console.log(`\nsubject type: ${ev.subjectType} — ${ev.sources} sources, popularity=${ev.popularity.toFixed(2)}, sentiment=${ev.sentiment.toFixed(2)}`);
}

console.log(`\nFetching signal universe for "${SUBJECT}" via ${BASE}\n`);

const { snapshot, subjectType, balance } = await buildUniverse({
  subject: SUBJECT,
  subjectType: SUBJECT_TYPE,
  apiKey: KEY,
  apiBase: BASE,
  cache,
  fresh: FRESH,
  onProgress,
});

fs.writeFileSync(path.join(DATA_DIR, "company.json"), JSON.stringify(snapshot, null, 2));
const meta = {
  subject: snapshot.company.name,
  subjectType,
  sources: snapshot.sources.length,
  updatedAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(RAW_DIR, "_meta.json"), JSON.stringify(meta, null, 2));
console.log(`Wrote data/company.json`);

if (BAKE) {
  // publish this universe for the static site + update the manifest
  fs.mkdirSync(PUB_DATA, { recursive: true });
  fs.writeFileSync(path.join(PUB_DATA, `${SLUG}.json`), JSON.stringify(snapshot));
  const manifestFile = path.join(PUB_DATA, "index.json");
  let manifest = [];
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")); } catch {}
  manifest = manifest.filter((m) => m.slug !== SLUG);
  manifest.unshift({ slug: SLUG, file: `${SLUG}.json`, ...meta });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  console.log(`Baked public/data/${SLUG}.json + manifest`);
}

if (balance != null) console.log(`Wallet balance: $${balance}`);
