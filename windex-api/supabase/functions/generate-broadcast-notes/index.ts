// POST /generate-broadcast-notes
// Body: { group_id: string, player_ids: string[] }  (2-6 ids)
//
// Auth: caller must be an authenticated member of group_id (am_i_group_member,
// migration 014). 401 if no/invalid JWT, 403 if not a member.
//
// Computes a GROUP-SCOPED stats payload for the selected spotlight players
// (career, current-season, recent form, streaks, signature events,
// championship history, and head-to-head among the spotlight players only),
// sends it to the Anthropic API with a fixed broadcaster system prompt, and
// returns the generated commentary. Every call is logged to
// broadcast_notes_log (best-effort; logging failure never fails the request).
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

const SYSTEM_PROMPT =
`You are a senior sports broadcaster prepping playoff commentary for a recurring private golf points league. Surface specific, quotable, stat-grounded angles a play-by-play announcer and color commentator would use.

Rules:
- Every claim must be grounded in a specific number from the data. Don't invent stats. If a stat isn't there, don't say it.
- Prefer head-to-head records, streaks, championship history, and recent form over generic season totals.
- Tone: confident, punchy, broadcast-style. Hyperbole is fine when the data backs it.
- Surface tension: rivalries (close H2H), dominance (lopsided H2H), comebacks, choking history (poor signature-event from strong regular-season players), championship pedigree.
- Game points data is mostly NULL pre-2026 — do NOT cite career total_game_points. Use total_score_value, head-to-head records, and championship/streak data instead.
- No emojis. No markdown headers. Use **bold** only for storyline headlines when format calls for it.`;

type RoundRow = { id: string; season_id: string | null; round_date: string; is_signature_event: number };
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
        .select("id, season_id, round_date, is_signature_event")
        .eq("group_id", groupId)
        .order("round_date")
        .range(offset, offset + PAGE - 1);
      if (error) return json({ error: "Failed to fetch rounds", details: error.message }, 500);
      const rows = (page ?? []) as RoundRow[];
      groupRounds.push(...rows);
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

  // Per-player chronological round list (group-scoped).
  type PR = { rid: string; d: string; sid: string | null; sig: boolean; v: number; gp: number | null };
  const byPlayer = new Map<string, PR[]>();
  for (const id of playerIds) byPlayer.set(id, []);
  for (const s of scores) {
    const r = roundById.get(s.league_round_id);
    if (!r) continue;
    byPlayer.get(s.player_id)!.push({
      rid: r.id, d: r.round_date, sid: r.season_id,
      sig: r.is_signature_event === 1, v: eff(s), gp: s.game_points,
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

      const sig = rs.filter((r) => r.sig);
      if (sig.length === 0) {
        player.signature_events = { total: 0 };
      } else {
        const sBest = sig.reduce((a, b) => (b.v > a.v ? b : a));
        player.signature_events = {
          total: sig.length,
          total_score_value: sig.reduce((s, r) => s + r.v, 0),
          wins: sig.filter((r) => r.v > 0).length,
          best_finish: { date: sBest.d, score_value: sBest.v },
        };
      }
    } else {
      player.career = { total_rounds: 0, total_score_value: 0, biggest_single_round_swing: 0 };
      player.signature_events = { total: 0 };
    }

    player.championships = { cup_wins: cupWins(id), points_champion_wins: pointsWins(id) };

    // Head-to-head: ONLY among the other spotlight players in this request.
    const myByRid = new Map(rs.map((r) => [r.rid, r.v]));
    const h2h: Record<string, unknown> = {};
    for (const oid of playerIds) {
      if (oid === id) continue;
      let rt = 0, w = 0, l = 0, t = 0, net = 0;
      for (const orow of byPlayer.get(oid)!) {
        if (myByRid.has(orow.rid)) {
          const me = myByRid.get(orow.rid)!;
          rt++; net += me - orow.v;
          if (me > orow.v) w++; else if (me < orow.v) l++; else t++;
        }
      }
      if (rt > 0) h2h[nm(oid)] = { rounds_together: rt, wins: w, losses: l, ties: t, net_score_value: net };
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
      "Cup runners-up / full finish order are not stored — only the winner per season.",
      "Early seasons may have been imported as aggregated single-summary rounds, so per-round granularity for those years is coarse.",
      "Retired players are excluded from selection.",
    ],
    cup_championship_history,
    points_champion_history,
    spotlight_players: spotlight,
  };

  const userPrompt =
`Context: a ${groupName} playoff broadcast.

Spotlight players: ${spotlightNames.join(", ")}.

First: 4-6 punchy numbered one-liners (≤25 words each). Then a blank line. Then 2-3 storyline arcs (short bold headline + 2-3 sentence narrative). Label the sections "ONE-LINERS" and "STORYLINES".

Data:
\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\``;

  // ── Anthropic call ───────────────────────────────────────────────────────
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    return json({ error: "Broadcast Notes is not configured yet (ANTHROPIC_API_KEY missing). Ask an admin to set the Supabase function secret." }, 503);
  }

  let notes = "";
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
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    const aiText = await aiRes.text();
    if (!aiRes.ok) {
      return json({ error: "Commentary generation failed", details: aiText.slice(0, 500) }, 502);
    }
    const aiJson = JSON.parse(aiText) as { content?: { type: string; text?: string }[] };
    notes = (aiJson.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n")
      .trim();
    if (!notes) return json({ error: "Commentary generation returned no text" }, 502);
  } catch (e) {
    return json({ error: "Commentary generation error", details: e instanceof Error ? e.message : String(e) }, 502);
  }
  const generationMs = Date.now() - t0;
  const generatedAt = new Date().toISOString();

  // ── Best-effort audit log (never fails the request) ──────────────────────
  try {
    const hashInput = `${groupId}\n${[...playerIds].sort().join(",")}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hashInput));
    const inputHash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: logErr } = await admin.from("broadcast_notes_log").insert({
      user_id: userId,
      group_id: groupId,
      player_ids: spotlight.map((p) => p.player_id as string),
      spotlight_names: spotlightNames,
      input_hash: inputHash,
      output_length: notes.length,
      generation_ms: generationMs,
      model: MODEL,
    });
    if (logErr) console.error("broadcast_notes_log insert failed:", logErr.message);
  } catch (e) {
    console.error("broadcast_notes_log insert threw:", e instanceof Error ? e.message : String(e));
  }

  return json({ notes, generated_at: generatedAt, spotlight_names: spotlightNames }, 200);
});
