// POST /create-group — Super-admin only.
//
// Creates a new league group with optional logo image and an initial set of
// admins (one row per admin in group_members with role='admin'). The image,
// if provided, is uploaded to the existing `group-images` Storage bucket
// (see migration 026 for bucket policies); the public URL is stored in
// `groups.logo_url`.
//
// Auth: handler-side getUser(token) + am_i_super_admin() RPC. Deployed with
// verify_jwt = false (matches every other function in this project — see
// config.toml; platform-level verification was disabled deliberately because
// it failed against linked projects).
//
// Request: multipart/form-data
//   - field "payload": JSON string with shape
//       {
//         "name": "Night Shift Golf",
//         "season_start_month": 1,        // 1..12
//         "admin_player_ids": ["...", "..."]
//       }
//   - field "image" (optional): File (image/jpeg | image/png | image/webp,
//     up to 10 MiB; enforced both client-side and by bucket config).
//
// Responses:
//   200 { group: { id, name, logo_url, season_start_month, ... } }
//   400 { error: "...validation message..." }
//   401 { error: "Unauthorized" }
//   403 { error: "Super admin only" }
//   409 { error: "A group with this name already exists", existing_group_id }
//   413 { error: "Image too large" }
//   415 { error: "Unsupported image type" }
//   500 { error: "..." } — partial-failure rollback already attempted
//
// Atomicity: image upload → groups insert → group_members insert, in that
// order. On any step's failure, all earlier-completed steps are rolled back
// (storage object deleted, groups row deleted). Inline-created players from
// the AddPlayerModal are NOT rolled back — they are valid standalone records
// independent of group creation.

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

const BUCKET = "group-images";
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MiB — matches bucket config
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

// 20-character group id, [A-Za-z0-9]. Matches the shape of historical Glide
// row ids already in the table and the player-id minting in invite-player.
const ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
function newGroupId(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

// 6-char [a-z0-9] suffix used in the storage object name to avoid overwrite
// races when two concurrent creates pick the same slug.
const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function shortSuffix(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += SUFFIX_ALPHABET[b % SUFFIX_ALPHABET.length];
  return out;
}

function slugify(name: string): string {
  // NFKD splits accented chars into base + combining mark, then we drop the
  // combining range (U+0300..U+036F) so "Mëtàl" → "metal" before the [^a-z0-9]+
  // pass turns the rest into hyphens.
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "group";
}

// Match the shape used by invite-player and sync-glide-members.mjs.
function groupMemberId(groupId: string, playerId: string): string {
  const safe = (x: string) => x.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  return `gm_${safe(groupId)}_${safe(playerId)}`;
}

type CreateGroupPayload = {
  name: string;
  season_start_month: number;
  admin_player_ids: string[];
};

function parsePayload(raw: unknown): { ok: true; data: CreateGroupPayload } | { ok: false; error: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: "Missing 'payload' field" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "'payload' is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "'payload' must be a JSON object" };
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p.name !== "string" || p.name.trim() === "") {
    return { ok: false, error: "name is required" };
  }
  const name = p.name.trim();
  if (name.length > 80) return { ok: false, error: "name must be 80 characters or fewer" };

  if (typeof p.season_start_month !== "number" || !Number.isInteger(p.season_start_month)
      || p.season_start_month < 1 || p.season_start_month > 12) {
    return { ok: false, error: "season_start_month must be an integer 1..12" };
  }
  const season_start_month = p.season_start_month;

  if (!Array.isArray(p.admin_player_ids) || p.admin_player_ids.length === 0) {
    return { ok: false, error: "At least one admin_player_id is required" };
  }
  const seen = new Set<string>();
  const admin_player_ids: string[] = [];
  for (const v of p.admin_player_ids) {
    if (typeof v !== "string" || v.trim() === "") {
      return { ok: false, error: "admin_player_ids entries must be non-empty strings" };
    }
    const id = v.trim();
    if (!seen.has(id)) { seen.add(id); admin_player_ids.push(id); }
  }

  return { ok: true, data: { name, season_start_month, admin_player_ids } };
}

async function rollbackStorage(admin: SupabaseClient, path: string | null) {
  if (!path) return;
  try {
    await admin.storage.from(BUCKET).remove([path]);
  } catch (err) {
    console.warn("Storage rollback failed for", path, err);
  }
}

