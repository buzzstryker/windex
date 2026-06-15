// POST /admin-update-user-email — Super-admin only.
//
// Changes a TARGET user's login identity (auth.users.email) and mirrors the
// new address onto every players row that shares that auth user_id. Email is
// the OTP login identity in this app, so this function changes what the target
// logs in with — the authorization gate below is the ONLY thing protecting
// every user's account, because the service-role client used for the writes
// bypasses RLS entirely.
//
// Why this exists: windex-admin's players edit modal can PATCH `players.email`
// directly (RLS players_update allows super admins), but that only touches the
// `players` mirror — it does NOT change auth.users.email, so the target would
// still log in with their OLD address. This function performs the auth-side
// change (with email_confirm:true so it takes effect immediately, no
// confirmation round-trip) and then re-syncs the players mirror.
//
// Auth: handler-side getUser(token) + am_i_super_admin() RPC (the migration-014
// SECURITY DEFINER helper resolves is_super_admin=1 from the CALLER's player
// record server-side). Deployed with verify_jwt = false (matches every other
// function in this project — see config.toml).
//
// Request body (JSON):
//   { "player_id": "...", "email": "new@address.com" }
//
// Pipeline:
//   1. AUTHORIZATION GATE (first real work): getUser(token) → am_i_super_admin().
//      Anything other than is_super_admin === true → 403, no writes.
//   2. Validate body: player_id present, email present + well-formed.
//   3. Resolve the TARGET auth user_id SERVER-SIDE from player_id via the
//      service-role client (never trust a user_id from the client). 404 if the
//      player doesn't exist; 400 if the player has no linked auth account.
//   4. Guard against stealing another account's address: if some OTHER auth
//      user already owns the new email → 409.
//   5. auth.admin.updateUserById(targetUserId, { email, email_confirm: true }).
//   6. Sync players.email across ALL rows sharing that target user_id (a person
//      can have multiple player records, e.g. "Buzz" / "Buzz YC Weds").
//   7. Return a clear result; surface real GoTrue/DB errors to the admin UI.
//
// Responses:
//   200 { ok: true, user_id, email, players_synced }
//   400 { error: "..." }   — bad body, invalid email, player has no auth account
//   401 { error: "Unauthorized" }
//   403 { error: "Super admin only" }
//   404 { error: "Player not found" }
//   409 { error: "...", conflicting_user_id }  — email already in use elsewhere
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

/** Find the auth user (if any) that currently owns `email`. Paginated; mirrors send-invite. */
async function findAuthUserByEmail(admin: SupabaseClient, email: string): Promise<string | null> {
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

  // ── 1. AUTHORIZATION GATE (non-negotiable; runs before any write) ─────────
  // Caller-context client: anon key + the CALLER's JWT, so am_i_super_admin()
  // evaluates against the caller's identity (RLS-respecting). The service-role
  // client below bypasses RLS, so this check is the sole protection.
  const callerClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userInfo, error: userError } = await callerClient.auth.getUser(token);
  if (userError || !userInfo?.user?.id) {
    return json({ error: "Unauthorized", msg: userError?.message ?? "Invalid JWT" }, 401);
  }

  const { data: isSuper, error: gateError } = await callerClient.rpc("am_i_super_admin");
  if (gateError) return json({ error: "Permission check failed", details: gateError.message }, 500);
  if (isSuper !== true) return json({ error: "Super admin only" }, 403);

  // ── 2. Parse + validate body ──────────────────────────────────────────────
  let body: { player_id?: unknown; email?: unknown };
  try {
    body = await req.json() as { player_id?: unknown; email?: unknown };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (typeof body.player_id !== "string" || body.player_id.trim() === "") {
    return json({ error: "player_id is required" }, 400);
  }
  if (typeof body.email !== "string" || body.email.trim() === "") {
    return json({ error: "email is required" }, 400);
  }
  const playerId = body.player_id.trim();
  // GoTrue stores emails lowercased; normalize so the players mirror and the
  // login identity stay byte-identical and case-insensitive lookups line up.
  const newEmail = body.email.trim().toLowerCase();
  if (!EMAIL_RE.test(newEmail)) {
    return json({ error: `'${body.email}' is not a valid email address` }, 400);
  }

  // Service-role client for the privileged reads/writes (bypasses RLS).
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── 3. Resolve TARGET auth user_id server-side from player_id ─────────────
  const { data: player, error: pErr } = await admin
    .from("players")
    .select("id, display_name, email, user_id")
    .eq("id", playerId)
    .maybeSingle();
  if (pErr) return json({ error: "Player lookup failed", details: pErr.message }, 500);
  if (!player) return json({ error: "Player not found" }, 404);
  const targetUserId = (player as PlayerRow).user_id;
  if (!targetUserId) {
    return json({
      error: "Player has no linked auth account — there is no login email to change. " +
        "Invite the player first (send-invite), or edit players.email directly.",
    }, 400);
  }

  // ── 4. Don't let an admin reassign an address another account already owns ─
  let ownerOfNewEmail: string | null = null;
  try {
    ownerOfNewEmail = await findAuthUserByEmail(admin, newEmail);
  } catch (err) {
    return json({
      error: "Auth user lookup failed",
      details: err instanceof Error ? err.message : String(err),
    }, 500);
  }
  if (ownerOfNewEmail && ownerOfNewEmail !== targetUserId) {
    return json({
      error: `That email is already in use by another account`,
      conflicting_user_id: ownerOfNewEmail,
    }, 409);
  }

  // ── 5. Change the auth login identity (immediate; no confirm round-trip) ──
  const { error: updErr } = await admin.auth.admin.updateUserById(targetUserId, {
    email: newEmail,
    email_confirm: true,
  });
  if (updErr) {
    return json({ error: "Failed to update auth email", details: updErr.message }, 500);
  }

  // ── 6. Sync the players mirror across EVERY row for this auth user ─────────
  const { data: synced, error: syncErr } = await admin
    .from("players")
    .update({ email: newEmail, updated_at: new Date().toISOString() })
    .eq("user_id", targetUserId)
    .select("id");
  if (syncErr) {
    // The auth change already landed; report the partial state honestly rather
    // than claim success, so the admin can re-run / reconcile the mirror.
    return json({
      error: "Auth email updated, but syncing players.email failed",
      details: syncErr.message,
      user_id: targetUserId,
      email: newEmail,
    }, 500);
  }

  return json({
    ok: true,
    user_id: targetUserId,
    email: newEmail,
    players_synced: synced?.length ?? 0,
  }, 200);
});
