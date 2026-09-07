#!/usr/bin/env node
// ---------------------------------------------------------------------------
// READ-ONLY. Answers item 8's blocking question and nothing else:
//
//   WHAT DOES /medias/files ACTUALLY RETURN PER FILE?
//
// The dashboard's own mapper keeps only { id, name, url, type, size } and the
// RawMedia interface declares no more, so the code cannot tell you whether GHL
// sends createdAt, an uploader, or a description. "Recent imports" needs
//
//     CONFIDENTIAL_candidates_19.csv
//     Musaraf · 6 Sept 2026 · Indeed · 47 rows
//
// and every field in that line has to come from somewhere. If the API carries
// them, they come from the API. If it does not, they have to go into the
// FILENAME at upload time — which is a different design, decided by this run.
//
// Usage:  GHL_PIT=pit-… GHL_LOCATION_ID=… node scripts/media-metadata-probe.mjs
// ---------------------------------------------------------------------------
const BASE = "https://services.leadconnectorhq.com";
const TOKEN = (process.env.GHL_PIT || "").trim();
const LOC = (process.env.GHL_LOCATION_ID || "").trim();
if (!TOKEN || !LOC) {
  console.error("Set GHL_PIT and GHL_LOCATION_ID.");
  process.exit(1);
}
const H = {
  Authorization: `Bearer ${TOKEN}`,
  Version: process.env.GHL_API_VERSION || "2021-07-28",
  Accept: "application/json",
};
const get = async (path) => {
  const res = await fetch(BASE + path, { headers: H });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${path} — ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

const q = (extra) =>
  `/medias/files?altType=location&altId=${encodeURIComponent(LOC)}&limit=5&${extra}`;

console.log("=== FOLDERS ===");
const folders = await get(q("type=folder"));
const frows = folders.files || folders.medias || [];
console.log(`${frows.length} folder row(s)`);
if (frows[0]) console.log("keys on a FOLDER row:", Object.keys(frows[0]).sort().join(", "));
for (const f of frows) console.log("  -", f.name, "|", f._id ?? f.id);

console.log("\n=== FILES ===");
const files = await get(q("type=file&sortBy=createdAt&sortOrder=desc"));
const rows = files.files || files.medias || [];
console.log(`${rows.length} file row(s)`);
if (!rows.length) {
  console.log("No files in the location — upload one and re-run.");
} else {
  console.log("keys on a FILE row:", Object.keys(rows[0]).sort().join(", "));
  console.log("\nFULL first row:");
  console.log(JSON.stringify(rows[0], null, 2));
  // The three the "Recent imports" line needs.
  const want = ["createdAt", "dateAdded", "createdBy", "uploadedBy", "userId", "description", "altId", "meta"];
  console.log("\nWHAT 'Recent imports' NEEDS:");
  for (const k of want) {
    const present = rows.some((r) => r[k] != null);
    console.log(`  ${present ? "YES" : "no "}  ${k}${present ? " = " + JSON.stringify(rows.find((r) => r[k] != null)[k]).slice(0, 80) : ""}`);
  }
  console.log("\nVERDICT:");
  const hasDate = rows.some((r) => r.createdAt ?? r.dateAdded);
  const hasWho = rows.some((r) => r.createdBy ?? r.uploadedBy ?? r.userId);
  console.log(`  date from API : ${hasDate ? "yes" : "NO — must go in the filename"}`);
  console.log(`  uploader from API: ${hasWho ? "yes" : "NO — must go in the filename"}`);
  console.log(`  source + row count: never in the API — always the filename or a sidecar.`);
}
