// POST /send-invite — Super-admin only.
//
// Triggers a Supabase OTP invite for an existing players row that has no
// auth.users link yet (`players.user_id IS NULL`). Companion to
// invite-player: invite-player creates a player AND optionally invites;
// send-invite covers the case where a player was created without the
// invite step and the admin wants to send one later.
//
// Auth: handler-side getUser(token) + am_i_super_admin() RPC. Deployed
// with verify_jwt = false (matches every other function in this project —
// see config.toml; platform-level verification was disabled deliberately
// because it failed against linked projects).
//
// Request body (JSON):
//   { "player_id": "..." }
//
// Pipeline:
//   1. Super-admin gate.
//   2. Load player by id. 404 if not found.
//   3. Reject if player.user_id IS NOT NULL → 409 "already linked" (also
//      catches the race where another admin linked between page load and
//      click).
//   4. Reject if email is null/empty/invalid → 400.
//   5. Check for an existing auth.users row by email (paginated listUsers
//      — matches invite-player's findExistingAuthUser pattern).
//      a. If found → manually link the player row (mirrors invite-player's
//         "already_had_auth" branch). Return success without sending email.
//      b. If not found → admin.inviteUserByEmail. The trigger from
//         migration 020 fires AFTER INSERT on auth.users and links the
//         player row by email match. Re-read players.user_id to confirm.
//   6. Return { invite_sent, already_had_auth, linked, player }. UI
//      surfaces "linked: false" as "invite sent but link pending — refresh"
//      so trigger failures (email casing/whitespace mismatch) don't get
//      silently swallowed.
//
// Responses:
//   200 { ok: true, invite_sent, already_had_auth, linked, player }
//   400 { error: "..." }       — missing/invalid email, malformed body
//   401 { error: "Unauthorized" }
//   403 { error: "Super admin only" }
//   404 { error: "Player not found" }
//   409 { error: "Player already linked to an auth user", user_id }
//   500 { error: "..." }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type PlayerRow = {
  id: string;
  display_name: string;
  email: string | null;
  user_id: string | null;
};

async function findExistingAuthUser(admin: SupabaseClient, email: string): Promise<string | null> {
  // Mirrors invite-player. listUsers paginates; safe for our scale.
  let page = 1;
  const perPage = 200;
  while (true) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Failed to list auth users: ${error.message}`);
    const hit = data?.users?.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (!data?.users || data.users.length < perPage) return null;
    page++;
    if (page > 50) return null; // safety bound (10k users)
  }
}

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

  // Caller-context client (anon key + caller's JWT). RLS-respecting.
  const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userInfo, error: userError } = await callerClient.auth.getUser(token);
  if (userError || !userInfo?.user?.id) {
    return json({ error: "Unauthorized", msg: userError?.message ?? "Invalid JWT" }, 401);
  }

  // Super-admin gate via SQL helper from migration 014.
  const { data: isSuper, error: gateError } = await callerClient.rpc("am_i_super_admin");
  if (gateError) return json({ error: "Permission check failed", details: gateError.message }, 500);
  if (isSuper !== true) return json({ error: "Super admin only" }, 403);

  // ── Parse body ───────────────────────────────────────────────────────────
  let body: { player_id?: unknown };
  try {
    body = await req.json() as { player_id?: unknown };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body.player_id !== "string" || body.player_id.trim() === "") {
    return json({ error: "player_id is required" }, 400);
  }
  const playerId = body.player_id.trim();

  // Service-role client for the writes (bypasses RLS).
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Load player ──────────────────────────────────────────────────────────
  const { data: player, error: pErr } = await admin
    .from("players")
    .select("id, display_name, email, user_id")
    .eq("id", playerId)
    .maybeSingle();
  if (pErr) return json({ error: "Player lookup failed", details: pErr.message }, 500);
  if (!player) return json({ error: "Player not found" }, 404);
  const playerRow = player as PlayerRow;

  // ── Pre-flight checks ────────────────────────────────────────────────────
  if (playerRow.user_id) {
    return json({
      error: "Player is already linked to an auth user",
      user_id: playerRow.user_id,
    }, 409);
  }
  const email = playerRow.email?.trim().toLowerCase() ?? "";
  if (!email) {
    return json({ error: "Player has no email — add one before inviting" }, 400);
  }
  if (!EMAIL_RE.test(email)) {
    return json({ error: `Player email '${playerRow.email}' is invalid` }, 400);
  }

  // ── Find existing auth user, or invite ───────────────────────────────────
  let existingAuthId: string | null = null;
  try {
    existingAuthId = await findExistingAuthUser(admin, email);
  } catch (err) {
    return json({
      error: "Auth user lookup failed",
      details: err instanceof Error ? err.message : String(err),
    }, 500);
  }

  let invite_sent = false;
  let already_had_auth = false;

  if (existingAuthId) {
    // Auth user exists but the player isn't linked. Manually link rather
    // than re-inviting — matches invite-player's behavior, avoids a
    // pointless email blast at someone who already has an account.
    already_had_auth = true;
    const { error: linkErr } = await admin
      .from("players")
      .update({ user_id: existingAuthId, updated_at: new Date().toISOString() })
      .eq("id", playerId)
      .is("user_id", null); // race-safe: only link if still unlinked
    if (linkErr) {
      return json({
        error: "Failed to link existing auth user",
        details: linkErr.message,
      }, 500);
    }
  } else {
    const { error: invErr } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { display_name: playerRow.display_name },
      redirectTo: "https://windexgolf.com",
    });
    if (invErr) {
      return json({ error: "Invite send failed", details: invErr.message }, 500);
    }
    invite_sent = true;
  }

  // ── Confirm link landed ──────────────────────────────────────────────────
  // The link_player_on_auth_signup trigger from migration 020 fires AFTER
  // INSERT on auth.users — which for inviteUserByEmail is invite time, not
  // first sign-in. By the time the API call returns, the trigger should
  // have run. Re-read to surface trigger failures (email casing/whitespace
  // mismatch) rather than silently succeed.
  const { data: post, error: postErr } = await admin
    .from("players")
    .select("id, display_name, email, user_id")
    .eq("id", playerId)
    .maybeSingle();
  if (postErr) {
    return json({ error: "Post-invite re-read failed", details: postErr.message }, 500);
  }
  const linked = !!(post && (post as PlayerRow).user_id);

  return json({
    ok: true,
    invite_sent,
    already_had_auth,
    linked,
    player: post ?? playerRow,
  }, 200);
});
