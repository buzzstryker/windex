// Review routes: player-mapping and attribution.
// Player-mapping: GET /review/player-mapping, POST /review/player-mapping/:id/resolve (body: player_id).
// Attribution: GET /review/attribution, POST /review/attribution/:id/resolve (body: group_id, season_id).
// Auth required; RLS by user_id.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function parsePath(url: string): { route: "player-mapping" | "attribution" | null; id: string | null; action: "resolve" | null } {
  try {
    const pathname = new URL(url).pathname;
    const parts = pathname.split("/").filter(Boolean);
    const reviewIdx = parts.indexOf("review");
    if (reviewIdx === -1) return { route: null, id: null, action: null };
    const next = parts[reviewIdx + 1];
    if (next !== "player-mapping" && next !== "attribution") return { route: null, id: null, action: null };
    const route = next as "player-mapping" | "attribution";
    const id = parts[reviewIdx + 2];
    const action = parts[reviewIdx + 3] === "resolve" ? "resolve" : null;
    const validId = id && /^[0-9a-f-]{36}$/i.test(id);
    return {
      route,
      id: validId ? id : null,
      action: validId && action ? "resolve" : null,
    };
  } catch {
    return { route: null, id: null, action: null };
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

  const userId = user.user.id;
  const { route, id, action } = parsePath(req.url);

  // ——— Attribution routes ———
  if (route === "attribution") {
    if (req.method === "GET" && !id) {
      const { data: rows, error } = await supabase
        .from("league_rounds")
        .select("id, group_id, season_id, source_app, round_date, attribution_status, created_at")
        .eq("user_id", userId)
        .eq("attribution_status", "pending_attribution")
        .order("created_at", { ascending: true });

      if (error) {
        return jsonResponse(
          { error: "Failed to fetch attribution queue", details: error.message },
          500
        );
      }

      const items = (rows ?? []).map((r: Record<string, unknown>) => ({
        id: r.id,
        event_id: r.id,
        source_app: r.source_app ?? null,
        round_date: r.round_date,
        status: r.attribution_status ?? "pending_attribution",
        group_id: r.group_id ?? null,
        season_id: r.season_id ?? null,
        candidate_groups: [] as { id: string; name: string }[],
        candidate_seasons: [] as { id: string; start_date: string; end_date: string }[],
      }));

      return jsonResponse({ items }, 200);
    }

    if (req.method === "POST" && id && action === "resolve") {
      let body: { group_id?: string; season_id?: string | null };
      try {
        body = (await req.json()) as { group_id?: string; season_id?: string | null };
      } catch {
        return jsonResponse({ error: "Invalid JSON body" }, 400);
      }

      const groupId = body?.group_id?.trim();
      if (!groupId) {
        return jsonResponse({ error: "group_id required" }, 400);
      }

      const seasonId = body?.season_id != null && String(body.season_id).trim() !== "" ? String(body.season_id).trim() : null;

      if (seasonId) {
        const { data: seasonRow } = await supabase
          .from("seasons")
          .select("id, group_id")
          .eq("id", seasonId)
          .maybeSingle();
        if (!seasonRow || (seasonRow as { group_id: string }).group_id !== groupId) {
          return jsonResponse(
            { error: "season_id must belong to the specified group_id", code: "season_group_mismatch" },
            400
          );
        }
      }

      const { data: round, error: fetchErr } = await supabase
        .from("league_rounds")
        .select("id, user_id")
        .eq("id", id)
        .eq("user_id", userId)
        .maybeSingle();

      if (fetchErr || !round) {
        return jsonResponse({ error: "Event not found" }, 404);
      }

      const { data: groupRow } = await supabase
        .from("groups")
        .select("id")
        .eq("id", groupId)
        .eq("user_id", userId)
        .maybeSingle();
      if (!groupRow) {
        return jsonResponse({ error: "Group not found or access denied" }, 404);
      }

      const { error: updateErr } = await supabase
        .from("league_rounds")
        .update({
          group_id: groupId,
          season_id: seasonId,
          attribution_status: "attribution_resolved",
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("user_id", userId);

      if (updateErr) {
        return jsonResponse(
          { error: "Failed to update attribution", details: updateErr.message },
          500
        );
      }

      return jsonResponse({ ok: true }, 200);
    }

    return jsonResponse({ error: "Not found" }, 404);
  }

  if (route !== "player-mapping") {
    return jsonResponse({ error: "Not found" }, 404);
  }

  // ——— GET /review/player-mapping — list pending queue ———
  if (req.method === "GET" && !id) {
    const { data: rows, error } = await supabase
      .from("player_mapping_queue")
      .select("id, source_app, source_player_name, source_player_ref, related_league_round_id, status, created_at, updated_at")
      .eq("user_id", userId)
      .eq("status", "pending")
      .order("created_at", { ascending: true });

    if (error) {
      return jsonResponse(
        { error: "Failed to fetch player mapping queue", details: error.message },
        500
      );
    }

    const items = (rows ?? []).map((r: Record<string, unknown>) => {
      const roundId = r.related_league_round_id as string | null;
      return {
        id: r.id,
        source_app: r.source_app ?? null,
        source_player_name: r.source_player_name,
        related_event_id: roundId ?? undefined,
        related_event_date: undefined as string | undefined,
        status: r.status,
        candidate_players: [] as { id: string; name: string }[],
      };
    });

    return jsonResponse({ items }, 200);
  }

  // ——— POST /review/player-mapping/:id/resolve ———
  if (req.method === "POST" && id && action === "resolve") {
    let body: { player_id?: string };
    try {
      body = (await req.json()) as { player_id?: string };
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const playerId = body?.player_id?.trim();
    if (!playerId) {
      return jsonResponse({ error: "player_id required" }, 400);
    }

    const { data: row, error: fetchErr } = await supabase
      .from("player_mapping_queue")
      .select("id, user_id, source_app, source_player_name, source_player_ref, status")
      .eq("id", id)
      .eq("user_id", userId)
      .maybeSingle();

    if (fetchErr || !row) {
      return jsonResponse({ error: "Mapping item not found" }, 404);
    }

    if ((row as { status: string }).status === "resolved") {
      return jsonResponse({ error: "Already resolved" }, 400);
    }

    const r = row as { source_app: string | null; source_player_name: string; source_player_ref: string | null };
    const sourceApp = r.source_app ?? "";
    const sourcePlayerRef = (r.source_player_ref && r.source_player_ref.trim()) || r.source_player_name;

    const { error: updateErr } = await supabase
      .from("player_mapping_queue")
      .update({
        status: "resolved",
        canonical_player_id: playerId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("user_id", userId);

    if (updateErr) {
      return jsonResponse(
        { error: "Failed to mark mapping resolved", details: updateErr.message },
        500
      );
    }

    const { error: insertErr } = await supabase
      .from("player_mappings")
      .upsert(
        {
          user_id: userId,
          source_app: sourceApp,
          source_player_ref: sourcePlayerRef,
          canonical_player_id: playerId,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,source_app,source_player_ref" }
      );

    if (insertErr) {
      return jsonResponse(
        { error: "Failed to persist resolved mapping", details: insertErr.message },
        500
      );
    }

    return jsonResponse({ ok: true }, 200);
  }

  return jsonResponse({ error: "Not found" }, 404);
});
