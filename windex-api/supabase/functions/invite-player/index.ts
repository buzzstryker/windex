// POST /invite-player — Super-admin only.
//
// Creates a players row, optionally invites the user via Supabase Auth
// (admin.inviteUserByEmail), and assigns them to one or more groups with a
// per-group role. The new auth user (if invited) is auto-linked to the
// players row by migration 020's link_player_on_auth_signup() trigger on
// first sign-in. If the email already has an auth user, the invite step is
// skipped — the trigger or migration's backfill has already linked them.
//
// Auth: handler-side getUser(token) + am_i_super_admin() RPC. Deployed with
// verify_jwt = false (matches every other function in this project — see
// config.toml; platform-level verification was disabled deliberately
// because it failed against linked projects).
//
// Request body:
//   {
//     "display_name": "Jane Doe",
//     "email": "jane@example.com",
//     "send_invite": true,
//     "group_assignments": [
//       { "group_id": "abc123", "role": "member" },
//       { "group_id": "def456", "role": "admin" }
//     ]
//   }
//
// Responses:
//   200 { player, groups_assigned, invite_sent, already_had_auth }
//   400 { error: "...validation message..." }
//   401 { error: "Unauthorized" }
//   403 { error: "Super admin only" }
//   409 { error: "Player with this email already exists", existing_player_id }
//   500 { error: "...details..." } — partial-failure rollback already attempted

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

// 20-character player id, [A-Za-z0-9]. Matches the shape of historical Glide
// row ids already in the table (e.g. rkzvcxQz6y4cbEG9Ja88) so existing
// downstream code that assumes that shape keeps working.
const PLAYER_ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function newPlayerId(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += PLAYER_ID_ALPHABET[b % PLAYER_ID_ALPHABET.length];
  return out;
}

// Match the shape used by sync-glide-members.mjs and the seed bundle so the
// admin UI doesn't accidentally create duplicate-by-shape rows.
function groupMemberId(groupId: string, playerId: string): string {
  const safe = (x: string) => x.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  return `gm_${safe(groupId)}_${safe(playerId)}`;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type GroupAssignment = { group_id: string; role: "admin" | "member" };

type InvitePlayerRequest = {
  display_name?: unknown;
  email?: unknown;
  send_invite?: unknown;
  group_assignments?: unknown;
};

function validate(body: InvitePlayerRequest): { ok: true; data: {
  display_name: string;
  email: string;
  send_invite: boolean;
  group_assignments: GroupAssignment[];
} } | { ok: false; error: string } {
  if (typeof body.display_name !== "string" || body.display_name.trim() === "") {
    return { ok: false, error: "display_name is required" };
  }
  if (typeof body.email !== "string" || body.email.trim() === "") {
    return { ok: false, error: "email is required" };
  }
  const display_name = body.display_name.trim();
  const email = body.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return { ok: false, error: "email format invalid" };
  }
  const send_invite = body.send_invite !== false; // default true
  if (!Array.isArray(body.group_assignments)) {
    return { ok: false, error: "group_assignments must be an array" };
  }
  const group_assignments: GroupAssignment[] = [];
  for (const raw of body.group_assignments) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "invalid group_assignment entry" };
    const a = raw as { group_id?: unknown; role?: unknown };
    if (typeof a.group_id !== "string" || a.group_id.trim() === "") {
      return { ok: false, error: "group_assignments[].group_id is required" };
    }
    if (a.role !== "admin" && a.role !== "member") {
      return { ok: false, error: "group_assignments[].role must be 'admin' or 'member'" };
    }
    group_assignments.push({ group_id: a.group_id, role: a.role });
  }
  return { ok: true, data: { display_name, email, send_invite, group_assignments } };
}

