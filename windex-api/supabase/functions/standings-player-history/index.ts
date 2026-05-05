// Read-only: point history for one player in a group/season (ledger drilldown).
// GET with query params: group_id, season_id, player_id. Returns round-level point records.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface HistoryRow {
  event_id: string;
  round_date: string;
  effective_points: number;
  score_value: number | null;
  score_override: number | null;
  override_reason: string | null;
  override_actor: string | null;
  override_at: string | null;
  source_app: string | null;
  processing_status: string | null;
  attribution_status: string | null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing authorization" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const groupId = url.searchParams.get("group_id");
  const seasonId = url.searchParams.get("season_id");
  const playerId = url.searchParams.get("player_id");

  if (!groupId || !seasonId || !playerId) {
    return new Response(
      JSON.stringify({ error: "group_id, season_id, and player_id are required" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return new Response(JSON.stringify({ error: "Missing Bearer token" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: user, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user?.user?.id) {
    return new Response(
      JSON.stringify({ error: "Unauthorized", msg: userError?.message ?? "Invalid JWT" }),
      { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Rounds in this group/season (RLS will filter by ownership)
  const { data: rounds, error: roundsErr } = await supabase
    .from("league_rounds")
    .select("id, round_date, source_app, processing_status, attribution_status")
    .eq("group_id", groupId)
    .eq("season_id", seasonId)
    .order("round_date", { ascending: true });

  if (roundsErr) {
    return new Response(
      JSON.stringify({ error: "Failed to fetch rounds", details: roundsErr.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const roundIds = (rounds ?? []).map((r: { id: string }) => r.id);
  if (roundIds.length === 0) {
    return new Response(
      JSON.stringify({ player_id: playerId, total_points: 0, history: [] }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data: scores, error: scoresErr } = await supabase
    .from("league_scores")
    .select("league_round_id, score_value, score_override, override_reason, override_actor, override_at")
    .eq("player_id", playerId)
    .in("league_round_id", roundIds);

  if (scoresErr) {
    return new Response(
      JSON.stringify({ error: "Failed to fetch scores", details: scoresErr.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const roundMap = new Map(
    (rounds ?? []).map((r: { id: string; round_date: string; source_app: string | null; processing_status: string | null; attribution_status: string | null }) => [
      r.id,
      {
        round_date: r.round_date,
        source_app: r.source_app ?? null,
        processing_status: r.processing_status ?? null,
        attribution_status: r.attribution_status ?? null,
      },
    ])
  );

  const history: HistoryRow[] = [];
  let totalPoints = 0;
  for (const s of scores ?? []) {
    const sRow = s as { league_round_id: string; score_value: number | null; score_override: number | null; override_reason: string | null; override_actor: string | null; override_at: string | null };
    const r = roundMap.get(sRow.league_round_id);
    if (!r) continue;
    const scoreVal = sRow.score_value ?? 0;
    const override = sRow.score_override;
    const effective = override != null ? override : scoreVal;
    totalPoints += effective;
    history.push({
      event_id: sRow.league_round_id,
      round_date: r.round_date,
      effective_points: effective,
      score_value: scoreVal,
      score_override: override ?? null,
      override_reason: sRow.override_reason ?? null,
      override_actor: sRow.override_actor ?? null,
      override_at: sRow.override_at ?? null,
      source_app: r.source_app,
      processing_status: r.processing_status,
      attribution_status: r.attribution_status,
    });
  }
  history.sort((a, b) => a.round_date.localeCompare(b.round_date));

  let playerName: string | null = null;
  {
    const { data: playerRow } = await supabase
      .from("players")
      .select("display_name")
      .eq("id", playerId)
      .maybeSingle();
    playerName = (playerRow as { display_name?: string } | null)?.display_name ?? null;
  }

  return new Response(
    JSON.stringify({
      player_id: playerId,
      player_name: playerName,
      total_points: totalPoints,
      rounds_played: history.length,
      history,
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
