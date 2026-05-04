// Return season standings for a given season_id. Auth required; RLS on underlying tables filters rows.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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
  const seasonId = url.searchParams.get("season_id");
  if (!seasonId) {
    return new Response(JSON.stringify({ error: "season_id required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const groupId = url.searchParams.get("group_id");

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

  let query = supabase
    .from("season_standings")
    .select("season_id, group_id, player_id, rounds_played, wins, losses, ties, total_points")
    .eq("season_id", seasonId)
    .order("total_points", { ascending: false });

  if (groupId) {
    query = query.eq("group_id", groupId);
  }

  const { data: rows, error } = await query;

  if (error) {
    return new Response(
      JSON.stringify({ error: "Failed to fetch standings", details: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const standings = (rows ?? []) as { season_id: string; group_id: string; player_id: string; rounds_played: number; wins: number; losses: number; ties: number; total_points: number }[];
  if (standings.length === 0) {
    return new Response(JSON.stringify({ standings: [] }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const playerIds = [...new Set(standings.map((r) => r.player_id))];
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

  const standingsWithNames = standings.map((r) => ({
    ...r,
    player_name: playerNames[r.player_id] ?? null,
  }));

  return new Response(JSON.stringify({ standings: standingsWithNames }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
