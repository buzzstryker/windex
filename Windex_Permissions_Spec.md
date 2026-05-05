# Windex — Permissions Spec

---

## Schema findings

### Tables relevant to users, players, and roles

| Table | Key columns | Purpose |
|-------|-------------|---------|
| **auth.users** | `id` (UUID) | Supabase Auth users. Each logged-in person has one row. |
| **players** | `id` (TEXT), `user_id` (UUID FK → auth.users), `display_name`, `full_name`, `email`, `venmo_handle`, `is_active` | Canonical player records. PK is composite `(id, user_id)`. One auth user can own many player records. `id` is a Glide Row ID (TEXT), not a UUID. |
| **group_members** | `id` (TEXT), `group_id` (TEXT FK → groups), `player_id` (TEXT), `role` (TEXT, default 'member'), `is_active` (SMALLINT) | Membership in a group. UNIQUE on `(group_id, player_id)`. `player_id` references `players.id` by convention but **has no FK constraint**. |
| **groups** | `id` (TEXT), `user_id` (UUID FK → auth.users), `name`, `admin_player_id` (TEXT, nullable), `dollars_per_point` | League groups. `user_id` = the auth user who "owns" the group (currently used for RLS). |
| **league_rounds** | `id` (TEXT), `user_id` (UUID FK → auth.users), `group_id` (TEXT FK → groups) | Round records. `user_id` = the auth user who created the round. |
| **league_scores** | `id` (TEXT), `league_round_id` (TEXT FK → league_rounds), `player_id` (TEXT) | Per-player point records. `player_id` references `players.id` by convention (no FK). |

### Key observations

1. **`player_id` in `group_members` is TEXT, not UUID.** It references `players.id` (a Glide Row ID like `rkzvcxQz6y4cbEG9Ja88`) — NOT `auth.users.id`. There is **no FK constraint** enforcing this relationship. Same for `league_scores.player_id`.

2. **`players.user_id`** links a player record to the auth user who manages it. Currently all players are owned by the single `dev@lateaddgolf.com` user (UUID `c49d7e41-...`). In a multi-user system, each user would own their own player records.

3. **No `is_super_admin` flag exists** anywhere in the schema. There is no mechanism to distinguish a super admin from a regular user.

4. **`group_members.role`** is a free-text field (no CHECK constraint). Current values include `'member'`, `'admin'`, `'Admin'`, and some corrupted values (e.g. a group_id stored as role). There is no `'super_admin'` role.

5. **`groups.admin_player_id`** exists (TEXT, nullable) — a legacy field from Glide v1 that could identify the group's admin player. Not currently used in RLS or code.

6. **Current RLS is single-user.** All policies check `auth.uid() = user_id` (owner model). A logged-in user can only see/modify data they own. There is no cross-user read access — a member of a group cannot see standings unless they are the `user_id` owner of the group record.

---

## Roles

| Role | Scope | How determined |
|------|-------|----------------|
| **Super admin** | Global | `players.is_super_admin = 1` (new column needed) |
| **Group admin** | Per group | `group_members.role = 'admin'` for that group |
| **Member** | Per group | `group_members.role = 'member'` (default) |

- A player can be a group admin for multiple groups.
- Buzz Stryker is super admin. Super admins can promote other users.
- Super admin status is on the `players` table, linked to the auth user via `players.user_id`.

---

## Capabilities

| Capability | Super Admin | Group Admin | Member |
|------------|-------------|-------------|--------|
| Create groups | Yes | No | No |
| Assign group admins | Yes | No | No |
| Promote users to super admin | Yes | No | No |
| Add/edit/delete rounds — any group | Yes | No | No |
| Add/edit/delete rounds — own group | Yes | Yes | No |
| Create rounds + enter all player scores | Yes | Yes | Yes (own groups only) |
| Manage group members | Yes | Yes (own group) | No |
| Configure payout (dollars_per_point) | Yes | Yes (own group) | No |
| View standings + rounds — own groups | Yes | Yes | Yes |
| View standings + rounds — any group | Yes | Yes | Yes (read only) |
| Browse all groups (logged in) | Yes | Yes | Yes |
| View any data without login | No | No | No |
| Access late-add-admin UI | Yes | No | No |
| Audit trail visibility | Yes (web admin only) | No | No |

---

## Round rules

- Each round belongs to exactly one group.
- Members can create rounds and enter scores for all players in that round.
- Members cannot edit or delete rounds after creation — must ask group admin.
- **Season-based creation rule:** Members can only create rounds in the current (active) season (end_date >= today). Group admins and super admins can create rounds in any season (past or current) to support backfilling.
- No admin approval required before scores are submitted.
- Deleted rounds are excluded from standings automatically.
- Audit trail exists in backend; UI only in late-add-admin.

