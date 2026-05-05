// GET /get-points-matrix — all-vs-all game points differential matrix for a group.
// Query: group_id (required), season_id (optional), exclude_signature_events (optional, default true)
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
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return jsonResponse({ error: "Missing authorization" }, 401);
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return jsonResponse({ error: "Missing Bearer token" }, 401);

  const url = new URL(req.url);
  const groupId = url.searchParams.get("group_id");
  if (!groupId) return jsonResponse({ error: "group_id is required" }, 400);
  const seasonId = url.searchParams.get("season_id"); // optional
  const excludeSig = url.searchParams.get("exclude_signature_events") !== "false"; // default true

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: user, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user?.user?.id) {
    return jsonResponse({ error: "Unauthorized", msg: userError?.message ?? "Invalid JWT" }, 401);
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

  // Season name map (year from midpoint)
  const seasonNames: Record<string, string> = {};
  for (const s of allSeasons) {
    const start = new Date(s.start_date + "T00:00:00");
    const end = new Date(s.end_date + "T00:00:00");
    seasonNames[s.id] = String(new Date((start.getTime() + end.getTime()) / 2).getFullYear());
  }

  // Fetch all rounds (paginated)
  type Round = { id: string; season_id: string | null; round_date: string; is_signature_event: number };
  const allRounds: Round[] = [];
  let offset = 0;
  const PAGE = 1000;
  while (true) {
    let q = supabase.from("league_rounds").select("id, season_id, round_date, is_signature_event")
      .eq("group_id", groupId).order("round_date").range(offset, offset + PAGE - 1);
    if (seasonId) q = q.eq("season_id", seasonId);
    const { data } = await q;
    const rows = (data ?? []) as Round[];
    allRounds.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  // Filter rounds
  const rounds = allRounds.filter((r) => {
    if (!seasonId && (!r.season_id || !allowedSeasonIds.has(r.season_id))) return false;
    if (excludeSig && r.is_signature_event) return false;
    return true;
  });
  const roundIds = rounds.map((r) => r.id);

  if (roundIds.length === 0) {
    return jsonResponse({ group_id: groupId, players: [], cells: {}, matchups: [] }, 200);
  }

  // Fetch all scores (batched)
  type Score = { league_round_id: string; player_id: string; score_value: number | null; score_override: number | null };
  const allScores: Score[] = [];
  const BATCH = 100;
  for (let i = 0; i < roundIds.length; i += BATCH) {
    const batch = roundIds.slice(i, i + BATCH);
    const { data } = await supabase
      .from("league_scores")
      .select("league_round_id, player_id, score_value, score_override")
      .in("league_round_id", batch);
    if (data) allScores.push(...(data as Score[]));
  }

  // Fetch player names
  const playerIdSet = new Set(allScores.map((s) => s.player_id));
  const playerNameMap: Record<string, string> = {};
  if (playerIdSet.size > 0) {
    const ids = [...playerIdSet];
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const { data } = await supabase.from("players").select("id, display_name, is_active").in("id", batch);
      for (const p of (data ?? []) as { id: string; display_name: string; is_active: number }[]) {
        playerNameMap[p.id] = p.display_name;
      }
    }
  }

  // Fetch active group members
  const { data: memberRows } = await supabase
    .from("group_members")
    .select("player_id, is_active")
    .eq("group_id", groupId);
  const activePlayerIds = new Set(
    ((memberRows ?? []) as { player_id: string; is_active: number }[])
      .filter((m) => m.is_active === 1)
      .map((m) => m.player_id)
  );

  // Group scores by round
  const scoresByRound = new Map<string, Map<string, number>>();
  for (const s of allScores) {
    if (!scoresByRound.has(s.league_round_id)) scoresByRound.set(s.league_round_id, new Map());
    scoresByRound.get(s.league_round_id)!.set(s.player_id, s.score_override ?? s.score_value ?? 0);
  }

  // Compute pairwise differentials
  const cells: Record<string, Record<string, { net: number; rounds: number }>> = {};
  for (const [, ps] of scoresByRound) {
    const entries = [...ps.entries()];
    for (let i = 0; i < entries.length; i++) {
      const [pidA, ptsA] = entries[i];
      for (let j = 0; j < entries.length; j++) {
        if (i === j) continue;
        const [pidB, ptsB] = entries[j];
        if (!cells[pidA]) cells[pidA] = {};
        if (!cells[pidA][pidB]) cells[pidA][pidB] = { net: 0, rounds: 0 };
        cells[pidA][pidB].net += ptsA - ptsB;
        cells[pidA][pidB].rounds++;
      }
    }
  }

  // Round cell values
  for (const a of Object.keys(cells)) {
    for (const b of Object.keys(cells[a])) {
      cells[a][b].net = Math.round(cells[a][b].net);
    }
  }

  // Filter to active players, sort by total net descending
  const filtered = [...playerIdSet].filter((id) => activePlayerIds.has(id));
  filtered.sort((a, b) => {
    const tA = Object.values(cells[a] ?? {}).reduce((s, c) => s + c.net, 0);
    const tB = Object.values(cells[b] ?? {}).reduce((s, c) => s + c.net, 0);
    return tB - tA;
  });

  // Build players array with names
  const players = filtered.map((id) => ({ id, display_name: playerNameMap[id] ?? id }));

  // Build worst matchups (top 10, min 3 rounds)
  const matchups: { player_a: string; player_b: string; net: number; rounds: number; avg_per_round: number }[] = [];
  for (const a of filtered) {
    for (const b of filtered) {
      if (a === b) continue;
      const cell = cells[a]?.[b];
      if (!cell || cell.rounds < 3) continue;
      matchups.push({
        player_a: a,
        player_b: b,
        net: cell.net,
        rounds: cell.rounds,
        avg_per_round: Math.round((cell.net / cell.rounds) * 10) / 10,
      });
    }
  }
  matchups.sort((a, b) => a.avg_per_round - b.avg_per_round);
  matchups.splice(10);

  return jsonResponse({
    group_id: groupId,
    season_id: seasonId ?? null,
    exclude_signature_events: excludeSig,
    players,
    cells,
    matchups,
  }, 200);
});
