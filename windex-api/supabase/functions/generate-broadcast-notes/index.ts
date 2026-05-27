// POST /generate-broadcast-notes
// Body: { group_id: string, player_ids: string[] }  (2-6 ids)
//
// Auth: caller must be an authenticated member of group_id (am_i_group_member,
// migration 014). 401 if no/invalid JWT, 403 if not a member.
//
// Computes a GROUP-SCOPED stats payload for the selected spotlight players
// (career, current-season, recent form, streaks, regular events, tournaments,
// championship history, and head-to-head among the spotlight players only),
// then runs a three-stage pipeline:
//   1. Claude generates the broadcast notes + a structured `claims` list.
//   2. Perplexity (sonar-pro) fact-checks each claim against the payload
//      (round_data claims) or public web knowledge (general_knowledge claims).
//   3. Claude integrates the corrections it agrees with, preserving its voice.
// Returns { notes, fact_check: { annotations, status, ... } }. The fact-check
// is mandatory: any stage failure HARD-FAILS with a clear error (the feature
// runs ~4×/year during the cup championship, so Buzz must SEE failures, not
// miss a silent warning). Every call is logged to broadcast_notes_log
// (best-effort; logging failure never fails the request), and the fact-check
// audit is stored on that row's fact_check_audit jsonb column (migration 033).
//
// GROUP-SCOPING INVARIANT: league_scores has no group_id. Every stat is
// derived only from league_scores whose league_round_id belongs to a
// league_round with group_id = the requested group. A player's rounds in
// OTHER groups are never counted. Cup/points history and standings rank are
// likewise filtered to this group.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const MODEL = "claude-sonnet-4-20250514";

// Fact-check pass (stage 2). sonar-pro is Perplexity's grounded search model
// (web search + citations) — verified against the current Perplexity model
// docs. 30s timeout is intentionally generous: this runs ~4×/year during the
// cup championship, so latency/cost are non-issues.
const PERPLEXITY_MODEL = "sonar-pro";
const PERPLEXITY_URL = "https://api.perplexity.ai/chat/completions";
const FACT_CHECK_TIMEOUT_MS = 30_000;

// 2025 is when full finishing-order recording began for Windex.
// Other groups may have different cutoff years or may not record
// full order at all. See BACKLOG: per-group cup completeness cutoffs.
const WINDEX_CUP_FULL_RESULTS_FROM_YEAR = 2025;

// Claude and Perplexity occasionally wrap JSON in ```json fences despite being
// told not to. Strip a single surrounding fence before JSON.parse.
function stripJsonFence(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return m ? m[1].trim() : t;
}

const SYSTEM_PROMPT =
`You are a senior sports broadcaster prepping playoff commentary for a recurring private golf points league. Surface specific, quotable, stat-grounded angles a play-by-play announcer and color commentator would use.

Rules:
- Every claim must be grounded in a specific number from the data. Don't invent stats. If a stat isn't there, don't say it.
- Prefer head-to-head records, streaks, championship history, and recent form over generic season totals.
- Tone: confident, punchy, broadcast-style. Hyperbole is fine when the data backs it.
- Surface tension: rivalries (close H2H), dominance (lopsided H2H), comebacks, choking history (poor tournament finishes from strong regular-season players), championship pedigree.
- Game points data is mostly NULL pre-2026 — do NOT cite career total_game_points. Use total_score_value, head-to-head records, and championship/streak data instead.
- Cup Championship finishing history is a primary commentary category, alongside head-to-head records, regular round play, tournament play, and points standings.
- Detailed round-by-round records begin in 2023. Pre-2023 data is limited to points championship finishing positions per season — no per-round results, no regular/tournament bucketing, no per-round head-to-head outcomes. When discussing player history that spans the 2020–2022 era, refer to points championship results only, and acknowledge the data boundary naturally when a player's career predates 2023 (for example: "Detailed records start in 2023, but FJ's points championship pedigree goes back to 2020"). Weave this in naturally — never as a disclaimer block.
- Cover both regular round play and tournament play. Regular rounds are everyday head-to-head differential matches with no buy-in — wins and losses settle directly between players. Tournament rounds (is_tournament = 1) are formal pot-based competitions: players buy in, winners receive payouts from the pot, and score_value represents the net result (payout minus buy-in). These are distinct competition formats and a player's record in each tells a different story. You can mention buy-in scale, payout magnitude, and competition depth; a tournament win means finishing in the money, a tournament loss means paying the buy-in without recovering it. Treat money won and money lost symmetrically.
- Head-to-head records are split between regular events and tournaments. A player can dominate an opponent in regular rounds but go cold against them in tournaments (or vice versa) — cover both dimensions when relevant; they often tell different stories about the same rivalry.
- Avoid any reference to "signature events" or "signature rounds". That category previously existed but has been retired; the data now lives under the tournaments bucket or as regular rounds depending on the actual round shape.
- Cup data completeness: make finishing-position claims only for seasons whose data_completeness is "complete", or where a player's specific place is recorded for that season. For "partial" or "winner_only" seasons, cite only the recorded winner and any recorded places — never infer unrecorded positions. If a player's Cup results have gaps, acknowledge the gap honestly rather than guessing.
- No emojis. No markdown headers. Use **bold** only for storyline headlines when format calls for it.`;

type RoundRow = { id: string; season_id: string | null; round_date: string; row_type: string; is_tournament: number };
type ScoreRow = { league_round_id: string; player_id: string; score_value: number | null; score_override: number | null; game_points: number | null };
type SeasonRow = { id: string; start_date: string; end_date: string; cup_champion_player_id: string | null };

