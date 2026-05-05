// Round-scoped payment request generation. Reads money_delta for a round and returns
// the minimal set of payer -> payee requests. Does not persist; Windex does not track payment completion.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Body {
  league_round_id?: string | null;
}

interface RequestRow {
  from_player_id: string;
  to_player_id: string;
  amount_cents: number;
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
    .select("id, user_id")
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

  const { data: scores, error: scoresErr } = await db
    .from("league_scores")
    .select("player_id, money_delta")
    .eq("league_round_id", leagueRoundId);

  if (scoresErr) {
    return new Response(
      JSON.stringify({ error: "Failed to load scores", details: scoresErr.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const rows = scores ?? [];
  const hasNull = rows.some((r) => r.money_delta == null);
  if (hasNull) {
    return new Response(
      JSON.stringify({
        error: "money_delta has not been computed for this round",
        code: "money_delta_not_computed",
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const withCents = rows.map((r) => ({
    player_id: r.player_id as string,
    amount_cents: Math.round((r.money_delta as number) * 100),
  }));

  const sumCents = withCents.reduce((s, r) => s + r.amount_cents, 0);
  if (sumCents !== 0) {
    return new Response(
      JSON.stringify({
        error: "Round is not zero-sum in cents; cannot generate payment requests",
        code: "round_not_zero_sum",
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (rows.length <= 1) {
    return new Response(
      JSON.stringify({ league_round_id: leagueRoundId, requests: [] }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const payers = withCents
    .filter((r) => r.amount_cents < 0)
    .map((r) => ({ player_id: r.player_id, amount_cents: -r.amount_cents }))
    .sort((a, b) => (b.amount_cents !== a.amount_cents ? b.amount_cents - a.amount_cents : a.player_id.localeCompare(b.player_id)));
  const payees = withCents
    .filter((r) => r.amount_cents > 0)
    .map((r) => ({ player_id: r.player_id, amount_cents: r.amount_cents }))
    .sort((a, b) => (b.amount_cents !== a.amount_cents ? b.amount_cents - a.amount_cents : a.player_id.localeCompare(b.player_id)));

  const requests: RequestRow[] = [];
  let i = 0;
  let j = 0;
  while (i < payers.length && j < payees.length) {
    const transfer = Math.min(payers[i].amount_cents, payees[j].amount_cents);
    if (transfer > 0) {
      requests.push({
        from_player_id: payers[i].player_id,
        to_player_id: payees[j].player_id,
        amount_cents: transfer,
      });
    }
    payers[i].amount_cents -= transfer;
    payees[j].amount_cents -= transfer;
    if (payers[i].amount_cents === 0) i++;
    if (payees[j].amount_cents === 0) j++;
  }

  return new Response(
    JSON.stringify({ league_round_id: leagueRoundId, requests }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
