// POST /invite-player — Super-admin only.
//
// Creates a players row, optionally invites the user via the OTP code flow,
// and assigns them to one or more groups with a per-group role. The new
// auth user (if invited) is auto-linked to the players row by migration
// 020's link_player_on_auth_signup() trigger on auth.users INSERT. If the
// email already has an auth user, the invite step is skipped and the
// existing auth user is linked manually.
//
// As of the 2026-05-14 cutover, this function no longer uses
// admin.auth.admin.inviteUserByEmail (which embeds a clickable magic-link
// URL in the email and is vulnerable to email-security-scanner and iOS
// Mail prefetch consumption). The invite step now does:
//
//   1. admin.auth.admin.createUser({ email, email_confirm: false,
//                                    user_metadata: { display_name } })
//      Creates auth.users without sending an email. The
//      link_player_on_auth_signup trigger fires AFTER INSERT and links the
//      players row that this function just inserted (by case-insensitive
//      email match).
//
//   2. admin.auth.signInWithOtp({ email, options: { shouldCreateUser: false,
//                                                   emailRedirectTo: undefined } })
//      Sends the OTP code email via the [auth.email.template.magic_link]
//      template — identical body to the returning-user sign-in email. No
//      clickable URL in the email.
//
// Auth: handler-side getUser(token) + am_i_super_admin() RPC. Deployed with
// verify_jwt = false (matches every other function in this project — see
// config.toml).
//
// Request body:
//   {
//     "full_name": "Jane Doe",       // optional; required when display_name omitted
//     "display_name": "JDoe",        // optional; auto-generated from full_name if blank
//     "email": "jane@example.com",
//     "send_invite": true,
//     "group_assignments": [
//       { "group_id": "abc123", "role": "member" },
//       { "group_id": "def456", "role": "admin" }
//     ]
//   }
// At least one of full_name / display_name is required. When display_name is
// blank it is generated server-side via the canonical ladder (see
// generateDisplayName) — the single source of truth for auto-nicknames.
//
// Responses:
//   200 { player, groups_assigned, invite_sent, already_had_auth, warning? }
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
  full_name?: unknown;
  email?: unknown;
  send_invite?: unknown;
  group_assignments?: unknown;
};