const eff = (s: { score_value: number | null; score_override: number | null }): number =>
  Math.round(s.score_override ?? s.score_value ?? 0);
const outcome = (v: number): "win" | "loss" | "tie" => (v > 0 ? "win" : v < 0 ? "loss" : "tie");
const seasonYear = (s: { start_date: string; end_date: string }): number => {
  const a = new Date(s.start_date + "T00:00:00").getTime();
  const b = new Date((s.end_date || s.start_date) + "T00:00:00").getTime();
  return new Date((a + b) / 2).getFullYear();
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing authorization" }, 401);
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "Missing Bearer token" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Caller-context client (anon key + caller JWT). RLS-respecting.
  const caller = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userInfo, error: userErr } = await caller.auth.getUser(token);
  if (userErr || !userInfo?.user?.id) {
    return json({ error: "Unauthorized", msg: userErr?.message ?? "Invalid JWT" }, 401);
  }
  const userId = userInfo.user.id;

  // ── Parse + validate body ────────────────────────────────────────────────
  let body: { group_id?: unknown; player_ids?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const groupId = typeof body.group_id === "string" ? body.group_id.trim() : "";
  if (!groupId) return json({ error: "group_id is required" }, 400);
  if (!Array.isArray(body.player_ids) || !body.player_ids.every((x) => typeof x === "string" && x.trim() !== "")) {
    return json({ error: "player_ids must be a non-empty array of strings" }, 400);
  }
  const playerIds = [...new Set((body.player_ids as string[]).map((s) => s.trim()))];
  if (playerIds.length < 2 || playerIds.length > 6) {
    return json({ error: "Select between 2 and 6 players" }, 400);
  }

  // ── Membership gate (caller must be a member of THIS group) ──────────────
  const { data: isMember, error: memErr } = await caller.rpc("am_i_group_member", { gid: groupId });
  if (memErr) return json({ error: "Permission check failed", details: memErr.message }, 500);
  if (isMember !== true) return json({ error: "You must be a member of this group" }, 403);

  // ── Validate spotlight players: active, non-retired members of THIS group ─
  const { data: memRows, error: gmErr } = await caller
    .from("group_members")
    .select("player_id")
    .eq("group_id", groupId)
    .eq("is_active", 1);
  if (gmErr) return json({ error: "Failed to load group members", details: gmErr.message }, 500);
  const activeMemberIds = new Set((memRows ?? []).map((m: { player_id: string }) => m.player_id));

  const { data: playerRows, error: pErr } = await caller
    .from("players")
    .select("id, display_name, retired_at")
    .in("id", playerIds);
  if (pErr) return json({ error: "Failed to load players", details: pErr.message }, 500);
  const playerById = new Map(
    (playerRows ?? []).map((p: { id: string; display_name: string; retired_at: string | null }) => [p.id, p]),
  );

  const invalid: string[] = [];
  for (const id of playerIds) {
    const p = playerById.get(id);
    if (!p || !activeMemberIds.has(id) || p.retired_at != null) invalid.push(id);
  }
  if (invalid.length > 0) {
    return json({ error: "All selected players must be active, non-retired members of this group", invalid_player_ids: invalid }, 400);
  }

  // ── Group + seasons (group-scoped) ───────────────────────────────────────
  const { data: groupRow, error: grpErr } = await caller
    .from("groups").select("id, name").eq("id", groupId).maybeSingle();
  if (grpErr || !groupRow) return json({ error: "Group not found" }, 404);
  const groupName = (groupRow as { name: string }).name;

  const { data: seasonRows } = await caller
    .from("seasons")
    .select("id, start_date, end_date, cup_champion_player_id")
    .eq("group_id", groupId);
  const seasons = (seasonRows ?? []) as SeasonRow[];
  const today = new Date().toISOString().slice(0, 10);
  // Current season = most-recent season already started (mirrors the app's
  // listSeasons start_date<=today filter + most-recent-first selection).
  const startedSeasons = seasons
    .filter((s) => s.start_date && s.start_date <= today)
    .sort((a, b) => b.start_date.localeCompare(a.start_date));
  const currentSeason = startedSeasons[0] ?? null;
  const currentSeasonId = currentSeason?.id ?? null;

  // ── All rounds for THIS group (paged) ────────────────────────────────────
  const groupRounds: RoundRow[] = [];
  {
    let offset = 0;
    const PAGE = 1000;
    while (true) {
      const { data: page, error } = await caller
        .from("league_rounds")
        .select("id, season_id, round_date, row_type, is_tournament")
        .eq("group_id", groupId)
        .order("round_date")
        .range(offset, offset + PAGE - 1);
      if (error) return json({ error: "Failed to fetch rounds", details: error.message }, 500);
      const rows = (page ?? []) as RoundRow[];
      // Exclude pre-2023 season_aggregate rows (migration 035): they are not
      // real rounds, so they must not enter ANY round-level stat (career,
      // streaks, recent form, regular/tournament buckets, or head-to-head).
      // Pre-2023 points history is preserved separately via season_standings.
      groupRounds.push(...rows.filter((r) => r.row_type !== "season_aggregate"));
      if (rows.length < PAGE) break;
      offset += PAGE;
    }
  }
  const roundById = new Map(groupRounds.map((r) => [r.id, r]));
  const groupRoundIds = new Set(groupRounds.map((r) => r.id));

  // ── Scores for spotlight players, ONLY for this group's rounds ───────────
  const allRoundIds = [...groupRoundIds];
  const scores: ScoreRow[] = [];
  const BATCH = 100;
  for (let i = 0; i < allRoundIds.length; i += BATCH) {
    const batch = allRoundIds.slice(i, i + BATCH);
    const { data, error } = await caller
      .from("league_scores")
      .select("league_round_id, player_id, score_value, score_override, game_points")
      .in("player_id", playerIds)
      .in("league_round_id", batch);
    if (error) return json({ error: "Failed to fetch scores", details: error.message }, 500);
    for (const s of (data ?? []) as ScoreRow[]) {
      // Defensive: only count scores tied to a round in THIS group.
      if (groupRoundIds.has(s.league_round_id)) scores.push(s);
    }
  }

  // Per-player chronological round list (group-scoped). byPlayer excludes
  // season_aggregate rows (filtered at fetch), so every entry is a regular_round;
  // `tourney` splits the pot-based tournament rounds (is_tournament = 1) from
  // everyday head-to-head rounds.
  type PR = { rid: string; d: string; sid: string | null; tourney: boolean; v: number; gp: number | null };
  const byPlayer = new Map<string, PR[]>();
  for (const id of playerIds) byPlayer.set(id, []);
  for (const s of scores) {
    const r = roundById.get(s.league_round_id);
    if (!r) continue;
    byPlayer.get(s.player_id)!.push({
      rid: r.id, d: r.round_date, sid: r.season_id,
      tourney: r.is_tournament === 1, v: eff(s), gp: s.game_points,
    });
  }
  for (const arr of byPlayer.values()) {
    arr.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.rid < b.rid ? -1 : a.rid > b.rid ? 1 : 0));
  }

  // ── Cup championship history (group-scoped via seasons) ──────────────────
  const champIds = new Set<string>();
  for (const s of seasons) if (s.cup_champion_player_id) champIds.add(s.cup_champion_player_id);

  // ── Points champion history from season_standings (group-scoped) ─────────
  const { data: standRows } = await caller
    .from("season_standings")
    .select("season_id, player_id, total_points, rounds_played")
    .eq("group_id", groupId);
  const standBySeason = new Map<string, { player_id: string; total_points: number; rounds_played: number }[]>();
  for (const r of (standRows ?? []) as { season_id: string; player_id: string; total_points: number; rounds_played: number }[]) {
    if (!standBySeason.has(r.season_id)) standBySeason.set(r.season_id, []);
    standBySeason.get(r.season_id)!.push(r);
  }
  const pointsChampBySeason = new Map<string, string>(); // season_id -> player_id
  for (const [sid, rows] of standBySeason) {
    const played = rows.filter((r) => r.rounds_played > 0);
    if (played.length === 0) continue;
    const top = played.reduce((a, b) => (b.total_points > a.total_points ? b : a));
    pointsChampBySeason.set(sid, top.player_id);
  }

  // ── Cup Championship finishing history (championship_results, migration 032) ─
  // Full finishing order per season (place, ties allowed). Older seasons were
  // backfilled with only the place=1 winner, so completeness varies by season.
  const { data: crRows, error: crErr } = await caller
    .from("championship_results")
    .select("season_id, player_id, place")
    .eq("group_id", groupId);
  if (crErr) return json({ error: "Failed to fetch championship results", details: crErr.message }, 500);

  const seasonById = new Map(seasons.map((s) => [s.id, s]));
  type CR = { player_id: string; place: number };
  const crBySeason = new Map<string, CR[]>();
  for (const r of (crRows ?? []) as { season_id: string; player_id: string; place: number }[]) {
    if (!seasonById.has(r.season_id)) continue; // defensive group-scope guard
    if (!crBySeason.has(r.season_id)) crBySeason.set(r.season_id, []);
    crBySeason.get(r.season_id)!.push({ player_id: r.player_id, place: r.place });
  }

  // Per-season derived metadata, including data_completeness inferred from the
  // recorded rows (no expected field-size is stored, so this describes exactly
  // what the data contains):
  //   winner_only — only the champion is recorded (max place = 1).
  //   complete    — places form a gap-free competition ranking (every slot
  //                 1..N accounted for, ties allowed: 1,2,2,4...).
  //   partial     — places beyond the winner are recorded, but with gaps.
  type CupSeasonMeta = {
    season_id: string; label: string; year: number; total_participants: number;
    max_place: number; winner_id: string | null;
    completeness: "complete" | "partial" | "winner_only";
  };
  const cupSeasonMeta = new Map<string, CupSeasonMeta>();
  for (const [sid, rows] of crBySeason) {
    const s = seasonById.get(sid)!;
    const year = seasonYear(s);
    const places = rows.map((r) => r.place).sort((a, b) => a - b);
    const maxPlace = places[places.length - 1];
    let completeness: "complete" | "partial" | "winner_only";
    if (maxPlace === 1) {
      completeness = "winner_only";
    } else {
      // Gap-free competition ranking: each sorted place is either a tie with the
      // prior one or equals its 1-indexed position (1,2,2,4 ok; 1,2,4 has a gap).
      let gapless = places[0] === 1;
      for (let i = 1; i < places.length && gapless; i++) {
        if (!(places[i] === places[i - 1] || places[i] === i + 1)) gapless = false;
      }
      // Only seasons from the full-results era can be "complete" (see constant):
      // an older gap-free set may still be a partial top-N of a larger field.
      completeness = gapless && year >= WINDEX_CUP_FULL_RESULTS_FROM_YEAR ? "complete" : "partial";
    }
    const winner_id = s.cup_champion_player_id ?? rows.find((r) => r.place === 1)?.player_id ?? null;
    cupSeasonMeta.set(sid, {
      season_id: sid, label: String(year), year, total_participants: rows.length,
      max_place: maxPlace, winner_id, completeness,
    });
  }
  // Ensure cup winners' names get resolved alongside the other ids.
  for (const m of cupSeasonMeta.values()) if (m.winner_id) champIds.add(m.winner_id);

  // Resolve every name we need (spotlight + cup champs + points champs).
  const nameIds = new Set<string>(playerIds);
  for (const id of champIds) nameIds.add(id);
  for (const pid of pointsChampBySeason.values()) nameIds.add(pid);
  const { data: nameRows } = await caller
    .from("players").select("id, display_name").in("id", [...nameIds]);
  const nameById = new Map((nameRows ?? []).map((p: { id: string; display_name: string }) => [p.id, p.display_name]));
  const nm = (id: string) => nameById.get(id) ?? id.slice(0, 8);

  const cup_championship_history = seasons
    .filter((s) => s.cup_champion_player_id)
    .map((s) => ({ year: seasonYear(s), winner: nm(s.cup_champion_player_id as string) }))
    .sort((a, b) => a.year - b.year);

  // Top-level Cup context for comparative storylines (one entry per season that
  // has any championship_results rows), oldest → newest.
  const championships_played = [...cupSeasonMeta.values()]
    .sort((a, b) => a.year - b.year)
    .map((m) => ({
      season: m.label,
      // Only known when the full field is recorded; otherwise the recorded row
      // count is NOT the participant count, so report null (unknown).
      total_participants: m.completeness === "complete" ? m.total_participants : null,
      winner: m.winner_id ? nm(m.winner_id) : null,
      data_completeness: m.completeness,
    }));

  // Per-spotlight-player Cup finishing history. last_place_finishes only counts
  // seasons known "complete" (the true field size is known there); for
  // winner_only/partial seasons the recorded max place is not necessarily last.
  const cupHistoryFor = (id: string) => {
    const appearances: { sid: string; year: number; label: string; place: number; total: number; completeness: string }[] = [];
    for (const [sid, rows] of crBySeason) {
      const mine = rows.find((r) => r.player_id === id);
      if (!mine) continue;
      const meta = cupSeasonMeta.get(sid)!;
      appearances.push({ sid, year: meta.year, label: meta.label, place: mine.place, total: meta.total_participants, completeness: meta.completeness });
    }
    appearances.sort((a, b) => a.year - b.year);
    const results_by_season = appearances.map((a) => ({
      season: a.label, place: a.place,
      // null unless the full field is known (see championships_played note).
      total_participants: a.completeness === "complete" ? a.total : null,
      data_completeness: a.completeness,
    }));
    if (appearances.length === 0) {
      return {
        total_appearances: 0, wins: 0, top_3_finishes: 0, last_place_finishes: 0,
        best_finish: null, worst_finish: null, average_finish: null,
        results_by_season,
      };
    }
    // best = lowest place, worst = highest place; ties broken by most recent season.
    const byBest = [...appearances].sort((a, b) => a.place - b.place || b.year - a.year)[0];
    const byWorst = [...appearances].sort((a, b) => b.place - a.place || b.year - a.year)[0];
    return {
      total_appearances: appearances.length,
      wins: appearances.filter((a) => a.place === 1).length,
      top_3_finishes: appearances.filter((a) => a.place <= 3).length,
      last_place_finishes: appearances.filter((a) => a.completeness === "complete" && a.place === cupSeasonMeta.get(a.sid)!.max_place).length,
      best_finish: { place: byBest.place, season: byBest.label },
      worst_finish: { place: byWorst.place, season: byWorst.label },
      average_finish: Math.round((appearances.reduce((s, a) => s + a.place, 0) / appearances.length) * 10) / 10,
      results_by_season,
    };
  };

  const points_champion_history = seasons
    .filter((s) => s.id !== currentSeasonId && (s.end_date || "") < today && pointsChampBySeason.has(s.id))
    .map((s) => ({ year: seasonYear(s), winner: nm(pointsChampBySeason.get(s.id) as string) }))
    .sort((a, b) => a.year - b.year);

  const cupWins = (id: string) => seasons.filter((s) => s.cup_champion_player_id === id).length;
  const pointsWins = (id: string) => {
    let n = 0;
    for (const s of seasons) {
      if (s.id === currentSeasonId || (s.end_date || "") >= today) continue;
      if (pointsChampBySeason.get(s.id) === id) n++;
    }
    return n;
  };

  // Current-season standings rank among players who actually played, scoped
  // to this group's current season (competition ranking; ties share rank).
  const csRank = new Map<string, number>();
  if (currentSeasonId) {
    const rows = (standBySeason.get(currentSeasonId) ?? [])
      .filter((r) => r.rounds_played > 0)
      .sort((a, b) => b.total_points - a.total_points);
    rows.forEach((r, i) => {
      if (i > 0 && r.total_points === rows[i - 1].total_points) csRank.set(r.player_id, csRank.get(rows[i - 1].player_id)!);
      else csRank.set(r.player_id, i + 1);
    });
  }

  // Per-bucket stats (regular events vs tournaments), identical shape so both
  // buckets get equal-weight coverage. money_won/money_lost split the signed
  // effective score (r.v): positive rows = money won, negative rows = money lost.
  const bucketStats = (rows: PR[]) => {
    if (rows.length === 0) return { total: 0 };
    const best = rows.reduce((a, b) => (b.v > a.v ? b : a));
    return {
      total: rows.length,
      total_score_value: rows.reduce((s, r) => s + r.v, 0),
      wins: rows.filter((r) => r.v > 0).length,
      losses: rows.filter((r) => r.v < 0).length,
      ties: rows.filter((r) => r.v === 0).length,
      money_won: rows.filter((r) => r.v > 0).reduce((s, r) => s + r.v, 0),
      money_lost: rows.filter((r) => r.v < 0).reduce((s, r) => s + r.v, 0),
      best_finish: { date: best.d, score_value: best.v },
    };
  };

  // ── Build spotlight_players ──────────────────────────────────────────────
  const spotlight = playerIds.map((id) => {
    const rs = byPlayer.get(id)!;
    const display_name = nm(id);
    const player: Record<string, unknown> = { display_name, player_id: id };

    if (rs.length > 0) {
      const vals = rs.map((r) => r.v);
      const gpRows = rs.filter((r) => r.gp != null);
      const best = rs.reduce((a, b) => (b.v > a.v ? b : a));
      const worst = rs.reduce((a, b) => (b.v < a.v ? b : a));
      const career: Record<string, unknown> = {
        total_rounds: rs.length,
        total_score_value: vals.reduce((s, v) => s + v, 0),
        best_round: { date: best.d, score_value: best.v, ...(best.gp != null ? { game_points: best.gp } : {}) },
        worst_round: { date: worst.d, score_value: worst.v, ...(worst.gp != null ? { game_points: worst.gp } : {}) },
        biggest_single_round_swing: Math.max(...vals.map((v) => Math.abs(v))),
      };
      if (gpRows.length > 0) career.total_game_points = gpRows.reduce((s, r) => s + (r.gp as number), 0);
      player.career = career;

      const cs = currentSeasonId ? rs.filter((r) => r.sid === currentSeasonId) : [];
      if (cs.length > 0) {
        const csGp = cs.filter((r) => r.gp != null);
        const csObj: Record<string, unknown> = {
          rounds: cs.length,
          score_value: cs.reduce((s, r) => s + r.v, 0),
          standings_rank: csRank.get(id) ?? null,
        };
        if (csGp.length > 0) csObj.game_points = csGp.reduce((s, r) => s + (r.gp as number), 0);
        player.current_season = csObj;
      }

      player.recent_form_last_5 = rs.slice(-5).map((r) => ({ date: r.d, score_value: r.v, result: outcome(r.v) }));

      let cur: string | null = null, curLen = 0, lw = 0, ll = 0, rw = 0, rl = 0;
      for (const r of rs) {
        const o = outcome(r.v);
        if (o === "win") { rw++; rl = 0; } else if (o === "loss") { rl++; rw = 0; } else { rw = 0; rl = 0; }
        lw = Math.max(lw, rw); ll = Math.max(ll, rl);
        if (o === cur) curLen++; else { cur = o; curLen = 1; }
      }
      player.streaks = { current_streak_type: cur, current_streak_length: curLen, longest_win_streak: lw, longest_loss_streak: ll };

    } else {
      player.career = { total_rounds: 0, total_score_value: 0, biggest_single_round_swing: 0 };
    }

    // Two parallel buckets with the SAME shape (incl. a won/lost money split):
    // regular_events = everyday head-to-head rounds (is_tournament = 0),
    // tournaments = pot-based tournament rounds (is_tournament = 1). Both are
    // regular_round rows; the signature_events bucket is retired (no such rows).
    // bucketStats handles the empty-bucket case (total 0).
    player.regular_events = bucketStats(rs.filter((r) => !r.tourney));
    player.tournaments = bucketStats(rs.filter((r) => r.tourney));

    player.championships = { cup_wins: cupWins(id), points_champion_wins: pointsWins(id) };
    player.cup_championship_history = cupHistoryFor(id);

    // Head-to-head: ONLY among the other spotlight players in this request,
    // split into regular vs tournament buckets. A shared round has one
    // is_tournament flag, so orow.tourney classifies it for both players.
    const myByRid = new Map(rs.map((r) => [r.rid, r.v]));
    const h2h: unknown[] = [];
    for (const oid of playerIds) {
      if (oid === id) continue;
      const mk = () => ({ rounds_together: 0, wins: 0, losses: 0, ties: 0, score_value_delta: 0 });
      const regB = mk(), tourB = mk();
      for (const orow of byPlayer.get(oid)!) {
        if (!myByRid.has(orow.rid)) continue;
        const me = myByRid.get(orow.rid)!;
        const b = orow.tourney ? tourB : regB;
        b.rounds_together++;
        b.score_value_delta += me - orow.v;
        if (me > orow.v) b.wins++; else if (me < orow.v) b.losses++; else b.ties++;
      }
      if (regB.rounds_together + tourB.rounds_together > 0) {
        h2h.push({ opponent: nm(oid), regular_events: regB, tournaments: tourB });
      }
    }
    player.head_to_head = h2h;
    return player;
  });

  spotlight.sort((a, b) => {
    const ar = (a.career as { total_rounds: number }).total_rounds;
    const br = (b.career as { total_rounds: number }).total_rounds;
    return br - ar;
  });
  const spotlightNames = spotlight.map((p) => p.display_name as string);

  const payload = {
    group: groupName,
    season_context: currentSeason
      ? {
          current_season: String(seasonYear(currentSeason)),
          current_season_start: currentSeason.start_date,
          current_season_end: currentSeason.end_date,
        }
      : { current_season: null },
    data_caveats: [
      "game_points is NULL for most pre-2026 imported rounds; career/season game_points are partial sums over rounds where it was recorded — do not cite career total_game_points.",
      "Cup Championship finishing order is recorded in championship_results but is incomplete for older seasons — see group_context.championships_played[].data_completeness (complete | partial | winner_only) and each spotlight player's cup_championship_history. Only claim finishing positions for seasons marked complete, or where a player's specific place is recorded; for partial/winner_only seasons cite only the recorded winner and recorded places.",
      "Detailed round-by-round data begins in 2023. Pre-2023 seasons (2020–2022) existed only as season-aggregate points totals and are EXCLUDED from all round-level stats here (career, streaks, recent form, regular/tournament buckets, head-to-head). Those years are represented only in points_champion_history.",
      "Retired players are excluded from selection.",
    ],
    cup_championship_history,
    points_champion_history,
    group_context: { championships_played },
    spotlight_players: spotlight,
  };

  // ── Stage 0: config gate (both keys must be present; hard-fail loudly) ────
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    return json({ error: "Broadcast Notes is not configured yet (ANTHROPIC_API_KEY missing). Ask an admin to set the Supabase function secret." }, 503);
  }
  // Locked: every failure must surface. The fact-check is mandatory, so a
  // missing Perplexity key fails before we spend a Claude call.
  const perplexityKey = Deno.env.get("PERPLEXITY_API_KEY");
  if (!perplexityKey) {
    console.error("PERPLEXITY_API_KEY missing — fact-check cannot run");
    return json({ error: "Fact-check is not configured (PERPLEXITY_API_KEY missing). Ask an admin to set the Supabase function secret." }, 503);
  }

  const generatedAt = new Date().toISOString();

  // ── Best-effort audit-log writer (never fails the request) ────────────────
  // fact_check_audit semantics (migration 033):
  //   null   → fact-check never ran (aborted at stage 1). Column stays NULL.
  //   object → fact-check ran; carries an `error` field on hard-fail paths.
  // input_data semantics (migration 034): the round/season `payload` sent to
  // Claude stage 1 (identical to what stage 2 received). writeAudit is only
  // ever called from stage 2 onward — after the payload was used — so every
  // row it writes carries the payload. Stage-1 aborts write no row, leaving
  // input_data NULL.
  // `notes` holds the stage-1 prose until stage 3 overwrites it with the
  // revised prose on success, so output_length always matches what we return.
  let notes = "";
  let generationMs = 0;
  // Stage-1 claims, persisted alongside the fact-check annotations in
  // fact_check_audit so the audit UI can show claim text + source (not just the
  // verdict). Declared here so writeAudit can read it; populated by stage 1
  // before any audit write (writeAudit only runs from stage 2 onward).
  type Claim = { id: string; claim: string; source: string };
  let claims: Claim[] = [];
  const writeAudit = async (factCheckAudit: Record<string, unknown> | null) => {
    try {
      const hashInput = `${groupId}\n${[...playerIds].sort().join(",")}`;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hashInput));
      const inputHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      // Defensive serialization: payload is plain data (strings/numbers/arrays)
      // and always serializes, but round-tripping guarantees the jsonb value is
      // valid and isolates any future non-serializable value (circular ref,
      // BigInt) to a placeholder rather than failing the whole audit insert.
      let inputData: unknown;
      try {
        inputData = JSON.parse(JSON.stringify(payload));
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        console.error("input_data not serializable, writing placeholder:", reason);
        inputData = { error: `payload not serializable: ${reason}` };
      }
      const admin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const row: Record<string, unknown> = {
        user_id: userId,
        group_id: groupId,
        player_ids: spotlight.map((p) => p.player_id as string),
        spotlight_names: spotlightNames,
        input_hash: inputHash,
        output_length: notes.length,
        generation_ms: generationMs,
        model: MODEL,
        input_data: inputData,
      };
      // claims first, then the fact-check fields (annotations, models,
      // generated_at, plus error on hard-fail paths) from the caller.
      if (factCheckAudit !== null) row.fact_check_audit = { claims, ...factCheckAudit };
      const { error: logErr } = await admin.from("broadcast_notes_log").insert(row);
      if (logErr) console.error("broadcast_notes_log insert failed:", logErr.message);
    } catch (e) {
      console.error("broadcast_notes_log insert threw:", e instanceof Error ? e.message : String(e));
    }
  };

  // ── Stage 1: Claude generates notes + a structured claims list ────────────
  // SYSTEM_PROMPT (tone) is unchanged. Output is collected via a forced
  // tool call (submit_broadcast_notes) so the structured payload is guaranteed
  // well-formed JSON from the API — no text parsing, no fence stripping, and
  // none of the malformed/partial-JSON failure classes. max_tokens is 8000 so
  // a full prose+claims response has comfortable headroom (4000 truncated in
  // production). Stage-1 failures return WITHOUT an audit write (fact-check
  // never ran → NULL).
  const stage1Prompt =
