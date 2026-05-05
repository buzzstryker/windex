// GET /events (list), GET /events/:eventId (detail), PATCH /events/:eventId (round edit/override).
// RLS applies. Status comes from league_rounds.processing_status (processed | partial_unresolved_players | validation_error).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function parsePath(url: string): { eventId: string | null } {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split("/").filter(Boolean);
    const eventsIdx = parts.indexOf("events");
    if (eventsIdx === -1) return { eventId: null };
    const next = parts[eventsIdx + 1];
    if (next && /^[0-9a-f-]{36}$/i.test(next)) return { eventId: next };
    return { eventId: null };
  } catch {
    return { eventId: null };
  }
}

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "GET" && req.method !== "PATCH") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "Missing authorization" }, 401);
  }

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return jsonResponse({ error: "Missing Bearer token" }, 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: user, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user?.user?.id) {
    return jsonResponse(
      { error: "Unauthorized", msg: userError?.message ?? "Invalid JWT" },
      401
    );
  }

  const { eventId } = parsePath(req.url);

  // ——— GET list: /events?group_id=...&season_id=...&source_app=...&from_date=...&to_date=... ———
  if (req.method === "GET" && !eventId) {
    const url = new URL(req.url);
    const groupId = url.searchParams.get("group_id") ?? undefined;
    const seasonId = url.searchParams.get("season_id") ?? undefined;
    const sourceApp = url.searchParams.get("source_app") ?? undefined;
    const fromDate = url.searchParams.get("from_date") ?? undefined;
    const toDate = url.searchParams.get("to_date") ?? undefined;

    let query = supabase
      .from("league_rounds")
      .select("id, external_event_id, source_app, round_date, group_id, season_id, processing_status, unresolved_player_count, attribution_status, is_signature_event, is_tournament, tournament_buyin, created_at, updated_at")
      .order("created_at", { ascending: false });

    if (groupId) query = query.eq("group_id", groupId);
    if (seasonId) query = query.eq("season_id", seasonId);
    if (sourceApp) query = query.eq("source_app", sourceApp);
    if (fromDate) query = query.gte("round_date", fromDate);
    if (toDate) query = query.lte("round_date", toDate);
    const statusParam = url.searchParams.get("status") ?? undefined;
    if (statusParam) query = query.eq("processing_status", statusParam);
    const attributionParam = url.searchParams.get("attribution_status") ?? undefined;
    if (attributionParam) query = query.eq("attribution_status", attributionParam);

    const { data: rows, error } = await query;

    if (error) {
      return jsonResponse(
        { error: "Failed to fetch events", details: error.message },
        500
      );
    }

    const rounds = (rows ?? []) as { id: string; group_id: string; season_id: string | null; [k: string]: unknown }[];
    const groupIds = [...new Set(rounds.map((r) => r.group_id))];
    const seasonIds = [...new Set(rounds.map((r) => r.season_id).filter(Boolean))] as string[];

    const groupNames: Record<string, string> = {};
    if (groupIds.length > 0) {
      const { data: gRows } = await supabase.from("groups").select("id, name").in("id", groupIds);
      for (const g of gRows ?? []) {
        groupNames[(g as { id: string }).id] = (g as { name: string }).name;
      }
    }
    const seasonRanges: Record<string, string> = {};
    if (seasonIds.length > 0) {
      const { data: sRows } = await supabase.from("seasons").select("id, start_date, end_date").in("id", seasonIds);
      for (const s of sRows ?? []) {
        const row = s as { id: string; start_date: string; end_date: string };
        seasonRanges[row.id] = `${row.start_date} – ${row.end_date}`;
      }
    }

    const events = rounds.map((row) => {
      const status = (row.processing_status ?? "processed") as string;
      return {
        id: row.id,
        external_event_id: row.external_event_id ?? null,
        source_app: row.source_app ?? null,
        round_date: row.round_date,
        group_id: row.group_id,
        group_name: groupNames[row.group_id] ?? null,
        season_id: row.season_id ?? null,
        season_name: row.season_id ? (seasonRanges[row.season_id] ?? null) : null,
        status,
        unresolved_player_count: row.unresolved_player_count ?? 0,
        attribution_status: (row.attribution_status ?? "attributed") as string,
        is_signature_event: row.is_signature_event ?? 0,
        is_tournament: row.is_tournament ?? 0,
        tournament_buyin: row.tournament_buyin ?? null,
        created_at: row.created_at,
        updated_at: row.updated_at ?? null,
      };
    });

    return jsonResponse({ events }, 200);
  }

  // ——— GET one: /events/:eventId ———
  if (req.method === "GET" && eventId) {
    const { data: round, error: roundErr } = await supabase
      .from("league_rounds")
      .select("id, user_id, external_event_id, source_app, round_date, group_id, season_id, processing_status, unresolved_player_count, attribution_status, is_signature_event, is_tournament, tournament_buyin, created_at, updated_at")
      .eq("id", eventId)
      .maybeSingle();

    if (roundErr || !round) {
      return jsonResponse(
        { error: roundErr?.message ?? "Event not found" },
        404
      );
    }

    const [scoresRes, groupRes, seasonRes] = await Promise.all([
      supabase.from("league_scores").select("player_id, score_value, score_override, game_points, result_type, override_actor, override_reason, override_at").eq("league_round_id", eventId).order("player_id"),
      (round as { group_id: string }).group_id ? supabase.from("groups").select("name").eq("id", (round as { group_id: string }).group_id).maybeSingle() : Promise.resolve({ data: null }),
      (round as { season_id: string | null }).season_id ? supabase.from("seasons").select("start_date, end_date").eq("id", (round as { season_id: string }).season_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);

    if (scoresRes.error) {
      return jsonResponse(
        { error: "Failed to fetch results", details: scoresRes.error.message },
        500
      );
    }

    const playerIds = [...new Set((scoresRes.data ?? []).map((sc: Record<string, unknown>) => sc.player_id as string))];
    let playerNames: Record<string, string> = {};
    if (playerIds.length > 0) {
      const { data: playerRows } = await supabase
        .from("players")
        .select("id, display_name")
        .in("id", playerIds);
      for (const p of playerRows ?? []) {
        playerNames[(p as { id: string }).id] = (p as { display_name: string }).display_name;
      }
    }

    const r = round as Record<string, unknown>;
    const groupName = (groupRes.data as { name?: string } | null)?.name ?? null;
    const sRow = seasonRes.data as { start_date?: string; end_date?: string } | null;
    const seasonName = sRow ? `${sRow.start_date ?? ""} – ${sRow.end_date ?? ""}` : null;
    const processingStatus = (r.processing_status ?? "processed") as string;
    const unresolvedCount = (r.unresolved_player_count as number) ?? 0;
    const attributionStatus = (r.attribution_status ?? "attributed") as string;
    const mappingIssues: string[] = processingStatus === "partial_unresolved_players" && unresolvedCount > 0
      ? [`${unresolvedCount} score(s) skipped: source player(s) not mapped. Resolve in Player Mapping.`]
      : [];

    const eventDetail = {
      id: round.id,
      external_event_id: r.external_event_id ?? null,
      source_app: r.source_app ?? null,
      round_date: round.round_date,
      group_id: round.group_id,
      group_name: groupName,
      season_id: r.season_id ?? null,
      season_name: seasonName,
      status: processingStatus,
      unresolved_player_count: unresolvedCount,
      attribution_status: attributionStatus,
      created_at: round.created_at,
      updated_at: r.updated_at ?? null,
      results: (scoresRes.data ?? []).map((sc: Record<string, unknown>) => ({
        player_id: sc.player_id,
        player_name: (playerNames[sc.player_id as string] ?? null) as string | null,
        score_value: sc.score_value ?? 0,
        score_override: sc.score_override ?? null,
        game_points: sc.game_points ?? null,
        result_type: sc.result_type ?? null,
        override_actor: sc.override_actor ?? null,
        override_reason: sc.override_reason ?? null,
        override_at: sc.override_at ?? null,
      })),
      attribution_status: attributionStatus,
      validation_errors: [] as string[],
      mapping_issues: mappingIssues,
    };

    return jsonResponse(eventDetail, 200);
  }

  // ——— PATCH /events/:eventId ———
  if (req.method === "PATCH" && eventId) {
    let body: {
      round_date?: string;
      season_id?: string | null;
      results?: { player_id: string; score_value?: number; score_override?: number | null }[];
      override_actor?: string | null;
      override_reason?: string | null;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const { data: existing, error: fetchErr } = await supabase
      .from("league_rounds")
      .select("id, group_id, season_id")
      .eq("id", eventId)
      .maybeSingle();

    if (fetchErr || !existing) {
      return jsonResponse({ error: "Event not found" }, 404);
    }

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = { updated_at: now };

    if (body.round_date != null) updates.round_date = body.round_date;
    if (body.season_id !== undefined) {
      if (body.season_id === null || body.season_id === "") {
        updates.season_id = null;
      } else {
        const { data: seasonRow } = await supabase
          .from("seasons")
          .select("id, group_id")
          .eq("id", body.season_id)
          .maybeSingle();
        if (!seasonRow || (seasonRow as { group_id: string }).group_id !== existing.group_id) {
          return jsonResponse(
            { error: "season_id must belong to the same group", code: "season_group_mismatch" },
            400
          );
        }
        updates.season_id = body.season_id;
      }
    }

    const { error: updateRoundErr } = await supabase
      .from("league_rounds")
      .update(updates)
      .eq("id", eventId);

    if (updateRoundErr) {
      return jsonResponse(
        { error: "Failed to update round", details: updateRoundErr.message },
        500
      );
    }

    if (body.results && Array.isArray(body.results) && body.results.length > 0) {
      const overrideActor = body.override_actor ?? "admin_ui";
      const overrideReason = body.override_reason ?? "round_edit";

      for (const r of body.results) {
        const row: Record<string, unknown> = {
          score_value: r.score_value,
          score_override: r.score_override ?? null,
          updated_at: now,
        };
        if (r.score_override != null) {
          row.override_actor = overrideActor;
          row.override_reason = overrideReason;
          row.override_at = now;
        }

        const { error: scoreErr } = await supabase
          .from("league_scores")
          .update(row)
          .eq("league_round_id", eventId)
          .eq("player_id", r.player_id);

        if (scoreErr) {
          return jsonResponse(
            { error: "Failed to update score", details: scoreErr.message, player_id: r.player_id },
            500
          );
        }
      }
    }

    const { data: updated, error: fetchUpdatedErr } = await supabase
      .from("league_rounds")
      .select("id, user_id, external_event_id, source_app, round_date, group_id, season_id, processing_status, unresolved_player_count, attribution_status, is_signature_event, is_tournament, tournament_buyin, created_at, updated_at")
      .eq("id", eventId)
      .maybeSingle();

    if (fetchUpdatedErr || !updated) {
      return jsonResponse({ id: eventId, updated: true }, 200);
    }

    const [scoresRes, groupRes, seasonRes] = await Promise.all([
      supabase.from("league_scores").select("player_id, score_value, score_override, game_points, result_type").eq("league_round_id", eventId),
      supabase.from("groups").select("name").eq("id", updated.group_id).maybeSingle(),
      (updated as { season_id: string | null }).season_id
        ? supabase.from("seasons").select("start_date, end_date").eq("id", (updated as { season_id: string }).season_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    const playerIds = [...new Set((scoresRes.data ?? []).map((sc: Record<string, unknown>) => sc.player_id as string))];
    let playerNames: Record<string, string> = {};
    if (playerIds.length > 0) {
      const { data: playerRows } = await supabase
        .from("players")
        .select("id, display_name")
        .in("id", playerIds);
      for (const p of playerRows ?? []) {
        playerNames[(p as { id: string }).id] = (p as { display_name: string }).display_name;
      }
    }

    const u = updated as Record<string, unknown>;
    const groupName = (groupRes.data as { name?: string } | null)?.name ?? null;
    const sRow = seasonRes.data as { start_date?: string; end_date?: string } | null;
    const seasonName = sRow ? `${sRow.start_date ?? ""} – ${sRow.end_date ?? ""}` : null;
    const processingStatus = (u.processing_status ?? "processed") as string;
    const unresolvedCount = (u.unresolved_player_count as number) ?? 0;
    const attributionStatus = (u.attribution_status ?? "attributed") as string;
    const mappingIssues: string[] = processingStatus === "partial_unresolved_players" && unresolvedCount > 0
      ? [`${unresolvedCount} score(s) skipped: source player(s) not mapped. Resolve in Player Mapping.`]
      : [];

    const eventDetail = {
      id: updated.id,
      external_event_id: u.external_event_id ?? null,
      source_app: u.source_app ?? null,
      round_date: updated.round_date,
      group_id: updated.group_id,
      group_name: groupName,
      season_id: u.season_id ?? null,
      season_name: seasonName,
      status: processingStatus,
      unresolved_player_count: unresolvedCount,
      attribution_status: attributionStatus,
      created_at: updated.created_at,
      updated_at: u.updated_at ?? null,
      results: (scoresRes.data ?? []).map((r: Record<string, unknown>) => ({
        player_id: r.player_id,
        player_name: (playerNames[r.player_id as string] ?? null) as string | null,
        score_value: r.score_value ?? 0,
        score_override: r.score_override ?? null,
        game_points: r.game_points ?? null,
        result_type: r.result_type ?? null,
      })),
      validation_errors: [] as string[],
      mapping_issues: mappingIssues,
    };

    return jsonResponse(eventDetail, 200);
  }

  return jsonResponse({ error: "Not found" }, 404);
});
