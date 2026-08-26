#!/usr/bin/env node
/**
 * STEP 0 (Task 1) — confirm the GHL media UPLOAD endpoint + that parentId lands
 * the file in the OLTL Resources folder (not the media root), and that the PIT
 * has media WRITE scope. Run where the PIT works (this sandbox can't reach GHL).
 *
 *   $env:GHL_PIT="pit-..."
 *   node scripts/resources-upload-probe.mjs
 *
 * It uploads a tiny throwaway text file, then lists the folder to see if it
 * landed there. Delete the test file in GHL afterward.
 */
const BASE = "https://services.leadconnectorhq.com";
const TOKEN = (process.env.GHL_PIT || "").trim().replace(/^Bearer\s+/i, "");
const LOC = (process.env.GHL_LOCATION_ID || "anzcWt3S0tzpu2fEaS8X").trim();
const FOLDER = (process.env.RESOURCES_FOLDER_ID || "").trim();
if (!TOKEN) { console.error("Set GHL_PIT."); process.exit(1); }

const H = { Authorization: `Bearer ${TOKEN}`, Version: "2021-07-28", Accept: "application/json" };

async function main() {
  const name = `oltl-upload-probe-${Date.now()}.txt`;
  const form = new FormData();
  form.append("file", new Blob(["OLTL upload probe — safe to delete."], { type: "text/plain" }), name);
  form.append("hosted", "false");
  form.append("name", name);
  form.append("parentId", FOLDER);

  console.log(`Uploading ${name} with parentId=${FOLDER} …`);
  const res = await fetch(`${BASE}/medias/upload-file`, { method: "POST", headers: H, body: form });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch { j = text; }
  console.log("Upload HTTP", res.status);
  if (!res.ok) {
    console.log("Body:", String(text).slice(0, 600));
    if (res.status === 401) console.log("→ 401: PIT likely missing media WRITE scope. Add medias/media (write) to the Private Integration.");
    return;
  }
  console.log("Upload response keys:", Object.keys(j).join(", "));
  console.log("Response (trimmed):", JSON.stringify(j, null, 2).slice(0, 700));
  const uploadedId = j.id ?? j.fileId ?? "(none)";
  const reportedParent = j.parentId ?? j.folderId ?? "(not returned)";
  console.log(`\nUploaded id: ${uploadedId}`);
  console.log(`parentId in response: ${reportedParent}`);

  // Verify by listing the folder.
  const p = new URLSearchParams({ altType: "location", altId: LOC, type: "file", limit: "100", offset: "0", parentId: FOLDER });
  const lr = await fetch(`${BASE}/medias/files?${p}`, { headers: H });
  const lj = await lr.json().catch(() => ({}));
  const files = lj.files || lj.medias || [];
  const found = files.find((f) => String(f.name ?? f.fileName) === name);
  console.log(`\nList HTTP ${lr.status} — file present in OLTL Resources folder? ${found ? "YES ✅ (parentId honored)" : "NO ❌ (landed at root — parentId ignored by this tenant)"}`);
  console.log("\n>> Report: upload HTTP status, whether the file appears in the folder, and the response's id/url/parentId field names.");
  console.log(">> Then delete the probe file in GHL.");
}
main().catch((e) => { console.error(e); process.exit(1); });