`Context: a ${groupName} playoff broadcast.

Spotlight players: ${spotlightNames.join(", ")}.

Write the broadcast notes: 4-6 punchy numbered one-liners (≤25 words each), then a blank line, then 2-3 storyline arcs (short bold headline + 2-3 sentence narrative), then a Cup Championship history section when there's enough material. Label the sections "ONE-LINERS", "STORYLINES", and "CUP CHAMPIONSHIP HISTORY".

The Cup Championship history section stands on its own (not woven into the other storylines). Cover individual players' Cup Championship trajectories (their best and worst showings, recent trends, championship wins or droughts) AND comparative storylines that pit the spotlight players' Cup histories against each other. Honor the Cup data-completeness rule: only claim finishing positions the data actually records.

Submit your result with the submit_broadcast_notes tool:
- "notes": the broadcast notes prose described above, in your normal voice.
- "claims": every factual claim the notes make. Emit one claim per player-name mention, score, hole number, stroke count, date, head-to-head outcome, season-level stat, and historical reference. For each claim, set "source" to "round_data" when it comes straight from the Data payload below, or "general_knowledge" when it is inferred or drawn from your own training knowledge.

Data:
\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\``;

  const submitNotesTool = {
    name: "submit_broadcast_notes",
    description: "Submit the broadcast notes prose and the structured list of factual claims it makes.",
    input_schema: {
      type: "object",
      properties: {
        notes: { type: "string", description: "The broadcast notes prose in Buzz's preferred voice." },
        claims: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              claim: { type: "string" },
              source: { type: "string", enum: ["round_data", "general_knowledge"] },
            },
            required: ["id", "claim", "source"],
          },
        },
      },
      required: ["notes", "claims"],
    },
  };

  const t0 = Date.now();
  try {
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        tools: [submitNotesTool],
        tool_choice: { type: "tool", name: "submit_broadcast_notes" },
        messages: [{ role: "user", content: stage1Prompt }],
      }),
    });
    const aiText = await aiRes.text();
    if (!aiRes.ok) {
      console.error("Stage 1 (Claude generate) HTTP error:", aiText.slice(0, 500));
      return json({ error: "Commentary generation failed", details: aiText.slice(0, 500) }, 502);
    }
    const aiJson = JSON.parse(aiText) as {
      stop_reason?: string;
      content?: { type: string; input?: unknown; text?: string }[];
    };
    // Truncation surfaces as stop_reason "max_tokens" (vs the expected
    // "tool_use"); fail loudly and specifically rather than as a vague parse
    // error downstream.
    if (aiJson.stop_reason === "max_tokens") {
      console.error("Stage 1 truncated at max_tokens");
      return json({ error: "Stage 1 truncated — increase max_tokens or reduce input size" }, 502);
    }
    const toolUse = (aiJson.content ?? []).find((b) => b.type === "tool_use");
    if (!toolUse || typeof toolUse.input !== "object" || toolUse.input === null) {
      console.error("Stage 1 returned no tool_use block:", aiText.slice(0, 1000));
      return json({ error: "Commentary generation returned no structured output" }, 502);
    }
    const parsed = toolUse.input as { notes?: unknown; claims?: unknown };
    notes = typeof parsed.notes === "string" ? parsed.notes.trim() : "";
    if (!notes) return json({ error: "Commentary generation returned no notes text" }, 502);
    if (!Array.isArray(parsed.claims)) {
      console.error("Stage 1 tool output omitted the claims array:", JSON.stringify(toolUse.input).slice(0, 1000));
      return json({ error: "Commentary generation returned no claims to fact-check" }, 502);
    }
    claims = parsed.claims as Claim[];
  } catch (e) {
    console.error("Stage 1 (Claude generate) threw:", e instanceof Error ? e.message : String(e));
    return json({ error: "Commentary generation error", details: e instanceof Error ? e.message : String(e) }, 502);
  }
  generationMs = Date.now() - t0;

  // ── Stage 2: Perplexity fact-checks each claim ────────────────────────────
  // From here on, fact-check HAS run: every hard-fail path writes an audit row
  // with an `error` field before returning, then surfaces the failure.
  const factCheckSystem =
