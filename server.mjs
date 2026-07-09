import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 4321;

app.use(express.static(path.join(__dirname, "public")));
app.use("/vendor/three", express.static(path.join(__dirname, "node_modules/three")));

app.get("/api/data", (_req, res) => {
  const file = path.join(__dirname, "data", "company.json");
  if (!fs.existsSync(file)) {
    return res.status(503).json({
      error: "No data yet. Run `npm run fetch` to pull brand data from monid.ai.",
      company: { name: process.env.COMPANY_NAME || "Unknown" },
    });
  }
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(file);
});

app.listen(PORT, () => {
  console.log(`Brand Solar System -> http://localhost:${PORT}  (company: ${process.env.COMPANY_NAME})`);
});
