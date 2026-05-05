// Reset all data tables. Auth required; uses SERVICE_ROLE_KEY to bypass RLS.

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

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return new Response(JSON.stringify({ error: "Missing Bearer token" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Verify the caller's JWT using the anon client
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

  // Create an admin client that bypasses RLS
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  // Tables in FK-safe deletion order (children before parents)
  const tables = [
    "league_scores",
    "league_rounds",
    "player_mapping_queue",
    "player_mappings",
    "group_members",
    "players",
    "seasons",
    "groups",
    "sections",
  ];

  const cleared: string[] = [];

  for (const table of tables) {
    const { error } = await adminClient.from(table).delete().not("id", "is", null);
    if (error) {
      return new Response(
        JSON.stringify({
          error: `Failed to clear table "${table}"`,
          details: error.message,
          cleared,
        }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    cleared.push(table);
  }

  return new Response(JSON.stringify({ ok: true, cleared }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
