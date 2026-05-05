// GET /get-points-analysis — head-to-head point comparison between two players.
// Query: group_id (required), player_a_id (required), player_b_id (required), season_id (optional).
// Auth required; RLS on underlying tables.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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

  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing authorization" }, 401);

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return jsonResponse({ error: "Missing Bearer token" }, 401);

  const url = new URL(req.url);
  const groupId = url.searchParams.get("group_id");
  const playerAId = url.searchParams.get("player_a_id");
  const playerBId = url.searchParams.get("player_b_id");
  const seasonId = url.searchParams.get("season_id"); // optional
  const excludeSig = url.searchParams.get("exclude_signature_events") !== "false"; // default true

  if (!groupId || !playerAId || !playerBId) {
    return jsonResponse({ error: "group_id, player_a_id, and player_b_id are required" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: user, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user?.user?.id) {
    return jsonResponse({ error: "Unauthorized", msg: userError?.message ?? "Invalid JWT" }, 401);
  }

  // Fetch player names
  const { data: playerRows } = await supabase
    .from("players")
    .select("id, display_name")
    .in("id", [playerAId, playerBId]);

  const playerMap: Record<string, string> = {};
  for (const p of playerRows ?? []) {
    playerMap[(p as { id: string }).id] = (p as { display_name: string }).display_name;
  }
  if (!playerMap[playerAId] || !playerMap[playerBId]) {
    return jsonResponse({ error: "One or both players not found" }, 404);
  }

  // Fetch seasons for 2023+ filtering
  const { data: seasonRows } = await supabase
    .from("seasons")
    .select("id, start_date, end_date")
    .eq("group_id", groupId);
  const allSeasons = (seasonRows ?? []) as { id: string; start_date: string; end_date: string }[];
  const allowedSeasonIds = new Set(
    allSeasons.filter((s) => s.start_date >= "2022-12-01").map((s) => s.id)
  );

  // Fetch all rounds for this group (handle Supabase default row limit)
  let allRoundRows: { id: string; season_id: string | null; round_date: string; is_signature_event: number }[] = [];
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    let q = supabase
      .from("league_rounds")
      .select("id, season_id, round_date, is_signature_event")
      .eq("group_id", groupId)
      .order("round_date")
      .range(offset, offset + PAGE - 1);
    if (seasonId) q = q.eq("season_id", seasonId);
    const { data: page, error: pageErr } = await q;
    if (pageErr) {
      return jsonResponse({ error: "Failed to fetch rounds", details: pageErr.message }, 500);
    }
    const rows = (page ?? []) as typeof allRoundRows;
    allRoundRows.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  // Filter: 2023+ seasons (unless specific season requested) and signature events
  const rounds = allRoundRows.filter((r) => {
    if (!seasonId && (!r.season_id || !allowedSeasonIds.has(r.season_id))) return false;
    if (excludeSig && r.is_signature_event) return false;
    return true;
  });

  const roundIds = rounds.map((r) => r.id);
  if (roundIds.length === 0) {
    return jsonResponse(buildEmptyResult(groupId, playerAId, playerBId, playerMap), 200);
  }

  // Fetch scores for both players across all rounds (batch)
  const allScores: { league_round_id: string; player_id: string; score_value: number | null; score_override: number | null }[] = [];
  const BATCH = 100;
  for (let i = 0; i < roundIds.length; i += BATCH) {
    const batch = roundIds.slice(i, i + BATCH);
    const { data: scores } = await supabase
      .from("league_scores")
      .select("league_round_id, player_id, score_value, score_override")
      .in("player_id", [playerAId, playerBId])
      .in("league_round_id", batch);
    if (scores) allScores.push(...(scores as typeof allScores));
  }

  // Group scores by round, keep only rounds where BOTH players have a score
  const roundMap = new Map<string, { id: string; season_id: string | null; round_date: string; is_signature_event: number }>();
  for (const r of rounds) {
    roundMap.set(r.id, r);
  }

  const scoresByRound = new Map<string, { a?: number; b?: number }>();
  for (const s of allScores) {
    if (!scoresByRound.has(s.league_round_id)) scoresByRound.set(s.league_round_id, {});
    const entry = scoresByRound.get(s.league_round_id)!;
    const pts = s.score_override ?? s.score_value ?? 0;
    if (s.player_id === playerAId) entry.a = pts;
    else if (s.player_id === playerBId) entry.b = pts;
  }

  // Build round-level results
  type RoundResult = { league_round_id: string; round_date: string; season_id: string | null; player_a_points: number; player_b_points: number; net: number };
  const h2hRounds: RoundResult[] = [];

  for (const [roundId, scores] of scoresByRound) {
    if (scores.a === undefined || scores.b === undefined) continue;
    const round = roundMap.get(roundId);
    if (!round) continue;
    h2hRounds.push({
      league_round_id: roundId,
      round_date: round.round_date,
      season_id: round.season_id,
      player_a_points: Math.round(scores.a),
      player_b_points: Math.round(scores.b),
      net: Math.round(scores.a - scores.b),
    });
  }

  h2hRounds.sort((a, b) => a.round_date.localeCompare(b.round_date));

  // Fetch season names for labels
  const seasonIds = [...new Set(h2hRounds.map((r) => r.season_id).filter(Boolean))] as string[];
  const seasonNames: Record<string, string> = {};
  if (seasonIds.length > 0) {
    const { data: seasonRows } = await supabase
      .from("seasons")
      .select("id, start_date, end_date")
      .in("id", seasonIds);
    for (const s of (seasonRows ?? []) as { id: string; start_date: string; end_date: string }[]) {
      const start = new Date(s.start_date + "T00:00:00");
      const end = new Date(s.end_date + "T00:00:00");
      const mid = new Date((start.getTime() + end.getTime()) / 2);
      seasonNames[s.id] = String(mid.getFullYear());
    }
  }

  // Aggregate by season
  const seasonMap = new Map<string | null, RoundResult[]>();
  for (const r of h2hRounds) {
    const key = r.season_id;
    if (!seasonMap.has(key)) seasonMap.set(key, []);
    seasonMap.get(key)!.push(r);
  }

  const bySeason = [];
  for (const [sid, sRounds] of seasonMap) {
    const aTotal = sRounds.reduce((s, r) => s + r.player_a_points, 0);
    const bTotal = sRounds.reduce((s, r) => s + r.player_b_points, 0);
    bySeason.push({
      season_id: sid,
      season_name: sid ? (seasonNames[sid] ?? sid) : "Unknown",
      rounds_together: sRounds.length,
      player_a_total_points: aTotal,
      player_b_total_points: bTotal,
      net_points: aTotal - bTotal,
      player_a_wins: sRounds.filter((r) => r.player_a_points > r.player_b_points).length,
      player_b_wins: sRounds.filter((r) => r.player_b_points > r.player_a_points).length,
      ties: sRounds.filter((r) => r.player_a_points === r.player_b_points).length,
      rounds: sRounds.map((r) => ({
        league_round_id: r.league_round_id,
        round_date: r.round_date,
        player_a_points: r.player_a_points,
        player_b_points: r.player_b_points,
        net: r.net,
      })),
    });
  }
  bySeason.sort((a, b) => (a.season_name ?? "").localeCompare(b.season_name ?? ""));

  // Lifetime aggregation
  const lifetime = {
    rounds_together: h2hRounds.length,
    player_a_total_points: h2hRounds.reduce((s, r) => s + r.player_a_points, 0),
    player_b_total_points: h2hRounds.reduce((s, r) => s + r.player_b_points, 0),
    net_points: h2hRounds.reduce((s, r) => s + r.net, 0),
    player_a_wins: h2hRounds.filter((r) => r.net > 0).length,
    player_b_wins: h2hRounds.filter((r) => r.net < 0).length,
    ties: h2hRounds.filter((r) => r.net === 0).length,
  };

  return jsonResponse({
    group_id: groupId,
    player_a: { id: playerAId, display_name: playerMap[playerAId] },
    player_b: { id: playerBId, display_name: playerMap[playerBId] },
    lifetime,
    by_season: bySeason,
  }, 200);
});

function buildEmptyResult(
  groupId: string,
  playerAId: string,
  playerBId: string,
  playerMap: Record<string, string>,
) {
  return {
    group_id: groupId,
    player_a: { id: playerAId, display_name: playerMap[playerAId] ?? playerAId },
    player_b: { id: playerBId, display_name: playerMap[playerBId] ?? playerBId },
    lifetime: {
      rounds_together: 0,
      player_a_total_points: 0,
      player_b_total_points: 0,
      net_points: 0,
      player_a_wins: 0,
      player_b_wins: 0,
      ties: 0,
    },
    by_season: [],
  };
}
