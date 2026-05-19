// POST /send-invite — Super-admin only.
//
// First-invite path for a player whose row exists with no auth.users link
// (`players.user_id IS NULL`). Sibling of send-invite-again (re-invite path)
// and invite-player (combined create-player-and-invite path).
//
// Two-email onboarding model (2026-05-18). THIS function sends Email 1 only:
//
//   Email 1 (admin-triggered welcome) — this function.
//     admin.auth.admin.inviteUserByEmail(email) creates the auth.users row
//     AND sends the [auth.email.template.invite] "Invite user" email. That
//     template body is URL-free welcome text (no {{ .ConfirmationURL }}, no
//     clickable link) — Supabase still mints a confirmation token server-
//     side, but with no URL in the body, email-security scanners and iOS
//     Mail prefetchers have nothing to passively consume (residual,
//     recoverable phantom-confirmation risk accepted by Buzz). The invited
//     user is created UNCONFIRMED (email_confirmed_at NULL, invited_at set);
//     no code or token is surfaced to the recipient.
//
//   Email 2 (player-triggered code) — NOT this function.
//     The player visits windexgolf.com and clicks "Send Login Code", which
//     calls signInWithOtp → the code-only [auth.email.template.magic_link]
//     template → 6-digit code (standard 1-hour expiry, fine because they
//     just requested it). verifyOtp confirms the account on first sign-in,
//     setting email_confirmed_at / last_sign_in_at.
//
// This replaces the 2026-05-14 createUser + signInWithOtp two-step, which
// emailed the 6-digit code at INVITE time — so the 1-hour OTP expiry began
// ticking before the player ever looked, and they routinely hit an expired
// code. Decoupling welcome (Email 1) from code (Email 2, self-served on
// demand) removes that expiry pressure.
//
// inviteUserByEmail creates the auth.users row itself, so createUser is NOT
// called: GoTrue rejects inviteUserByEmail for an already-existing user
// (HTTP 422 — see Project_Context 2026-05-14 note), and the existing-auth-
// by-email precheck below already handles the "row exists" case. The
// migration-020 link_player_on_auth_signup trigger fires AFTER INSERT on
// auth.users regardless of which admin API performed the INSERT, so the
// pending players row is auto-linked by email exactly as before.
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
//      a. If found → manually link the player row, no email sent (avoids a
//         pointless re-email AND the inviteUserByEmail 422-on-existing-user
//         error). Response marks already_had_auth=true.
//      b. If not found → inviteUserByEmail: one atomic call that creates the
//         auth row, fires the link trigger, and sends the welcome email.
//   6. Re-read players.user_id to confirm the trigger linked, and return the
//      final row. linked=false + warning surfaces a rare email-casing /
//      trigger mismatch rather than silently succeeding.
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

  // ── Find existing auth user, else inviteUserByEmail ──────────────────────
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
    // Single atomic call: inviteUserByEmail creates the auth.users row
    // (firing the migration-020 link_player_on_auth_signup trigger, which
    // links the pending players row by email match) AND sends the URL-free
    // "Invite user" welcome email. No createUser — GoTrue rejects
    // inviteUserByEmail for an already-existing user (422), and the
    // existingAuthId branch above already handled the "row exists" case.
    // display_name is passed as user metadata for parity with the old
    // createUser; redirectTo is intentionally omitted so nothing can
    // re-introduce a confirmation URL into the email body.
    const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { display_name: playerRow.display_name },
    });
    if (inviteErr) {
      // Atomic failure: GoTrue did not create the row (or it pre-existed and
      // slipped past the precheck via a race). No partial state to clean up
      // — nothing was emailed; surface the error.
      return json({
        error: "inviteUserByEmail failed",
        details: inviteErr.message,
      }, 500);
    }
    invite_sent = true;
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

  if (invite_sent && !linked) {
    // Auth row was created + welcome email sent, but the AFTER INSERT
    // trigger did not link a players row — almost always an email
    // casing/whitespace mismatch between players.email and the invited
    // address. Surface it rather than report a clean success.
    warning =
      "Invite email sent, but the player row did not auto-link " +
      "(email casing/whitespace mismatch?). Verify the player's email " +
      "matches the invited address — the auth user exists either way.";
  }

  return json({
    ok: true,
    invite_sent,
    already_had_auth,
    linked,
    player: post ?? playerRow,
    ...(warning ? { warning } : {}),
  }, 200);
});
