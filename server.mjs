/**
 * Local dev server — plain static file serving of public/ on :3000.
 * NOT required in production: the app is a pure static site (GitHub Pages).
 *
 * The one dynamic bit: /env.json exposes STAGE from .env so local dev can
 * target a different Monid environment. On static hosting the file 404s and
 * the app falls back to production.
 */
import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(__dirname, "public");
const PORT = process.env.PORT || 3000;

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2",
};

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);

  if (url === "/env.json") {
    const stage = process.env.STAGE;
    const valid = stage === "dev" || stage === "prod";
    res.writeHead(valid ? 200 : 404, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    return res.end(valid ? JSON.stringify({ STAGE: stage }) : "{}");
  }

  let file = path.normalize(path.join(PUB, url === "/" ? "index.html" : url));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`Signal Solar System (static) -> http://localhost:${PORT}`);
});