`You are a fact-checker. Do NOT rewrite, polish, summarize, or improve any text — only verify.

Verify each claim in the CLAIMS list:
- source "round_data": check the claim ONLY against the provided DATA payload.
- source "general_knowledge": verify against public knowledge using web search.

Treat ambiguity as ambiguous, not wrong. Example: "the player who finished 2nd" without saying which season is "ambiguous". Use "wrong" only when the claim contradicts the evidence.

When verifying head-to-head records and other symmetric relational data, note that "X is N-M against Y" and "Y is M-N against X" are equivalent statements about the same underlying data. A claim like "Bübes is 1-0 against FJ" is correct as long as the payload shows Bübes with 1 win and 0 losses vs FJ — the phrasing direction does not make a claim wrong. Flag a claim as "wrong" only when the numbers themselves don't match the payload, not when the perspective or phrasing differs from how you would express it.

Before returning each annotation, perform a self-consistency check: read your \`correction\` field and compare it to the original \`claim\`. If the correction is semantically identical to the claim (same numbers, same teams, same relationship — only phrasing differs), then the claim was correct and your status must be \`verified\`, not \`wrong\`. If your \`reasoning\` field supports the original claim, your status must align — do not flag \`wrong\` when your reasoning confirms the claim is true.

Return ONLY a JSON array (no prose, no markdown fences), one object per claim:
[{ "id": "<claim id>", "status": "verified" | "wrong" | "ambiguous" | "unverifiable", "correction": "<corrected fact — include only when status is wrong>", "reasoning": "<one concise sentence>" }]`;

  const factCheckUser =
