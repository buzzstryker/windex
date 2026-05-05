/**
 * Invite players to Windex via Supabase magic link.
 *
 * 1. Query active players in specified groups
 * 2. Create auth accounts via admin.inviteUserByEmail() (sends invite email)
 * 3. Update players.user_id to link each player to their new auth account
 *
 * Usage:
 *   node scripts/invite-players.mjs                  # dry-run (query only)
 *   node scripts/invite-players.mjs --send-invites   # create accounts + send emails + link user_ids
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

try {
  const dotenv = await import('dotenv');
  dotenv.config({ path: join(ROOT, '.env') });
} catch {}

const { createClient } = await import('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
  process.exit(1);
}

// Service-role client bypasses RLS
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const TARGET_GROUPS = ['Windex Cup', 'NSF YC TBD'];
const REDIRECT_URL = 'https://late-add-v2.vercel.app';
const sendInvites = process.argv.includes('--send-invites');

async function main() {
  // ── Step 1: Query players in target groups ──────────────────────
  console.log('\n=== Step 1: Query active players ===\n');

  // Get target groups
  const { data: groups, error: gErr } = await supabase
    .from('groups')
    .select('id, name')
    .in('name', TARGET_GROUPS);
  if (gErr) throw gErr;

  if (!groups.length) {
    console.error('No groups found matching:', TARGET_GROUPS);
    process.exit(1);
  }
  console.log('Groups found:');
  groups.forEach((g) => console.log(`  ${g.id} → ${g.name}`));

  const groupIds = groups.map((g) => g.id);
  const groupNameById = Object.fromEntries(groups.map((g) => [g.id, g.name]));

  // Get active group members in those groups
  const { data: members, error: mErr } = await supabase
    .from('group_members')
    .select('player_id, group_id, role, is_active')
    .in('group_id', groupIds)
    .eq('is_active', 1);
  if (mErr) throw mErr;

  const playerIds = [...new Set(members.map((m) => m.player_id))];

  // Get player details
  const { data: players, error: pErr } = await supabase
    .from('players')
    .select('id, user_id, display_name, email, is_active, is_super_admin')
    .in('id', playerIds);
  if (pErr) throw pErr;

  // Build player map with group memberships
  const playerMap = new Map();
  for (const p of players) {
    playerMap.set(p.id, { ...p, groups: [] });
  }
  for (const m of members) {
    const p = playerMap.get(m.player_id);
    if (p) p.groups.push({ groupId: m.group_id, groupName: groupNameById[m.group_id], role: m.role });
  }

  const allPlayers = [...playerMap.values()].sort((a, b) => a.display_name.localeCompare(b.display_name));
  const withEmail = allPlayers.filter((p) => p.email);
  const noEmail = allPlayers.filter((p) => !p.email);

  console.log(`\nActive players in target groups: ${allPlayers.length}`);
  console.log(`  With email: ${withEmail.length}`);
  console.log(`  Without email (skipped): ${noEmail.length}\n`);

  console.log('─── Players WITH email ───');
  for (const p of withEmail) {
    const groupList = p.groups.map((g) => g.groupName).join(', ');
    console.log(`  ${p.display_name.padEnd(22)} ${p.email.padEnd(32)} ${groupList}`);
  }

  if (noEmail.length) {
    console.log('\n─── Players WITHOUT email (skipped) ───');
    for (const p of noEmail) {
      const groupList = p.groups.map((g) => g.groupName).join(', ');
      console.log(`  ${p.display_name.padEnd(22)} (no email)${' '.repeat(22)} ${groupList}`);
    }
  }

  if (!sendInvites) {
    console.log('\n⏸  Dry run — pass --send-invites to create accounts and send emails.\n');
    return;
  }

  // ── Step 2: Create auth accounts ────────────────────────────────
  console.log('\n=== Step 2: Create auth accounts + send invite emails ===\n');

  const created = [];
  const skipped = [];
  const errors = [];

  for (const p of withEmail) {
    const email = p.email.toLowerCase().trim();

    // Check if auth user already exists for this email
    const { data: existingUsers } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 1,
    });
    // listUsers doesn't support email filter directly; use inviteUserByEmail and handle conflict
    const { data: inviteData, error: inviteErr } = await supabase.auth.admin.inviteUserByEmail(
      email,
      {
        data: { display_name: p.display_name },
        redirectTo: REDIRECT_URL,
      }
    );

    if (inviteErr) {
      // If user already exists, look them up
      if (inviteErr.message?.includes('already been registered') ||
          inviteErr.message?.includes('already exists') ||
          inviteErr.status === 422) {
        // Look up existing user by email
        const { data: listData } = await supabase.auth.admin.listUsers();
        const existing = listData?.users?.find((u) => u.email?.toLowerCase() === email);
        if (existing) {
          skipped.push({ ...p, authUserId: existing.id, reason: 'auth account already exists' });
          console.log(`  ⊘ ${p.display_name.padEnd(22)} already has auth account (${existing.id.slice(0, 8)}…)`);
        } else {
          errors.push({ ...p, error: inviteErr.message });
          console.log(`  ✗ ${p.display_name.padEnd(22)} ERROR: ${inviteErr.message}`);
        }
      } else {
        errors.push({ ...p, error: inviteErr.message });
        console.log(`  ✗ ${p.display_name.padEnd(22)} ERROR: ${inviteErr.message}`);
      }
    } else {
      const newUserId = inviteData.user.id;
      created.push({ ...p, authUserId: newUserId });
      console.log(`  ✓ ${p.display_name.padEnd(22)} invited → ${newUserId.slice(0, 8)}…`);
    }
  }

  // ── Step 3: Link players.user_id ────────────────────────────────
  console.log('\n=== Step 3: Link players.user_id to auth accounts ===\n');

  const linked = [];
  const linkErrors = [];
  const allInvited = [...created, ...skipped].filter((p) => p.authUserId);

  for (const p of allInvited) {
    if (p.user_id === p.authUserId) {
      console.log(`  ─ ${p.display_name.padEnd(22)} already linked`);
      linked.push({ ...p, action: 'already linked' });
      continue;
    }

    // Update the composite PK: need to update user_id
    const { error: updateErr } = await supabase
      .from('players')
      .update({ user_id: p.authUserId, updated_at: new Date().toISOString() })
      .eq('id', p.id)
      .eq('user_id', p.user_id);

    if (updateErr) {
      linkErrors.push({ ...p, error: updateErr.message });
      console.log(`  ✗ ${p.display_name.padEnd(22)} LINK ERROR: ${updateErr.message}`);
    } else {
      linked.push({ ...p, action: 'updated' });
      console.log(`  ✓ ${p.display_name.padEnd(22)} user_id → ${p.authUserId.slice(0, 8)}…`);
    }
  }

  // ── Step 4: Report ──────────────────────────────────────────────
  console.log('\n=== Report ===\n');
  console.log(`Auth accounts created (invite sent): ${created.length}`);
  for (const p of created) {
    console.log(`  ✓ ${p.display_name} (${p.email})`);
  }

  console.log(`\nAuth accounts already existed: ${skipped.length}`);
  for (const p of skipped) {
    console.log(`  ⊘ ${p.display_name} (${p.email})`);
  }

  console.log(`\nPlayers skipped (no email): ${noEmail.length}`);
  for (const p of noEmail) {
    console.log(`  – ${p.display_name}`);
  }

  console.log(`\nplayers.user_id linked: ${linked.length}`);
  for (const p of linked) {
    console.log(`  ✓ ${p.display_name} → ${p.authUserId?.slice(0, 8)}… (${p.action})`);
  }

  if (errors.length || linkErrors.length) {
    console.log(`\nErrors: ${errors.length + linkErrors.length}`);
    for (const e of [...errors, ...linkErrors]) {
      console.log(`  ✗ ${e.display_name}: ${e.error}`);
    }
  }

  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
