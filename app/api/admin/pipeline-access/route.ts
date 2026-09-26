import { NextResponse } from "next/server";
import {
  listLocationUsers,
  listPipelines,
  fetchAccessGrantsV2,
  saveAccessGrantsV2,
  listMediaFolders,
  getPipelineConfig,
  explainGhlError,
  GhlError,
} from "@/lib/ghl";
import { decryptSso, SsoError, ssoConfigured } from "@/lib/sso";
import { isAdminSession } from "@/lib/visibility";
import type { ApiError } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Admin-only, enforced SERVER-SIDE (not merely hidden in the UI).
function gate(request: Request, ssoKey?: string): NextResponse | null {
  if (!ssoConfigured()) return null;
  const blob = ssoKey || request.headers.get("x-ghl-sso-key");
  if (!blob)
    return NextResponse.json(
      { error: "Sign-in required.", status: 401 } as ApiError,
      { status: 401 },
    );
  const s = decryptSso(blob);
  if (!isAdminSession(s.role, s.type))
    return NextResponse.json(
      { error: "Admin only.", status: 403 } as ApiError,
      { status: 403 },
    );
  return null;
}

function fail(e: unknown): Promise<NextResponse> | NextResponse {
  if (e instanceof SsoError)
    return NextResponse.json(
      { error: e.message, status: e.status } as ApiError,
      { status: e.status },
    );
  if (e instanceof GhlError)
    return explainGhlError(e).then((detail) =>
      NextResponse.json({ error: "Request failed.", detail } as ApiError, {
        status: e.status >= 400 && e.status < 600 ? e.status : 502,
      }),
    );
  return NextResponse.json(
    { error: "Request failed.", detail: String(e) } as ApiError,
    { status: 500 },
  );
}