async function rollbackGroup(admin: SupabaseClient, groupId: string | null) {
  if (!groupId) return;
  try {
    await admin.from("groups").delete().eq("id", groupId);
  } catch (err) {
    console.warn("Group rollback failed for", groupId, err);
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
  const callerUserId = userInfo.user.id;

  // Super-admin gate via SQL helper from migration 014.
  const { data: isSuper, error: gateError } = await callerClient.rpc("am_i_super_admin");
  if (gateError) return json({ error: "Permission check failed", details: gateError.message }, 500);
  if (isSuper !== true) return json({ error: "Super admin only" }, 403);

  // ── Parse multipart body ────────────────────────────────────────────────
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Expected multipart/form-data body" }, 400);
  }
  const payloadRaw = form.get("payload");
  const v = parsePayload(payloadRaw);
  if (!v.ok) return json({ error: v.error }, 400);
  const { name, season_start_month, admin_player_ids } = v.data;

  const imageField = form.get("image");
  let imageFile: File | null = null;
  if (imageField instanceof File && imageField.size > 0) {
    imageFile = imageField;
    if (!ALLOWED_MIME.has(imageFile.type)) {
      return json({ error: `Unsupported image type '${imageFile.type}'. Use jpg, png, or webp.` }, 415);
    }
    if (imageFile.size > MAX_IMAGE_BYTES) {
      return json({ error: "Image exceeds 10 MiB limit" }, 413);
    }
  }

  // Service-role client for the writes (bypasses RLS so rollback can clean
  // up regardless of caller membership / mid-operation state).
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Case-insensitive name uniqueness ────────────────────────────────────
  const { data: dupRows, error: dupErr } = await admin
    .from("groups")
    .select("id")
    .ilike("name", name)
    .limit(1);
  if (dupErr) return json({ error: "Name uniqueness check failed", details: dupErr.message }, 500);
  if (dupRows && dupRows.length > 0) {
    return json({
      error: "A group with this name already exists",
      existing_group_id: dupRows[0].id,
    }, 409);
  }

  // ── Validate referenced players exist ──────────────────────────────────
  const { data: playerRows, error: playerErr } = await admin
    .from("players")
    .select("id")
    .in("id", admin_player_ids);
  if (playerErr) return json({ error: "Player lookup failed", details: playerErr.message }, 500);
  const foundIds = new Set((playerRows ?? []).map((r) => r.id as string));
  const missing = admin_player_ids.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    return json({ error: `Unknown player id(s): ${missing.join(", ")}` }, 400);
  }

  // ── Image upload (if provided) ──────────────────────────────────────────
  let storagePath: string | null = null;
  let logoUrl: string | null = null;
  if (imageFile) {
    const ext = MIME_TO_EXT[imageFile.type];
    storagePath = `${slugify(name)}-${shortSuffix()}.${ext}`;
    const bytes = new Uint8Array(await imageFile.arrayBuffer());
    const { error: upErr } = await admin.storage.from(BUCKET).upload(storagePath, bytes, {
      contentType: imageFile.type,
      upsert: false,
    });
    if (upErr) {
      return json({ error: "Image upload failed", details: upErr.message }, 500);
    }
    const pub = admin.storage.from(BUCKET).getPublicUrl(storagePath);
    logoUrl = pub.data.publicUrl;
  }

  // ── Insert groups row ───────────────────────────────────────────────────
  const groupId = newGroupId();
  const nowIso = new Date().toISOString();
  const { data: groupInsert, error: gErr } = await admin
    .from("groups")
    .insert({
      id: groupId,
      user_id: callerUserId,
      name,
      logo_url: logoUrl,
      season_start_month,
      admin_player_id: null, // legacy column; multi-admin lives in group_members
      created_at: nowIso,
      updated_at: nowIso,
    })
    .select("id, name, logo_url, season_start_month, section_id, dollars_per_point, user_id, created_at")
    .single();
  if (gErr || !groupInsert) {
    await rollbackStorage(admin, storagePath);
    return json({ error: "Failed to create group", details: gErr?.message ?? "no row returned" }, 500);
  }

  // ── Insert group_members rows (all admins) ──────────────────────────────
  const memberRows = admin_player_ids.map((pid) => ({
    id: groupMemberId(groupId, pid),
    group_id: groupId,
    player_id: pid,
    role: "admin",
    is_active: 1,
    joined_at: nowIso,
  }));
  const { error: gmErr } = await admin.from("group_members").insert(memberRows);
  if (gmErr) {
    await rollbackGroup(admin, groupId); // cascades to any partial group_members
    await rollbackStorage(admin, storagePath);
    return json({ error: "Failed to assign admins (rollback applied)", details: gmErr.message }, 500);
  }

  return json({ group: groupInsert }, 200);
});