async function findExistingAuthUser(admin: SupabaseClient, email: string): Promise<string | null> {
  // listUsers paginates; for a small project this is fine. If user count grows
  // we can switch to a direct query against auth.users via service role.
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

  // Parse + validate body.
  let body: InvitePlayerRequest;
  try {
    body = await req.json() as InvitePlayerRequest;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const v = validate(body);
  if (!v.ok) return json({ error: v.error }, 400);
  const { display_name, email, send_invite, group_assignments } = v.data;

  // Service-role client for the writes — bypasses RLS so we can also write
  // user_id later via the trigger path, and so partial-failure rollback can
  // delete the players row regardless of caller membership.
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Duplicate-email check ────────────────────────────────────────────────
  const { data: dupRows, error: dupErr } = await admin
    .from("players")
    .select("id")
    .ilike("email", email)
    .limit(1);
  if (dupErr) return json({ error: "Duplicate-email check failed", details: dupErr.message }, 500);
  if (dupRows && dupRows.length > 0) {
    return json({
      error: "Player with this email already exists",
      existing_player_id: dupRows[0].id,
    }, 409);
  }

  // ── Validate referenced groups exist ─────────────────────────────────────
  if (group_assignments.length > 0) {
    const ids = [...new Set(group_assignments.map((a) => a.group_id))];
    const { data: gRows, error: gErr } = await admin.from("groups").select("id").in("id", ids);
    if (gErr) return json({ error: "Group lookup failed", details: gErr.message }, 500);
    const found = new Set((gRows ?? []).map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      return json({ error: `Unknown group_id: ${missing.join(", ")}` }, 400);
    }
  }

  // ── Insert players row ──────────────────────────────────────────────────
  const playerId = newPlayerId();
  const nowIso = new Date().toISOString();
  const { data: playerInsert, error: pErr } = await admin
    .from("players")
    .insert({
      id: playerId,
      user_id: null,
      display_name,
      email,
      is_active: 1,
      is_super_admin: 0,
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select("id, display_name, email, user_id, is_active")
    .single();
  if (pErr || !playerInsert) {
    return json({ error: "Failed to create player", details: pErr?.message ?? "no row returned" }, 500);
  }

  // ── Insert group_members rows ───────────────────────────────────────────
  if (group_assignments.length > 0) {
    const rows = group_assignments.map((a) => ({
      id: groupMemberId(a.group_id, playerId),
      group_id: a.group_id,
      player_id: playerId,
      role: a.role,
      is_active: 1,
      joined_at: nowIso,
    }));
    const { error: gmErr } = await admin.from("group_members").insert(rows);
    if (gmErr) {
      // Rollback the orphan players row so the admin can retry cleanly.
      await admin.from("players").delete().eq("id", playerId);
      return json({ error: "Failed to assign groups (player rollback applied)", details: gmErr.message }, 500);
    }
  }

  // ── Optional invite ─────────────────────────────────────────────────────
  let invite_sent = false;
  let already_had_auth = false;

  if (send_invite) {
    let existingUserId: string | null = null;
    try {
      existingUserId = await findExistingAuthUser(admin, email);
    } catch (err) {
      // Treat lookup failure as "unknown" — fall through to the invite call,
      // which will surface its own duplicate-user error if needed.
      console.warn("listUsers lookup failed, falling through to invite:", err);
    }

    if (existingUserId) {
      already_had_auth = true;
      // Best-effort: link now if not already linked. The migration's trigger
      // would have handled the AFTER-INSERT case, but a pre-existing auth
      // user predates this trigger. If user_id is still null, link manually.
      const { error: linkErr } = await admin
        .from("players")
        .update({ user_id: existingUserId, updated_at: new Date().toISOString() })
        .eq("id", playerId)
        .is("user_id", null);
      if (linkErr) {
        console.warn("Manual link of pre-existing auth user failed:", linkErr.message);
      }
    } else {
      const { error: invErr } = await admin.auth.admin.inviteUserByEmail(email, {
        data: { display_name },
        redirectTo: "https://windexgolf.com",
      });
      if (invErr) {
        // Don't roll back the player; admin can re-trigger an invite from
        // the Players page. Surface the error so the UI can show it.
        return json({
          error: "Player created, but invite send failed",
          details: invErr.message,
          player: playerInsert,
          groups_assigned: group_assignments.length,
          invite_sent: false,
          already_had_auth: false,
        }, 500);
      }
      invite_sent = true;
    }
  }

  return json({
    player: playerInsert,
    groups_assigned: group_assignments.length,
    invite_sent,
    already_had_auth,
  }, 200);
});
