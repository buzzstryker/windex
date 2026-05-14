// POST /send-invite — Super-admin only.
//
// First-invite path for a player whose row exists with no auth.users link
// (`players.user_id IS NULL`). Sibling of send-invite-again (re-invite path)
// and invite-player (combined create-player-and-invite path).
//
// As of the 2026-05-14 cutover, this function no longer issues a magic-link
// invite via inviteUserByEmail. Instead it does a two-step:
//
//   1. admin.auth.admin.createUser({ email, email_confirm: false,
//                                    user_metadata: { display_name } })
//      Creates the auth.users row without sending any email. The
//      link_player_on_auth_signup trigger (migration 020) fires AFTER INSERT
//      on auth.users and links the matching pending players row.
//
//   2. admin.auth.signInWithOtp({ email, options: { shouldCreateUser: false,
//                                                   emailRedirectTo: undefined } })
//      Sends a code-only OTP email via the [auth.email.template.magic_link]
//      template — identical to the email a returning user gets when signing
//      in. No clickable URL, so email-security scanners and iOS Mail
//      prefetchers cannot consume the token. The user must type the code
//      into the app to authenticate, which sets email_confirmed_at and
//      last_sign_in_at exactly when the human actually signs in.
//
// Auth: handler-side getUser(token) + am_i_super_admin() RPC. Deployed with
// verify_jwt = false (matches every other function in this project — see
// config.toml).
//
// Request body (JSON):
//   { "player_id": "..." }
//
// Pipeline:
//   1. Super-admin gate.
//   2. Load player by id. 404 if not found.
//   3. Reject if player.user_id IS NOT NULL → 409 "already linked".
//   4. Reject if email is null/empty/invalid → 400.
//   5. Check for an existing auth.users row by email.
//      a. If found → manually link the player row, no email sent. Response
//         marks already_had_auth=true.
//      b. If not found → createUser (trigger auto-links the player) then
//         signInWithOtp (sends the OTP code email).
//   6. Re-read players.user_id to confirm the trigger fired and return the
//      final row. invite_sent=false / linked=true with a warning is the
//      degenerate state if createUser succeeded but the OTP send failed —
//      admin can recover by clicking Send Again.
//
// Responses:
//   200 { ok: true, invite_sent, already_had_auth, linked, player, warning? }
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

  // ── Find existing auth user, or createUser + OTP send ────────────────────
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
  let warning: string | null = null;

  if (existingAuthId) {
    // Auth user exists but the player isn't linked. Manually link rather
    // than re-sending — avoids a pointless email blast at someone who
    // already has an account. Matches the prior magic-link flow's behavior.
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
    // Step 1: create the auth.users row without sending an email. The
    // link_player_on_auth_signup trigger fires AFTER INSERT and links the
    // matching pending players row by email.
    const { error: createErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: false,
      user_metadata: { display_name: playerRow.display_name },
    });
    if (createErr) {
      return json({
        error: "createUser failed",
        details: createErr.message,
      }, 500);
    }

    // Step 2: trigger the OTP code email. Uses the same template the
    // returning-user sign-in flow uses ([auth.email.template.magic_link],
    // overridden to a code-only body). shouldCreateUser:false because we
    // just created the user above; emailRedirectTo:undefined so no
    // ConfirmationURL is embedded in the email body.
    const { error: otpErr } = await admin.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false, emailRedirectTo: undefined },
    });
    if (otpErr) {
      // The auth.users row exists and the trigger has linked the player —
      // only the email send failed (rate limit, SMTP outage, etc.). Don't
      // delete the auth user; the admin can use Send Again to retry the
      // email. Surface as 200 with invite_sent=false + warning.
      warning = `Auth user created but OTP email failed: ${otpErr.message}. Use Send Again to retry.`;
    } else {
      invite_sent = true;
    }
  }

  // ── Confirm link landed ──────────────────────────────────────────────────
  // The trigger fires AFTER INSERT on auth.users (or for the already_had_auth
  // branch, we just did the UPDATE above). Re-read to surface trigger
  // failures (email casing/whitespace mismatch) rather than silently succeed.
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
    ...(warning ? { warning } : {}),
  }, 200);
});
