// POST /send-invite-again — Super-admin only.
//
// Re-sends the OTP code email to a player who was already invited but has
// not yet confirmed their email / signed in. Sibling to send-invite (the
// first-invite path); this function targets the "invited but never
// followed through" state (player.user_id IS NOT NULL + auth.users row is
// unconfirmed).
//
// As of the 2026-05-14 cutover, this function no longer issues a magic-link
// invite via inviteUserByEmail. The auth.users row already exists (that is
// the precondition for this function), so all we do is call
// admin.auth.signInWithOtp to trigger a fresh OTP code email via the same
// [auth.email.template.magic_link] template the returning-user sign-in
// flow uses. No clickable URL ever lands in the user's inbox, so email-
// security scanners and iOS Mail prefetchers cannot consume the token
// before the human types it in.
//
// Auth: handler-side getUser(token) + am_i_super_admin() RPC. Deployed with
// verify_jwt = false (matches project pattern).
//
// Request body (JSON):
//   { "player_id": "..." }
//
// Pipeline:
//   1. Super-admin gate.
//   2. Load player. 404 if missing.
//   3. Require player.user_id IS NOT NULL — if NULL, the admin should use
//      Send Invite (the first-send path), not Send Again. 409.
//   4. Load auth.users row by user_id. 500 if missing (integrity violation —
//      a player is linked to a non-existent auth user).
//   5. Reject if already signed in (email_confirmed_at OR last_sign_in_at) —
//      409 "already signed in". Active users don't need re-invites.
//   6. Email must be non-empty / valid (400).
//   7. Call admin.auth.signInWithOtp({ email, options: { shouldCreateUser:
//      false, emailRedirectTo: undefined } }). shouldCreateUser:false because
//      the user already exists; emailRedirectTo:undefined so no
//      ConfirmationURL is embedded in the email body.
//
// Responses:
//   200 { ok: true, sent_at, player }
//   400 { error: "..." }       — missing player_id / no email / invalid email
//   401 { error: "Unauthorized" }
//   403 { error: "Super admin only" }
//   404 { error: "Player not found" }
//   409 { error: "...", reason: "not_yet_invited" | "already_signed_in" }
//   500 { error: "..." }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

  // Super-admin gate.
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

  // Service-role client for the rest. Bypasses RLS for auth.users reads.
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

  // ── Inverted preconditions vs send-invite ────────────────────────────────
  if (!playerRow.user_id) {
    return json({
      error: "Player has never been invited. Use Send Invite, not Send Again.",
      reason: "not_yet_invited",
    }, 409);
  }

  const email = playerRow.email?.trim().toLowerCase() ?? "";
  if (!email) {
    return json({ error: "Player has no email" }, 400);
  }
  if (!EMAIL_RE.test(email)) {
    return json({ error: `Player email '${playerRow.email}' is invalid` }, 400);
  }

  // ── Load auth.users row ──────────────────────────────────────────────────
  const { data: getUserResult, error: getUserErr } = await admin.auth.admin.getUserById(playerRow.user_id);
  if (getUserErr || !getUserResult?.user) {
    return json({
      error: "Linked auth user not found — integrity violation",
      details: getUserErr?.message ?? "getUserById returned no user",
      user_id: playerRow.user_id,
    }, 500);
  }
  const authUser = getUserResult.user;

  // ── Reject if already signed in ──────────────────────────────────────────
  if (authUser.email_confirmed_at || authUser.last_sign_in_at) {
    return json({
      error: "Player has already signed in — no re-invite needed",
      reason: "already_signed_in",
      email_confirmed_at: authUser.email_confirmed_at ?? null,
      last_sign_in_at: authUser.last_sign_in_at ?? null,
    }, 409);
  }

  // ── Re-send OTP ──────────────────────────────────────────────────────────
  // signInWithOtp triggers a fresh OTP code email via the same template the
  // returning-user sign-in flow uses ([auth.email.template.magic_link],
  // overridden to a code-only body). No ConfirmationURL is embedded so
  // email-security scanners cannot consume the token via a GET prefetch.
  const sentAt = new Date().toISOString();
  const { error: otpErr } = await admin.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false, emailRedirectTo: undefined },
  });
  if (otpErr) {
    return json({ error: "signInWithOtp failed", details: otpErr.message }, 500);
  }

  return json({
    ok: true,
    sent_at: sentAt,
    player: playerRow,
  }, 200);
});