---

## Access rules

- All data is behind login — no public access.
- Any logged-in user can browse all groups (read only).
- Round create/edit/delete is scoped to group membership and role.

---

## What needs to be added to the schema

### 1. `is_super_admin` column on `players`

```sql
ALTER TABLE players ADD COLUMN IF NOT EXISTS is_super_admin SMALLINT NOT NULL DEFAULT 0;
```

Set Buzz Stryker's player record: `UPDATE players SET is_super_admin = 1 WHERE display_name = 'Buzz' AND email = 'buzzstryker67@gmail.com';`

### 2. Normalize `group_members.role` values

Current data has inconsistent role values (`'Admin'`, `'admin'`, `'member'`, and corrupted values). Add a CHECK constraint after cleanup:

```sql
-- Normalize existing data
UPDATE group_members SET role = 'admin' WHERE lower(role) = 'admin';
UPDATE group_members SET role = 'member' WHERE role NOT IN ('admin', 'member');

-- Add constraint
ALTER TABLE group_members ADD CONSTRAINT group_members_role_check
  CHECK (role IN ('admin', 'member'));
```

### 3. Link players to auth.users for multi-user support

Currently all `players.user_id` and `groups.user_id` point to a single auth user. For multi-user:

- Each auth user who signs up needs a player record linking `players.user_id = auth.uid()`.
- The `players.email` field should match `auth.users.email` to resolve which player record belongs to which logged-in user.
- A helper function or trigger could auto-create a player record on first sign-in.

### 4. RLS policy overhaul

Current policies are single-owner (`auth.uid() = user_id`). They need to change to role-based:

| Table | SELECT | INSERT | UPDATE | DELETE |
|-------|--------|--------|--------|--------|
| **groups** | Any authenticated user (browse all) | Super admin only | Super admin OR group admin (via group_members) | Super admin only |
| **group_members** | Any authenticated user (browse all) | Super admin OR group admin of that group | Super admin OR group admin of that group | Super admin OR group admin of that group |
| **players** | Any authenticated user | Super admin OR the owning user | Super admin OR the owning user | Super admin only |
| **seasons** | Any authenticated user | Super admin OR group admin of that group | Super admin OR group admin of that group | Super admin only |
| **league_rounds** | Any authenticated user (browse all) | Any member of the group | Super admin OR group admin of that group OR the creating user (edit own within time window?) | Super admin OR group admin of that group |
| **league_scores** | Same as league_rounds (via join) | Same as league_rounds | Super admin OR group admin | Super admin OR group admin |
| **sections** | Any authenticated user | Super admin only | Super admin only | Super admin only |

### 5. `player_id` in `group_members` — does it need to change?

**No.** `player_id` should remain TEXT referencing `players.id`. It is not an auth user ID — it's a logical player identity. One auth user may have multiple player records (e.g. Buzz in Windex Cup vs Buzz YC Weds). The link between "logged-in user" and "which player am I" goes through `players.user_id = auth.uid()`.

However, adding a **FK constraint** would improve data integrity:

```sql
-- This requires players PK to be just (id), not composite (id, user_id).
-- Current PK is (id, user_id) — would need migration to change.
-- For now, enforce at application level.
```

---

## Summary of required changes

## Client-side enforcement (implemented)

The Expo app resolves permissions on login via Supabase RPC functions:
- `am_i_super_admin()` → stored as `isSuperAdmin` in `GroupContext`
- `get_my_player_ids()` → resolves player IDs, then queries `group_members` for `role = 'admin'` → stored as `adminGroupIds` set
- `isGroupAdmin(groupId)` → checks the set
- Round Detail: edit/delete buttons hidden unless `isSuperAdmin || isGroupAdmin(round.group_id)`
- Add Round button visible to all users (members can create rounds)
- Backend RLS enforces at DB level as a second layer

| Change | Type | Priority |
|--------|------|----------|
| Add `is_super_admin` column to `players` | Migration | High |
| Normalize `group_members.role` values + add CHECK | Migration | High |
| Rewrite RLS policies for multi-user role-based access | Migration | High |
| Create player record on first sign-in (trigger or app logic) | Code | Medium |
| Add function to resolve "which player am I" from `auth.uid()` | Code | Medium |
| Consider changing `players` PK from `(id, user_id)` to `(id)` + unique on `(id, user_id)` | Migration | Low |
| Add FK from `group_members.player_id` → `players.id` | Migration | Low |
