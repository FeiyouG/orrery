import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4321;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/vendor/three", express.static(path.join(__dirname, "node_modules/three")));

app.get("/api/data", (_req, res) => {
  const file = path.join(__dirname, "data", "company.json");
  if (!fs.existsSync(file)) {
    return res.status(503).json({
      error: "No data yet. Run `npm run fetch` to pull brand data from monid.ai.",
      company: { name: process.env.SUBJECT || process.env.COMPANY_NAME || "Unknown" },
    });
  }
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(file);
});

// ---- subject switching -----------------------------------------------------

// list cached subjects (one dir per subject under data/raw/)
app.get("/api/subjects", (_req, res) => {
  const rawRoot = path.join(__dirname, "data", "raw");
  let subjects = [];
  if (fs.existsSync(rawRoot)) {
    subjects = fs.readdirSync(rawRoot)
      .filter((d) => fs.statSync(path.join(rawRoot, d)).isDirectory())
      .map((slug) => {
        let meta = null;
        try { meta = JSON.parse(fs.readFileSync(path.join(rawRoot, slug, "_meta.json"), "utf8")); } catch {}
        return {
          slug,
          name: meta?.subject || slug.replace(/-/g, " "),
          subjectType: meta?.subjectType || null,
          sources: meta?.sources ?? null,
          updatedAt: meta?.updatedAt || null,
        };
      })
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
  let current = null;
  try { current = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "company.json"), "utf8")).company.name; } catch {}
  res.json({ subjects, current, fetching: fetching?.subject ?? null });
});

// switch to (or create) a subject: runs the cache-first pipeline and
// responds when data/company.json has been rebuilt
let fetching = null;
app.post("/api/subject", (req, res) => {
  const subject = String(req.body?.subject || "").trim().slice(0, 80);
  if (!subject) return res.status(400).json({ error: "subject required" });
  if (fetching) return res.status(409).json({ error: `already fetching "${fetching.subject}"` });

  fetching = { subject, startedAt: Date.now() };
  const child = spawn(process.execPath, [path.join(__dirname, "scripts", "fetch-data.mjs")], {
    cwd: __dirname,
    env: { ...process.env, SUBJECT: subject },
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });
  child.on("close", (code) => {
    fetching = null;
    res.json({ ok: code === 0, subject, log: log.slice(-4000) });
  });
  child.on("error", (err) => {
    fetching = null;
    res.status(500).json({ ok: false, error: err.message });
  });
});

app.listen(PORT, () => {
  let subject = process.env.SUBJECT || process.env.COMPANY_NAME || "no data yet";
  try {
    // the loaded snapshot is the source of truth, not .env
    subject = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "company.json"), "utf8")).company.name;
  } catch { /* no snapshot yet */ }
  console.log(`Signal Solar System -> http://localhost:${PORT}  (subject: ${subject})`);
});