`DATA payload (ground truth for round_data claims):
\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\`

CLAIMS to verify:
\`\`\`json
${JSON.stringify(claims, null, 2)}
\`\`\``;

  type Annotation = { id: string; status: string; correction?: string; reasoning: string };
  let annotations: Annotation[] = [];
  {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FACT_CHECK_TIMEOUT_MS);
    let pplxText = "";
    try {
      const res = await fetch(PERPLEXITY_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${perplexityKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: PERPLEXITY_MODEL,
          messages: [
            { role: "system", content: factCheckSystem },
            { role: "user", content: factCheckUser },
          ],
        }),
        signal: ctrl.signal,
      });
      pplxText = await res.text();
      if (!res.ok) {
        const reason = `Perplexity API returned ${res.status}`;
        console.error("Stage 2 (Perplexity) HTTP error:", res.status, pplxText.slice(0, 500));
        await writeAudit({ annotations: [], perplexity_model: PERPLEXITY_MODEL, claude_model: MODEL, generated_at: generatedAt, error: reason });
        return json({ error: `Fact-check failed: ${reason}. Retry or re-run without fact-check.`, perplexity_error: pplxText.slice(0, 500) }, 502);
      }
    } catch (e) {
      const aborted = (e as { name?: string })?.name === "AbortError";
      const reason = aborted ? `timed out after ${FACT_CHECK_TIMEOUT_MS / 1000}s` : (e instanceof Error ? e.message : String(e));
      console.error("Stage 2 (Perplexity) failed:", reason);
      await writeAudit({ annotations: [], perplexity_model: PERPLEXITY_MODEL, claude_model: MODEL, generated_at: generatedAt, error: reason });
      return json({ error: `Fact-check failed: ${reason}. Retry or re-run without fact-check.`, perplexity_error: reason }, 502);
    } finally {
      clearTimeout(timer);
    }

    // Parse the OpenAI-compatible envelope, then the JSON array inside it.
    try {
      const pj = JSON.parse(pplxText) as { choices?: { message?: { content?: string } }[] };
      const content = pj.choices?.[0]?.message?.content ?? "";
      const arr = JSON.parse(stripJsonFence(content));
      if (!Array.isArray(arr)) throw new Error("fact-check result is not a JSON array");
      annotations = arr as Annotation[];
    } catch (e) {
      const reason = "Perplexity returned malformed JSON";
      console.error("Stage 2 (Perplexity) malformed response:", e instanceof Error ? e.message : String(e), "\nRAW:", pplxText.slice(0, 2000));
      await writeAudit({ annotations: [], perplexity_model: PERPLEXITY_MODEL, claude_model: MODEL, generated_at: generatedAt, error: reason });
      return json({ error: `Fact-check failed: ${reason}. Retry or re-run without fact-check.`, perplexity_error: pplxText.slice(0, 500) }, 502);
    }
  }

  // ── Stage 3: Claude integrates the corrections it agrees with ─────────────
  // Same model + tone prompt as stage 1, so the voice is preserved. On failure
  // the audit row keeps the stage-2 annotations we already have, plus an error.
  const stage3Prompt =
