// Ingest event results: create a league_round and league_scores (points ledger rows) from POST body.
// Windex ingests only final awarded point totals per player — no golf scorecard data,
// hole-by-hole scores, gross/net, or stroke counts. Auth required; RLS enforces group/ownership.
// Domain rules: scoring_mode (points vs win_loss_override input), season-group match, override metadata.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Points mode accepts the final awarded points/deltas coming from external systems.
// Glide exports in this repo can contain values well outside the legacy -10..10 window.
// Keep this range wide enough to support real league point scales while still guarding against
// clearly invalid numbers.
const POINTS_MIN = -1000;
const POINTS_MAX = 1000;
const STROKE_LIKE_MIN = 20;
const STROKE_LIKE_MAX = 130;

const WIN_POINTS = 1;
const LOSS_POINTS = 0;
const TIE_POINTS = 0.5;

interface ScoreInput {
  player_id?: string | null;
  source_player_ref?: string | null;
  source_player_name?: string | null;
  score_value?: number | null;
  score_override?: number | null;
  game_points?: number | null;
  result_type?: "win" | "loss" | "tie" | null;
  override_actor?: string | null;
  override_reason?: string | null;
  /** From source (e.g. Glide); stored in player_mapping_queue when unresolved */
  source_email?: string | null;
  source_venmo_handle?: string | null;
  source_photo_url?: string | null;
  source_is_active?: boolean | number | null;
  source_role?: string | null;
}

interface IngestBody {
  group_id: string;
  season_id?: string | null;
  round_date: string;
  scores_override?: boolean;
  /** When provided (e.g. from Glide Round/Submitted At), stored on league_rounds.submitted_at */
  submitted_at?: string | null;
  source_app?: string | null;
  external_event_id?: string | null;
  is_tournament?: number | null;
  tournament_buyin?: number | null;
  scores: ScoreInput[];
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
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