// GET — everything the grid needs, all fetched LIVE:
//   users     from GHL (new staff appear automatically)
//   pipelines from GHL — ALL of them, each flagged whether the dashboard
//             actually loads it, so granting access to a pipeline outside
//             PIPELINE_IDS is visible rather than silently inert
//   grants    from the custom value (null => the env fallback is in play)
export async function GET(request: Request) {
  try {
    const denied = gate(request);
    if (denied) return denied;

    // ITEM 6b — folders are a SECOND grid in this tab, from the same custom
    // value under its own key. Fetched here so the admin grants pipelines,
    // folders and the Master view in one place and one save.
    // 🔴 This was `listMediaFolders().catch(() => [])`. A bare swallow turned
    // EVERY failure — a 401 from a PIT without medias.readonly, a network blip,
    // a shape change — into the same empty array, which the grid then reported
    // as the flat statement "no media folders were returned for this location".
    // That sentence was untrue and, worse, unfalsifiable: there was no way to
    // tell "none exist" from "the call failed". Keep the tab working when the
    // folder read fails, but SAY the read failed and why.
    let foldersError: string | null = null;
    const [users, pipelines, stored, folders] = await Promise.all([
      listLocationUsers(),
      listPipelines(),
      fetchAccessGrantsV2(),
      listMediaFolders().catch(async (e) => {
        foldersError =
          e instanceof GhlError ? await explainGhlError(e) : String(e);
        // eslint-disable-next-line no-console
        console.error("[access] the media-folder list failed:", foldersError);
        return [];
      }),
    ]);
    // ═══════════════════════════════════════════════════════════════════════
    // 🔴 ROUND 127 · ITEM 1 — DERIVED FROM THE STORED CONFIG, NOT FROM AN ENV
    // VAR. This read `pipelineIds()` and `caregiverPipelineIds()`, both of
    // which are ENVIRONMENT LISTS whose defaults hold the two original
    // caregiver ids. So the three staff pipelines — created by script, given
    // scope and a recruiting group on the Pipelines screen, drawn by the
    // board, listed by the picker, shown by the Recruiting switcher — were
    // reported "not loaded" HERE and nowhere else.
    //
    // 🔴 TWO MECHANISMS ANSWERING ONE QUESTION, one silently winning. Same
    // shape as /api/clients rule 2 (two owners) and the stage bug (five call
    // sites in one file while a sixth lived elsewhere). The stored config
    // already knows, an admin already sets it, and a pipeline added next month
    // needs a dropdown rather than an environment variable and a deploy.
    //
    // ⚠️ "LOADED" MEANS "SOMETHING ACTUALLY FETCHES IT", which is narrower than
    // "it has an entry", and the difference matters because this badge is a
    // promise that ticking the box does something:
    //
    //   client    fetched by the client board                       ✓
    //   caregiver fetched by the recruiting board                   ✓
    //   none      fetched by NOTHING unless it carries the events
    //             role, in which case the Referrals tab reads it    ✓/✗
    //
    // A pipeline with no stored entry at all is fetched by nothing, which is
    // exactly what the original badge was for.
    //
    // ⚠️ AND THE ENV VARS STAY — for the two jobs they still do, neither of
    // which is this one. See the report: the one-time seed of a fresh account,
    // and the fallback inside getSelectedPipelines() when the stored config
    // cannot be read, so a GoHighLevel blip does not empty every board.
    const cfg = await getPipelineConfig();
    const entryOf = (id: string) => cfg.pipelines[id];
    const loadedReason = (id: string): string => {
      const e = entryOf(id);
      if (!e)
        return "It has no entry on the Pipelines screen, so nothing fetches it and a grant here has no effect.";
      if (e.scope === "none" && e.role !== "events")
        return "Its scope is “listed by no board picker” and it carries no role, so nothing fetches its records.";
      return "";
    };
    const loaded = new Set(
      pipelines.filter((p) => !loadedReason(p.id)).map((p) => p.id),
    );

    return NextResponse.json(
      {
        users,
        pipelines: pipelines.map((p) => ({
          id: p.id,
          name: p.name,
          // false => the dashboard doesn't fetch this pipeline yet; add it to
          // PIPELINE_IDS for grants here to have any effect.
          inDashboard: loaded.has(p.id),
          // ⚠️ WHY, NOT JUST WHETHER. "not loaded" sent an admin looking for an
          // environment variable they cannot change; the fix is one dropdown on
          // the Pipelines screen, and the badge now says so.
          notLoadedWhy: loadedReason(p.id) || undefined,
        })),
        // Folders read LIVE from GHL — a folder created in GHL appears here
        // with no code change, same as users and pipelines.
        folders,
        // null when the read succeeded. When set, the grid must say the read
        // FAILED rather than claiming there are no folders.
        foldersError,
        grants: stored?.pipelines ?? {},
        folderGrants: stored?.folders ?? {},
        masterUsers: stored?.master ?? [],
        // TASK 1 — the case-manager map, from the same single read. The tab
        // renders it from the LIVE user list, so only ids travel here.
        caseManagers: stored?.caseManagers ?? {},
        referralAccess: stored?.referralAccess ?? {},
        publicFolderId: (process.env.RESOURCES_PUBLIC_FOLDER_ID || "").trim(),
        // true => nothing readable is stored yet, so the env var is what's
        // actually in force until the first save.
        usingEnvFallback: stored === null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}

// PUT { ssoKey?, grants } — writes the whole map as one JSON custom value.
export async function PUT(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      ssoKey?: string;
      grants?: Record<string, string[]>;
      folderGrants?: Record<string, string[]>;
      masterUsers?: string[];
      /** TASK 1 — rep user id → the managers who follow their cases. */
      caseManagers?: Record<string, string[]>;
      /** ROUND 161 — user id → their referral-visibility override. */
      referralAccess?: Record<string, unknown>;
    };
    const denied = gate(request, body.ssoKey);
    if (denied) return denied;

    // Each scope is OPTIONAL and saved independently. saveAccessGrantsV2 merges
    // against what is stored, so a request carrying only `folderGrants` cannot
    // wipe every pipeline grant on the account — which a naive whole-object
    // write would do the first time the folders grid saves on its own.
    const norm = (
      g: Record<string, string[]> | undefined,
    ): Record<string, string[]> | undefined => {
      if (g === undefined) return undefined;
      if (!g || typeof g !== "object" || Array.isArray(g)) return undefined;
      const clean: Record<string, string[]> = {};
      for (const [userId, ids] of Object.entries(g)) {
        if (!userId || !Array.isArray(ids)) continue;
        const list = [...new Set(ids.map(String).filter(Boolean))];
        if (list.length) clean[userId] = list; // drop empties; keeps it readable
      }
      return clean;
    };

    // ⚠️ `norm` DROPS AN EMPTY ARRAY, and for the case-manager map that is the
    // right behaviour rather than a limitation — see the report. Removing a
    // rep's last manager deletes the key, the row disappears from the tab, and
    // `applyCaseManagers` still removes what it added because the test is its
    // own stored record, not the map. The `[]` state stays meaningful in the
    // storage model and is simply not something this screen can produce.
    // ═══ ROUND 161 — ITS OWN NORMALISER, AND `norm` WOULD HAVE BROKEN IT ═════
    //
    // 🔴 `norm` DROPS AN EMPTY ARRAY (see its comment above). For case managers
    // that is right; here it is the bug this feature exists to avoid. "Divisions,
    // none selected" is the way an admin says "this person sees NO referrals" —
    // run it through `norm` and it saves as absent, reads back as DERIVED, and
    // the person falls straight to their pipeline grants. The one thing the
    // three states are for, deleted on save.
    //
    // ⚠️ AND AN UNRECOGNISED MODE IS DROPPED RATHER THAN WIDENED. Anything that
    // is not "agency" or "divisions" becomes absent — derived — because guessing
    // "agency" would hand out access nobody granted.
    const normReferral = (
      g: Record<string, unknown> | undefined,
    ): Record<string, { mode: "agency" } | { mode: "divisions"; divisions: string[] }> | undefined => {
      if (g === undefined) return undefined;
      if (!g || typeof g !== "object" || Array.isArray(g)) return undefined;
      const clean: Record<string, { mode: "agency" } | { mode: "divisions"; divisions: string[] }> = {};
      for (const [userId, raw] of Object.entries(g)) {
        if (!userId || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const e = raw as Record<string, unknown>;
        if (e.mode === "agency") clean[userId] = { mode: "agency" };
        else if (e.mode === "divisions")
          clean[userId] = {
            mode: "divisions",
            // 🔴 KEPT WHEN EMPTY. This is the whole point.
            divisions: Array.isArray(e.divisions)
              ? [...new Set(e.divisions.map(String).filter(Boolean))]
              : [],
          };
      }
      return clean;
    };

    const referralAccessPatch = normReferral(body.referralAccess);
    const caseManagersPatch = norm(body.caseManagers);
    const pipelinesPatch = norm(body.grants);
    const foldersPatch = norm(body.folderGrants);
    const masterPatch = Array.isArray(body.masterUsers)
      ? [...new Set(body.masterUsers.map(String).filter(Boolean))]
      : undefined;

    if (!pipelinesPatch && !foldersPatch && !masterPatch && !caseManagersPatch)
      return NextResponse.json(
        {
          error: "Nothing to save.",
          detail:
            "Send `grants` (userId -> pipelineId[]), `folderGrants` (userId -> folderId[]), `masterUsers` (userId[]) or `caseManagers` (repId -> managerId[]).",
        } as ApiError,
        { status: 400 },
      );

    const { id } = await saveAccessGrantsV2({
      ...(pipelinesPatch ? { pipelines: pipelinesPatch } : {}),
      ...(foldersPatch ? { folders: foldersPatch } : {}),
      ...(masterPatch ? { master: masterPatch } : {}),
      ...(caseManagersPatch ? { caseManagers: caseManagersPatch } : {}),
      ...(referralAccessPatch ? { referralAccess: referralAccessPatch } : {}),
    });
    // Echo the MERGED state, not just what was sent — the caller needs to see
    // what is actually stored now, including the scopes it didn't touch.
    const saved = await fetchAccessGrantsV2();
    return NextResponse.json(
      {
        ok: true,
        id,
        grants: saved?.pipelines ?? {},
        folderGrants: saved?.folders ?? {},
        masterUsers: saved?.master ?? [],
        caseManagers: saved?.caseManagers ?? {},
        referralAccess: saved?.referralAccess ?? {},
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fail(e);
  }
}
