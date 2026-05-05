/**
 * Integration tests for Glide → v2 membership sync.
 * 1. UserProfile import creates correct player and group_members row.
 * 2. Idempotency: re-run does not create duplicate memberships.
 * 3. Same player (same email) in multiple groups → one player, multiple group_members.
 *
 * Requires: supabase start, supabase db reset (seed has group-seed-001, group-seed-002).
 * Env: SUPABASE_URL, SUPABASE_ANON_KEY. Uses test user test@lateadd.local / testpass123.
 */
import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { writeFileSync, mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

try {
  const dotenv = await import("dotenv");
  dotenv.config({ path: join(ROOT, ".env") });
} catch {}

const BASE = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON = process.env.SUPABASE_ANON_KEY;
const GROUP_1 = "group-seed-001";
const GROUP_2 = "group-seed-002";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Build a minimal ODS (written as xlsx) with UserProfiles sheet */
function buildUserProfilesOds(rows) {
  const headers = [
    "🔒 Row ID",
    "Identity/Name",
    "Identity/Username",
    "Identity/Email",
    "Identity/Venmo Handle",
    "Identity/Role",
    "Identity/Is Active",
    "Group/ID",
    "Identity/Photo",
  ];
  const sheetRows = [headers, ...rows.map((r) => [
    r.rowId,
    r.name ?? "",
    r.username ?? "",
    r.email ?? "",
    r.venmoHandle ?? "",
    r.role ?? "member",
    r.isActive ?? true,
    r.groupId ?? "",
    r.photoUrl ?? "",
  ])];
  const ws = XLSX.utils.aoa_to_sheet(sheetRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "UserProfiles");
  return wb;
}

function writeOdsToTemp(wb) {
  const dir = mkdtempSync(join(tmpdir(), "glide-members-test-"));
  const path = join(dir, "profiles.xlsx");
  XLSX.writeFile(wb, path);
  return path;
}

function runSyncMembers(odsPath) {
  const env = {
    ...process.env,
    SUPABASE_URL: BASE,
    SUPABASE_ANON_KEY: ANON,
    GLIDE_IMPORT_EMAIL: "test@lateadd.local",
    GLIDE_IMPORT_PASSWORD: "testpass123",
  };
  const r = spawnSync(
    process.execPath,
    [join(ROOT, "scripts", "sync-glide-members.mjs"), odsPath],
    { env, cwd: ROOT, encoding: "utf-8", timeout: 30000 }
  );
  return { stdout: r.stdout, stderr: r.stderr, status: r.status, error: r.error };
}

async function main() {
  if (!ANON) {
    console.error("Set SUPABASE_URL and SUPABASE_ANON_KEY (e.g. from supabase start).");
    process.exit(1);
  }

  const admin = createClient(BASE, process.env.SUPABASE_SERVICE_ROLE_KEY || ANON, { auth: { persistSession: false } });

  // Seed test user id (from supabase/seed.sql)
  const userId = "a0000000-0000-0000-0000-000000000001";

  console.log("--- Test 1: UserProfile import creates player and group_members (display_name = username) ---");
  const wb1 = buildUserProfilesOds([
    {
      rowId: "gl-member-test-1",
      username: "AliceFromGlide",
      name: "Alice From Glide",
      email: "alice-glide@test.local",
      groupId: GROUP_1,
      role: "member",
      isActive: true,
    },
  ]);
  const path1 = writeOdsToTemp(wb1);
  const run1 = runSyncMembers(path1);
  assert(run1.status === 0, `sync-glide-members failed: ${run1.stderr || run1.stdout}`);

  const { data: players1 } = await admin.from("players").select("id, display_name, full_name, email, is_active").eq("user_id", userId);
  const alice = (players1 || []).find((p) => p.email === "alice-glide@test.local" || p.id === "gl-member-test-1");
  assert(alice, "Expected one player (Alice). Got: " + JSON.stringify(players1));
  assert(alice.display_name === "AliceFromGlide", "display_name must be v1 username (standings). Got: " + alice.display_name);
  assert(alice.full_name === "Alice From Glide", "full_name must be v1 name. Got: " + alice.full_name);

  const { data: members1 } = await admin.from("group_members").select("id, group_id, player_id, role, is_active").eq("group_id", GROUP_1);
  const aliceMember = (members1 || []).find((m) => m.player_id === alice.id);
  assert(aliceMember, "Expected one group_members row for Alice in group-seed-001. Got: " + JSON.stringify(members1));
  assert(aliceMember.role === "member" && aliceMember.is_active === 1, "Expected role member, is_active 1");

  console.log("   OK: player and group_members created");

  console.log("--- Test 2: Idempotency - re-run does not duplicate ---");
  const run2 = runSyncMembers(path1);
  assert(run2.status === 0, "Second sync should succeed");

  const { data: players2 } = await admin.from("players").select("id").eq("user_id", userId).eq("email", "alice-glide@test.local");
  const { data: members2 } = await admin.from("group_members").select("id").eq("group_id", GROUP_1).eq("player_id", alice.id);
  assert((players2 || []).length === 1, "Should still have exactly one player for alice-glide@test.local");
  assert((members2 || []).length === 1, "Should still have exactly one group_members row for Alice in group-seed-001");

  console.log("   OK: no duplicate player or membership");

  console.log("--- Test 3: Same player in multiple groups → one player, two group_members ---");
  const wb3 = buildUserProfilesOds([
    {
      rowId: "gl-multi-1",
      username: "BobMulti",
      name: "Bob Multi",
      email: "bob-multi@test.local",
      groupId: GROUP_1,
      role: "member",
      isActive: true,
    },
    {
      rowId: "gl-multi-2",
      username: "BobMulti",
      name: "Bob Multi",
      email: "bob-multi@test.local",
      groupId: GROUP_2,
      role: "member",
      isActive: 1,
    },
  ]);
  const path3 = writeOdsToTemp(wb3);
  const run3 = runSyncMembers(path3);
  assert(run3.status === 0, `Multi-group sync failed: ${run3.stderr || run3.stdout}`);

  const { data: players3 } = await admin.from("players").select("id, display_name, email").eq("user_id", userId).eq("email", "bob-multi@test.local");
  assert((players3 || []).length === 1, "Same email should yield one player. Got: " + JSON.stringify(players3));
  const bobId = players3[0].id;

  const { data: members3 } = await admin.from("group_members").select("group_id, player_id").eq("player_id", bobId);
  const groupsForBob = (members3 || []).map((m) => m.group_id);
  assert(
    groupsForBob.includes(GROUP_1) && groupsForBob.includes(GROUP_2) && groupsForBob.length === 2,
    "Bob should be in both groups. Got: " + JSON.stringify(members3)
  );

  console.log("   OK: one player, two group_members (multi-group)");

  console.log("\nAll glide-members-sync tests passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
