// GET /players — list canonical players for dropdowns, round entry picker, future mapping.
// Optional ?group_id= to restrict to active members of that group. RLS applies.

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

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return new Response(JSON.stringify({ error: "Missing Bearer token" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const groupId = url.searchParams.get("group_id");

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

  if (groupId) {
    const { data: memberRows, error: memErr } = await supabase
      .from("group_members")
      .select("player_id")
      .eq("group_id", groupId)
      .eq("is_active", 1);
    if (memErr) {
      return new Response(
        JSON.stringify({ error: "Failed to fetch group members", details: memErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const playerIds = [...new Set((memberRows ?? []).map((r: { player_id: string }) => r.player_id))];
    if (playerIds.length === 0) {
      return new Response(JSON.stringify({ players: [] }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: playerRows, error: plErr } = await supabase
      .from("players")
      .select("id, display_name, is_active")
      .eq("user_id", user.user.id)
      .in("id", playerIds)
      .order("display_name");
    if (plErr) {
      return new Response(
        JSON.stringify({ error: "Failed to fetch players", details: plErr.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    const players = (playerRows ?? []).map((p: { id: string; display_name: string; is_active: number }) => ({
      id: p.id,
      display_name: p.display_name,
      is_active: p.is_active,
    }));
    return new Response(JSON.stringify({ players }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data, error } = await supabase
    .from("players")
    .select("id, display_name, is_active")
    .eq("user_id", user.user.id)
    .order("display_name");

  if (error) {
    return new Response(
      JSON.stringify({ error: "Failed to fetch players", details: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const players = (data ?? []).map((p: { id: string; display_name: string; is_active: number }) => ({
    id: p.id,
    display_name: p.display_name,
    is_active: p.is_active,
  }));

  return new Response(JSON.stringify({ players }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
