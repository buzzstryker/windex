// Round-scoped settlement calculation: compute and write money_delta for one round.
// Standings remain points-only; this function only updates league_scores.money_delta.
// Config: groups.dollars_per_point. NULL = computed: false, no write. 0 or positive = zero-sum from round mean.
// Formula: effective_points = COALESCE(score_override, score_value); round_mean = average(effective_points);
// money_delta = (effective_points - round_mean) * dollars_per_point, rounded to 2 decimals; residual applied to row with smallest id.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Body {
  league_round_id?: string | null;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
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

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const leagueRoundId = body.league_round_id?.trim() || null;
  if (!leagueRoundId) {
    return new Response(
      JSON.stringify({ error: "league_round_id required", code: "missing_league_round_id" }),
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

  const userId = user.user.id;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const admin = serviceRoleKey
    ? createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
    : null;
  const db = admin ?? supabase;

  const { data: round, error: roundErr } = await db
    .from("league_rounds")
    .select("id, group_id, season_id, user_id")
    .eq("id", leagueRoundId)
    .maybeSingle();

  if (roundErr) {
    return new Response(
      JSON.stringify({ error: "Failed to load round", details: roundErr.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  if (!round) {
    return new Response(
      JSON.stringify({ error: "Round not found or access denied", code: "round_not_found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
  const roundUserId = (round as { user_id?: string }).user_id;
  if (roundUserId == null || String(roundUserId) !== String(userId)) {
    return new Response(
      JSON.stringify({ error: "Round not found or access denied", code: "round_not_found" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const groupId = (round as { group_id: string }).group_id;
  const { data: groupRow, error: groupErr } = await db
    .from("groups")
    .select("dollars_per_point")
    .eq("id", groupId)
    .maybeSingle();

  if (groupErr) {
    return new Response(
      JSON.stringify({ error: "Failed to load group config", details: groupErr.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const dollarsPerPoint = groupRow?.dollars_per_point;
  if (dollarsPerPoint == null) {
    return new Response(
      JSON.stringify({
        league_round_id: leagueRoundId,
        computed: false,
        reason: "no_payout_config",
        message: "Payout formula/config not configured; money_delta left unchanged (NULL).",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const { data: scores, error: scoresErr } = await db
    .from("league_scores")
    .select("id, player_id, score_value, score_override")
    .eq("league_round_id", leagueRoundId)
    .order("id", { ascending: true });

  if (scoresErr) {
    return new Response(
      JSON.stringify({ error: "Failed to load scores", details: scoresErr.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const rows = scores ?? [];
  if (rows.length === 0) {
    return new Response(
      JSON.stringify({ league_round_id: leagueRoundId, computed: true, updated: 0 }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const effectivePoints = (s: { score_value?: number | null; score_override?: number | null }) =>
    s.score_override != null ? s.score_override : s.score_value ?? 0;

  const n = rows.length;
  const sumPts = rows.reduce((s, r) => s + effectivePoints(r), 0);
  const roundMean = sumPts / n;
  const rate = dollarsPerPoint as number;

  const rawDeltas = rows.map((r) => (effectivePoints(r) - roundMean) * rate);
  const rounded = rawDeltas.map((v) => round2(v));
  const sumRounded = rounded.reduce((a, b) => a + b, 0);
  const residual = round2(0 - sumRounded);
  const moneyDeltas = rounded.slice();
  moneyDeltas[0] = round2(moneyDeltas[0] + residual);

  for (let i = 0; i < rows.length; i++) {
    const { error: upErr } = await db
      .from("league_scores")
      .update({ money_delta: moneyDeltas[i] })
      .eq("id", (rows[i] as { id: string }).id);
    if (upErr) {
      return new Response(
        JSON.stringify({ error: "Failed to update money_delta", details: upErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
  }

  return new Response(
    JSON.stringify({ league_round_id: leagueRoundId, computed: true, updated: rows.length }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