  let body: IngestBody;
  try {
    body = (await req.json()) as IngestBody;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { group_id, season_id, round_date, scores_override, submitted_at: bodySubmittedAt, source_app, external_event_id, is_tournament, tournament_buyin, scores } = body;
  if (!group_id || !round_date || !Array.isArray(scores) || scores.length === 0) {
    return new Response(
      JSON.stringify({ error: "group_id, round_date, and non-empty scores required" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Reject future-dated rounds. "Today" is evaluated in Pacific time (league locale) rather than
  // UTC, so a round entered on a Pacific evening that is already "tomorrow" in UTC is not falsely
  // rejected. round_date is a "YYYY-MM-DD" ISO date string, so a lexical comparison is correct.
  const pacificToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
  }).format(new Date()); // -> "YYYY-MM-DD"
  if (round_date > pacificToday) {
    return new Response(
      JSON.stringify({ error: "round_date cannot be in the future" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const hasExternalId = source_app != null && source_app !== "" && external_event_id != null && external_event_id !== "";

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

  // Fetch group (scoring_mode)
  const { data: groupRow, error: groupErr } = await supabase
    .from("groups")
    .select("id, scoring_mode")
    .eq("id", group_id)
    .maybeSingle();
  if (groupErr || !groupRow) {
    return new Response(
      JSON.stringify({ error: "Group not found or access denied" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const scoringMode = (groupRow as { scoring_mode?: string }).scoring_mode ?? "points";

  // Event structure: if season_id provided, season must belong to this group
  if (season_id) {
    const { data: seasonRow } = await supabase
      .from("seasons")
      .select("id, group_id")
      .eq("id", season_id)
      .maybeSingle();
    if (!seasonRow || (seasonRow as { group_id: string }).group_id !== group_id) {
      return new Response(
        JSON.stringify({
          error: "season_id must belong to the same group",
          code: "season_group_mismatch",
        }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }

  const userId = user.user.id;

  // Resolve each score to canonical player_id: use player_id if present, else lookup player_mappings by (user_id, source_app, source_player_ref ?? source_player_name); if no mapping, add to queue (idempotent) and skip.
  type ResolvedScore = { score: ScoreInput; player_id: string };
  type UnresolvedScore = { score: ScoreInput; lookupRef: string; source_player_name: string };
  const resolvedScores: ResolvedScore[] = [];
  const unresolvedScores: UnresolvedScore[] = [];

  for (const score of scores) {
    const hasCanonical = score.player_id != null && String(score.player_id).trim() !== "";
    const hasSourceIdentity = source_app != null && source_app !== "" && (score.source_player_ref != null && score.source_player_ref !== "" || score.source_player_name != null && score.source_player_name !== "");
    const lookupRefRaw = score.source_player_ref ?? score.source_player_name ?? "";
    const lookupRef = typeof lookupRefRaw === "string" ? lookupRefRaw.trim() : "";

    if (hasCanonical) {
      resolvedScores.push({ score, player_id: (score.player_id as string).trim() });
      continue;
    }
    if (hasSourceIdentity && lookupRef !== "") {
      const { data: mappingRow } = await supabase
        .from("player_mappings")
        .select("canonical_player_id")
        .eq("user_id", userId)
        .eq("source_app", source_app)
        .eq("source_player_ref", lookupRef)
        .maybeSingle();
      if (mappingRow?.canonical_player_id) {
        resolvedScores.push({ score, player_id: (mappingRow as { canonical_player_id: string }).canonical_player_id });
        continue;
      }
      const sourcePlayerName = (score.source_player_name != null && String(score.source_player_name).trim() !== "")
        ? String(score.source_player_name).trim()
        : lookupRef;
      unresolvedScores.push({ score, lookupRef, source_player_name: sourcePlayerName });
      continue;
    }
    return new Response(
      JSON.stringify({
        error: "Each score must have player_id or (when source_app is set) source_player_ref or source_player_name",
        code: "score_identity_required",
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (resolvedScores.length === 0) {
    return new Response(
      JSON.stringify({
        error: "No scores could be resolved to canonical players; add mappings or provide player_id",
        code: "no_resolved_scores",
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Membership: all resolved player_ids must be active members of the group
  const { data: members } = await supabase
    .from("group_members")
    .select("player_id")
    .eq("group_id", group_id)
    .eq("is_active", 1);
  const allowedPlayerIds = new Set((members ?? []).map((m: { player_id: string }) => m.player_id));
  const submittedPlayerIds = [...new Set(resolvedScores.map((r) => r.player_id))];
  const invalidPlayerIds = submittedPlayerIds.filter((id) => !allowedPlayerIds.has(id));
  if (invalidPlayerIds.length > 0) {
    return new Response(
      JSON.stringify({
        error: "All player_ids must be active members of the group",
        invalid_player_ids: invalidPlayerIds,
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const now = new Date().toISOString();
  const submittedAt =
    bodySubmittedAt != null && String(bodySubmittedAt).trim() !== ""
      ? (() => {
          const parsed = new Date(bodySubmittedAt);
          return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : now;
        })()
      : now;

  // Build normalized score rows from resolved scores only (score_value, score_override, result_type, etc.)
  type ScoreRow = {
    id: string;
    league_round_id: string;
    player_id: string;
    score_value: number | null;
    score_override: number | null;
    game_points: number | null;
    result_type: string | null;
    override_actor: string | null;
    override_reason: string | null;
    override_at: string | null;
    created_at: string;
    updated_at: string;
  };

  let scoreRows: ScoreRow[];

  if (scoringMode === "win_loss_override") {
    const validResultTypes = new Set(["win", "loss", "tie"]);
    for (const { score: s } of resolvedScores) {
      const rt = s.result_type ?? null;
      if (rt === null || !validResultTypes.has(rt)) {
        return new Response(
          JSON.stringify({
            error: "win_loss_override mode requires result_type (win, loss, or tie) for each score",
            code: "invalid_result_type",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }
    scoreRows = resolvedScores.map(({ score: s, player_id: pid }) => {
      const rt = (s.result_type ?? "loss") as "win" | "loss" | "tie";
      const points = rt === "win" ? WIN_POINTS : rt === "tie" ? TIE_POINTS : LOSS_POINTS;
      const hasOverride = s.score_override != null;
      return {
        id: crypto.randomUUID(),
        league_round_id: "",
        player_id: pid,
        score_value: points,
        score_override: s.score_override ?? null,
        game_points: null,
        result_type: rt,
        override_actor: hasOverride ? (s.override_actor ?? null) : null,
        override_reason: hasOverride ? (s.override_reason ?? null) : null,
        override_at: hasOverride ? now : null,
        created_at: now,
        updated_at: now,
      };
    });
    for (const row of scoreRows) {
      if ((row.score_override != null && (!row.override_actor || !row.override_reason)) ||
          (row.override_actor != null && row.score_override == null)) {
        return new Response(
          JSON.stringify({
            error: "When score_override is set, override_actor and override_reason are required",
            code: "override_metadata_required",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }
  } else {
    // points mode: validate that each score has either game_points or score_value/score_override
    const allHaveGP = resolvedScores.every(({ score: s }) => typeof s.game_points === "number");
    for (const { score: s } of resolvedScores) {
      const effective = s.score_override != null ? s.score_override : s.score_value;
      // If game_points is provided for all players, score_value will be computed server-side — skip this check
      if (allHaveGP && typeof s.game_points === "number") continue;
      if (effective == null || typeof effective !== "number") {
        return new Response(
          JSON.stringify({ error: "points mode requires a numeric score_value (or score_override or game_points) per player", code: "points_value_required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      // Note: older versions attempted to reject “stroke-like” values here.
      // However, some leagues encode points with values that overlap typical stroke ranges,
      // so we rely on the points window check below instead.
      if (effective != null && (effective < POINTS_MIN || effective > POINTS_MAX)) {
        return new Response(
          JSON.stringify({
            error: `points mode requires values between ${POINTS_MIN} and ${POINTS_MAX}`,
            code: "points_out_of_range",
            value: effective,
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const hasOverride = s.score_override != null;
      if (hasOverride && (!s.override_actor || !s.override_reason)) {
        return new Response(
          JSON.stringify({
            error: "When score_override is set, override_actor and override_reason are required",
            code: "override_metadata_required",
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }
    // Check if all resolved scores have game_points — if so, compute score_value server-side
    const allHaveGamePoints = resolvedScores.every(({ score: s }) => typeof s.game_points === "number");

    let computedScoreValues: Map<string, number> | null = null;
    if (allHaveGamePoints) {
      const isTournament = is_tournament === 1 && typeof tournament_buyin === "number" && tournament_buyin > 0;
      computedScoreValues = new Map();

      if (isTournament) {
        // Tournament: score_value = game_points - tournament_buyin (no h2h formula)
        for (const { score: s, player_id: pid } of resolvedScores) {
          const gp = s.game_points ?? 0;
          computedScoreValues.set(pid, gp - (tournament_buyin as number));
        }
      } else {
        // Regular: score_value = N × game_points - round_total (h2h formula)
        const N = resolvedScores.length;
        const roundTotal = resolvedScores.reduce((sum, { score: s }) => sum + (s.game_points ?? 0), 0);
        for (const { score: s, player_id: pid } of resolvedScores) {
          const gp = s.game_points ?? 0;
          computedScoreValues.set(pid, N * gp - roundTotal);
        }
      }
    }

    scoreRows = resolvedScores.map(({ score: s, player_id: pid }) => {
      const hasOverride = s.score_override != null;
      // Use server-computed h2h value if game_points present, otherwise use provided score_value
      const scoreVal = computedScoreValues
        ? (computedScoreValues.get(pid) ?? 0)
        : (typeof s.score_value === "number" ? s.score_value : (s.score_override ?? null));
      return {
        id: crypto.randomUUID(),
        league_round_id: "",
        player_id: pid,
        score_value: scoreVal,
        score_override: s.score_override ?? null,
        game_points: typeof s.game_points === "number" ? s.game_points : null,
        result_type: null,
        override_actor: hasOverride ? (s.override_actor ?? null) : null,
        override_reason: hasOverride ? (s.override_reason ?? null) : null,
        override_at: hasOverride ? now : null,
        created_at: now,
        updated_at: now,
      };
    });
  }

  let leagueRoundId: string;

  if (hasExternalId) {
    const { data: existing } = await supabase
      .from("league_rounds")
      .select("id")
      .eq("group_id", group_id)
      .eq("source_app", source_app!)
      .eq("external_event_id", external_event_id!)
      .maybeSingle();
    if (existing?.id) {
      return new Response(
        JSON.stringify({ id: existing.id, league_round_id: existing.id }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }

  leagueRoundId = crypto.randomUUID();
  for (const r of scoreRows) {
    r.league_round_id = leagueRoundId;
  }

  const processingStatus = unresolvedScores.length > 0 ? "partial_unresolved_players" : "processed";
  const unresolvedPlayerCount = unresolvedScores.length;
  const attributionStatus = season_id != null && String(season_id).trim() !== "" ? "attributed" : "pending_attribution";

  const { error: roundError } = await supabase.from("league_rounds").insert({
    id: leagueRoundId,
    user_id: userId,
    group_id,
    season_id: season_id || null,
    round_date,
    submitted_at: submittedAt,
    scores_override: scores_override ? 1 : 0,
    is_tournament: is_tournament === 1 ? 1 : 0,
    tournament_buyin: (is_tournament === 1 && typeof tournament_buyin === "number") ? tournament_buyin : null,
    source_app: source_app || null,
    external_event_id: external_event_id || null,
    processing_status: processingStatus,
    unresolved_player_count: unresolvedPlayerCount,
    attribution_status: attributionStatus,
    created_at: now,
    updated_at: now,
  });

  if (roundError) {
    if (hasExternalId && roundError.code === "23505") {
      const { data: existing } = await supabase
        .from("league_rounds")
        .select("id")
        .eq("group_id", group_id)
        .eq("source_app", source_app!)
        .eq("external_event_id", external_event_id!)
        .maybeSingle();
      if (existing?.id) {
        return new Response(
          JSON.stringify({ id: existing.id, league_round_id: existing.id }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }
    return new Response(
      JSON.stringify({ error: "Failed to create league round", details: roundError.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Idempotent queue insert for unresolved identities: one pending row per (user_id, source_app, lookupRef)
  const sourceAppVal = source_app ?? null;
  let existingPendingKeys: Set<string> = new Set();
  if (unresolvedScores.length > 0) {
    let q = supabase
      .from("player_mapping_queue")
      .select("source_app, source_player_ref, source_player_name")
      .eq("user_id", userId)
      .eq("status", "pending");
    if (sourceAppVal != null) q = q.eq("source_app", sourceAppVal);
    else q = q.is("source_app", null);
    const { data: pendingRows } = await q;
    (pendingRows ?? []).forEach((r: { source_player_ref?: string | null; source_player_name?: string | null }) => {
      const key = (r.source_player_ref ?? r.source_player_name ?? "").trim();
      if (key) existingPendingKeys.add(key);
    });
  }
  for (const u of unresolvedScores) {
    if (existingPendingKeys.has(u.lookupRef)) continue;
    existingPendingKeys.add(u.lookupRef);
    const s = u.score;
    const sourceIsActive =
      s.source_is_active === true || s.source_is_active === 1
        ? 1
        : s.source_is_active === false || s.source_is_active === 0
          ? 0
          : null;
    await supabase.from("player_mapping_queue").insert({
      user_id: userId,
      source_app: sourceAppVal,
      source_player_name: u.source_player_name,
      source_player_ref: s.source_player_ref != null && String(s.source_player_ref).trim() !== "" ? String(s.source_player_ref).trim() : null,
      related_league_round_id: leagueRoundId,
      status: "pending",
      source_email: s.source_email != null && String(s.source_email).trim() !== "" ? String(s.source_email).trim() : null,
      source_venmo_handle: s.source_venmo_handle != null && String(s.source_venmo_handle).trim() !== "" ? String(s.source_venmo_handle).trim() : null,
      source_photo_url: s.source_photo_url != null && String(s.source_photo_url).trim() !== "" ? String(s.source_photo_url).trim() : null,
      source_is_active: sourceIsActive,
      source_role: s.source_role != null && String(s.source_role).trim() !== "" ? String(s.source_role).trim() : null,
      created_at: now,
      updated_at: now,
    });
  }

  const insertRows = scoreRows.map((r) => ({
    id: r.id,
    league_round_id: r.league_round_id,
    player_id: r.player_id,
    score_value: r.score_value,
    score_override: r.score_override,
    game_points: r.game_points,
    result_type: r.result_type,
    override_actor: r.override_actor,
    override_reason: r.override_reason,
    override_at: r.override_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));

  const { error: scoresError } = await supabase.from("league_scores").insert(insertRows);

  if (scoresError) {
    return new Response(
      JSON.stringify({ error: "Failed to create league scores", details: scoresError.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({ id: leagueRoundId, league_round_id: leagueRoundId }),
    { status: 201, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