`Here are your original broadcast notes:

${notes}

A fact-checker reviewed them and returned these annotations (JSON):
\`\`\`json
${JSON.stringify(annotations, null, 2)}
\`\`\`

Apply the corrections you agree with. Preserve your original voice and energy. Tighten any ambiguity. Return only the revised notes prose — no JSON, no explanation, no preamble.`;

  let revised = "";
  try {
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: stage3Prompt }],
      }),
    });
    const aiText = await aiRes.text();
    if (!aiRes.ok) {
      console.error("Stage 3 (Claude integrate) HTTP error:", aiText.slice(0, 500));
      await writeAudit({ annotations, perplexity_model: PERPLEXITY_MODEL, claude_model: MODEL, generated_at: generatedAt, error: `Claude integration returned ${aiRes.status}` });
      return json({ error: "Fact-check integration failed", details: aiText.slice(0, 500) }, 502);
    }
    const aiJson = JSON.parse(aiText) as { stop_reason?: string; content?: { type: string; text?: string }[] };
    // Same truncation guard as stage 1: fail specifically on max_tokens rather
    // than silently returning half-revised prose.
    if (aiJson.stop_reason === "max_tokens") {
      console.error("Stage 3 truncated at max_tokens");
      await writeAudit({ annotations, perplexity_model: PERPLEXITY_MODEL, claude_model: MODEL, generated_at: generatedAt, error: "Claude integration truncated at max_tokens" });
      return json({ error: "Stage 3 truncated — increase max_tokens or reduce input size" }, 502);
    }
    revised = (aiJson.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n")
      .trim();
    if (!revised) {
      console.error("Stage 3 (Claude integrate) returned no text");
      await writeAudit({ annotations, perplexity_model: PERPLEXITY_MODEL, claude_model: MODEL, generated_at: generatedAt, error: "Claude integration returned no text" });
      return json({ error: "Fact-check integration returned no text" }, 502);
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    console.error("Stage 3 (Claude integrate) threw:", reason);
    await writeAudit({ annotations, perplexity_model: PERPLEXITY_MODEL, claude_model: MODEL, generated_at: generatedAt, error: `Claude integration error: ${reason}` });
    return json({ error: "Fact-check integration error", details: reason }, 502);
  }

  // Success: the revised prose is what we return and what output_length reflects.
  notes = revised;
  await writeAudit({ annotations, perplexity_model: PERPLEXITY_MODEL, claude_model: MODEL, generated_at: generatedAt });

  return json({
    notes,
    generated_at: generatedAt,
    spotlight_names: spotlightNames,
    fact_check: { annotations, status: "ok", perplexity_model: PERPLEXITY_MODEL, claude_model: MODEL },
  }, 200);
});