// ── Canonical display_name ladder ─────────────────────────────────────────
// Single source of truth for auto-generated nicknames (the original lived only
// in the deleted Glide import script). Given a full name:
//   base = first-initial + first 4 chars of the LAST-word surname
//          (Scott Prince -> SPrin). Middle names/initials ignored. Non-alpha
//          (periods, apostrophes, hyphens) stripped before slicing.
//   collision -> extend the surname one char at a time (SPrinc, SPrince, ...)
//                until unique or the surname is exhausted;
//   still colliding -> append 2, 3, ... to the full-surname form (SPrince2).
//   single-word name (no surname) -> the first name as-is, number ladder on it.
// Interior caps preserved (McDonald -> McDo). Dedupe is case-insensitive vs the
// supplied `taken` set (all existing players.display_name, lowercased).
function cleanAlpha(s: string): string {
  return (s ?? "").replace(/[^A-Za-z]/g, "");
}
function upperFirst(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
function generateDisplayName(fullName: string, taken: Set<string>): string {
  const tokens = fullName.trim().split(/\s+/).filter(Boolean);
  const free = (c: string) => !taken.has(c.toLowerCase());

  // Single-word name: no surname to build from — use the first name as-is.
  if (tokens.length <= 1) {
    const base = upperFirst(cleanAlpha(tokens[0] ?? "")) || "Player";
    if (free(base)) return base;
    let n = 2;
    while (!free(base + n)) n++;
    return base + n;
  }

  const firstInitial = (cleanAlpha(tokens[0])[0] ?? "").toUpperCase();
  const surname = cleanAlpha(tokens[tokens.length - 1]);
  // Extend from first-4 up to the full surname.
  for (let len = Math.min(4, surname.length); len <= surname.length; len++) {
    const cand = firstInitial + upperFirst(surname.slice(0, len));
    if (free(cand)) return cand;
  }
  // Full surname exhausted and still colliding — append a number.
  const full = firstInitial + upperFirst(surname);
  let n = 2;
  while (!free(full + n)) n++;
  return full + n;
}

function validate(body: InvitePlayerRequest): { ok: true; data: {
  display_name: string | null;
  full_name: string | null;
  email: string;
  send_invite: boolean;
  group_assignments: GroupAssignment[];
} } | { ok: false; error: string } {
  // display_name is OPTIONAL now: if omitted/blank the handler generates it
  // from full_name via the canonical ladder. Either display_name or full_name
  // must be present (the PWA new-player flow sends full_name only; the admin
  // AddPlayerModal still sends a typed display_name).
  const display_name =
    typeof body.display_name === "string" && body.display_name.trim() !== ""
      ? body.display_name.trim()
      : null;
  const full_name =
    typeof body.full_name === "string" && body.full_name.trim() !== ""
      ? body.full_name.trim()
      : null;
  if (!display_name && !full_name) {
    return { ok: false, error: "display_name or full_name is required" };
  }
  if (typeof body.email !== "string" || body.email.trim() === "") {
    return { ok: false, error: "email is required" };
  }
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
  return { ok: true, data: { display_name, full_name, email, send_invite, group_assignments } };
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
  const { display_name, full_name, email, send_invite, group_assignments } = v.data;

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
  // Order matters: the players row must exist BEFORE we call createUser so
  // that link_player_on_auth_signup (migration 020) finds a pending email
  // match when the auth.users INSERT trigger fires.
  // Resolve the final display_name: use the caller's if provided, otherwise
  // generate from full_name via the canonical ladder, deduped against all
  // existing players.display_name (case-insensitive).
  let finalDisplayName = display_name;
  if (!finalDisplayName) {
    const { data: existing, error: exErr } = await admin.from("players").select("display_name");
    if (exErr) return json({ error: "Display-name generation failed", details: exErr.message }, 500);
    const taken = new Set((existing ?? []).map((r) => String(r.display_name ?? "").toLowerCase()));
    finalDisplayName = generateDisplayName(full_name!, taken);
  }

  const playerId = newPlayerId();
  const nowIso = new Date().toISOString();
  const { data: playerInsert, error: pErr } = await admin
    .from("players")
    .insert({
      id: playerId,
      user_id: null,
      display_name: finalDisplayName,
      full_name,
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
  let warning: string | null = null;

  if (send_invite) {
    let existingUserId: string | null = null;
    try {
      existingUserId = await findExistingAuthUser(admin, email);
    } catch (err) {
      // Treat lookup failure as "unknown" — fall through to the createUser
      // call, which will surface its own duplicate-user error if needed.
      console.warn("listUsers lookup failed, falling through to createUser:", err);
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
      // Step 1: create the auth.users row without sending an email. The
      // link_player_on_auth_signup trigger fires AFTER INSERT and links the
      // players row we just inserted (by case-insensitive email match).
      const { error: createErr } = await admin.auth.admin.createUser({
        email,
        email_confirm: false,
        user_metadata: { display_name: finalDisplayName },
      });
      if (createErr) {
        // Don't roll back the player; admin can re-trigger an invite from
        // the Players page (Send Invite). Surface the error so the UI can
        // show it.
        return json({
          error: "Player created, but createUser failed",
          details: createErr.message,
          player: playerInsert,
          groups_assigned: group_assignments.length,
          invite_sent: false,
          already_had_auth: false,
        }, 500);
      }

      // Step 2: trigger the OTP code email. shouldCreateUser:false because
      // we just created the user; emailRedirectTo:undefined so the email
      // body contains only {{ .Token }} and no clickable URL.
      const { error: otpErr } = await admin.auth.signInWithOtp({
        email,
        options: { shouldCreateUser: false, emailRedirectTo: undefined },
      });
      if (otpErr) {
        // Auth user exists and the trigger has linked the player — only
        // the email send failed. Admin can use Send Again to retry.
        warning = `Auth user created but OTP email failed: ${otpErr.message}. Use Send Again to retry.`;
      } else {
        invite_sent = true;
      }
    }
  }

  return json({
    player: playerInsert,
    groups_assigned: group_assignments.length,
    invite_sent,
    already_had_auth,
    ...(warning ? { warning } : {}),
  }, 200);
});
