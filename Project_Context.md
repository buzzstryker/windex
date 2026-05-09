# Project Context — Windex

*Created from `Project_Context_TEMPLATE.md` during the Late Add v2 → Windex rename, 2026-05-05.*

---

## What this project is

Windex (formerly **Late Add v2**) is a **points ledger + standings aggregation platform for golf**. It maintains groups (leagues), seasons, players, and per-round point totals; aggregates standings; and optionally generates settlement / Venmo payment-request output. Windex does **not** compute golf competition formats (Stableford, match play, best ball, skins, etc.); external apps or human admins determine the points, and Windex stores, attributes, audits, and aggregates them. The platform exposes an API so any third-party golf app (e.g. Scorekeeper, 18Birdies) can submit results, and ships its own admin UI and player-facing PWA. The only umbrella platform is being rebranded; specific in-platform groups (e.g. "Windex Cup") keep their names.

## Stack

- **Mobile / PWA:** Expo SDK 54, React 19, React Native 0.81, Expo Router 6 (`windex-expo/`). Web build via `npx expo export --platform web`. iOS/Android via Expo Go for dev; native production builds out of current scope.
- **Admin web UI:** Vite 5, React 18, React Router 6 (`windex-admin/`). Internal tool for league admins.
- **Backend / API:** Supabase Cloud — Postgres 15 + Auth + Edge Functions (Deno) (`windex-api/`). 15 Edge Functions; 19 numbered SQL migrations.
- **Hosting:** Vercel — auto-deploys `windex-expo/` to `windexgolf.com` from `master`. Vercel `ignoreCommand` skips builds when commits don't touch the deployed folder.
- **Auth:** Supabase email OTP (6-digit code) with email/password fallback. No deep-link or magic-link flow. JWTs stored client-side (sessionStorage on web, expo-file-system on native).
- **Other:** Glide ODS export → Supabase ingest pipeline (one-time migration path, still wired); Venmo deep-links for client-side payout settlement (`venmo://` and `https://venmo.com/`); shared-golf-types is a planned shared types package, not yet extracted.

## Repo structure

- **GitHub:** https://github.com/buzzstryker/windex (renamed from `late-add-v2` on 2026-05-05; GitHub auto-redirect from old URL is in place)
- **Local path:** `C:\Users\buzzs\OneDrive\Desktop\Projects\windex\` *(parent folder rename completes after this session via `rename-windex.bat` — see Phase 8 of rename PR)*
- **Default branch:** `master`
- **Top-level folders:**
  - `windex-api/` — Supabase backend: migrations, Edge Functions, scripts (Glide import, invite players, seed bundle), tests, docs.
  - `windex-admin/` — Vite + React admin web UI. Currently builds via `npx vite build`; pre-existing `tsc -b` strict-mode warnings (TS6133 unused React imports) are deferred to a separate cleanup PR.
  - `windex-expo/` — Expo app (web + mobile). The only folder Vercel watches.
  - `docs/` — repo-wide architecture / scope-boundary docs.
  - `glide-export/` — historical Glide platform ODS export (`610470.Late Add Golf.ods`); filename preserved because it's a Glide-system artifact, not a Windex file.
  - `patches/` — historical WIP `.patch` snapshots.
  - `supabase/` — empty `snippets/` only; the live Supabase tree is `windex-api/supabase/`.
  - `lateaddv1screenshots/` *(inside `windex-expo/`)* — historical screenshots of the Glide v1 predecessor app; preserved by name since the predecessor was actually called "Late Add."
- **Top-level docs (root):**
  - `README.md`, `BACKLOG.md`, `Project_Context.md` (this file).
  - Seven product/architecture docs: `Windex_Master_Spec.md`, `Windex_Data_Model.md`, `Windex_API_Spec.md`, `Windex_Permissions_Spec.md`, `Windex_Screen_Map.md`, `Windex_UI_Architecture.md`, `WINDEX_UI_IMPLEMENTATION_SUMMARY.md`.
  - Three API-folder pointers: `windex-api.md`, `windex-api-CLAUDE.md`, `bootstrap-windex-api.md`.
  - `shared-golf-types.md` — design doc for the planned types package.

## Data model

Implemented in `windex-api/supabase/migrations/`. Atomic-records-only; standings are **always derived** from the ledger.

| Table | Purpose | Key columns |
|---|---|---|
| `auth.users` | Supabase Auth identity | `id` (UUID) |
| `players` | Canonical player records (one auth user can own many) | `id` (TEXT — Glide Row ID), `user_id` (UUID FK), `display_name`, `full_name`, `email`, `venmo_handle`, `is_active`. Composite PK `(id, user_id)`. |
| `sections` | Optional parent for groups (organization-level) | `id` (TEXT), `user_id` (UUID FK), `name` |
| `groups` | League / competition unit | `id` (TEXT), `user_id` (UUID FK = owner), `name`, `section_id` (FK), `admin_player_id`, `dollars_per_point` (optional, drives money_delta) |
| `group_members` | Player-in-group membership | `id` (TEXT), `group_id` (FK), `player_id` (TEXT — references `players.id` by convention, no FK), `role`, `is_active` (SMALLINT). UNIQUE `(group_id, player_id)`. |
| `seasons` | Time-bounded competition window per group | `id`, `group_id` (FK), `start_date`, `end_date` |
| `league_rounds` | Event / round records | `id`, `user_id` (FK = creator), `group_id` (FK), `season_id` (FK, nullable), `round_date`, optional `source_app` + `external_event_id` for idempotency |
| `league_scores` | **Points ledger** — one atomic record per (round, player) | `league_round_id`, `player_id`, `score_value`, `score_override` (with `override_actor`, `override_reason`, `override_at`), optional `money_delta`, optional `result_type` (win/loss/tie). Effective points = `COALESCE(score_override, score_value)`. |
| `player_mappings` | Map source-app player IDs → canonical `players.id` (resolves Scorekeeper/Glide identities) | source identity ↔ `player_id` |
| `season_standings` (VIEW) | Read-only standings | Derived from `league_rounds` ⨝ `league_scores`: `rounds_played`, `total_points` per player per season. Never written. |

## Key decisions

- **Standings are derived, not stored.** Atomic rows in `league_scores` are the only writeable point records. The `season_standings` view recomputes on every read. Round edits / overrides modify ledger rows; standings refresh automatically. There is no mutable standings table by design — this prevents the standings-vs-ledger drift class of bug entirely.
- **Single canonical event/result model regardless of source.** Three ways events enter (API ingestion, manual admin entry, Glide import) all converge to `league_rounds` + `league_scores`. The UI uses `source_app` + `external_event_id` for attribution and idempotency, but does not maintain separate "manual-only" code paths.
- **Windex does not compute golf formats.** External apps or human admins decide what points each player gets. Windex stores final point totals only — no scorecard ingestion, no stroke counts, no birdies/pars/strokes math.
- **Supabase OTP code flow, never magic links.** Per Buzz's standard procedure (lesson learned the hard way on Honcut Phase 9). Eliminates deep-link / Expo Go / iOS Safari hash-stripping classes of bugs.
- **Path-filter Vercel deploys.** `windex-expo/vercel.json` has `"ignoreCommand": "git diff --quiet HEAD^ HEAD -- ."` so commits to `windex-api/` or `windex-admin/` don't trigger PWA rebuilds.
- **Cloud Supabase for primary workflows; local Supabase available via CLI for the integration and domain-rule test suites in `windex-api/tests/`.** Production migrations and Edge Functions deploy to the cloud project via `supabase link --project-ref ftmqzxykwcccocogkjhc` then `supabase db push` / `supabase functions deploy --no-verify-jwt`. The test suites (`integration.mjs`, `domain-rules.mjs`, `adapter-ingest.mjs`, `api_test.{ts,mjs}`, `glide-members-sync.mjs`) run against a local stack started via `supabase start && supabase db reset && supabase functions serve` and read `SUPABASE_URL=http://127.0.0.1:54321`. The `--no-verify-jwt` flag on cloud function deploys is required because functions handle auth internally. *Note: `windex-api/README.md` currently asserts cloud-only — that statement is accurate for the deploy/runtime path but is contradicted by the test scaffolding; reconcile in a follow-up if the local-test path is actually retired.*
- **Per-function JWT verification disabled at the platform layer.** Each Edge Function calls `getUser(token)` itself in the handler. Platform-level `verify_jwt` was disabled because it used different keys when linked to a remote project, causing false "Invalid JWT" errors on valid tokens.
- **User onboarding paths.** Two consumers of `supabase.auth.admin.inviteUserByEmail`: (1) `windex-api/scripts/invite-players.mjs` (launch flow — invited the original 19 players one-at-a-time, well under the 2/hour rate limit); (2) the `invite-player` Edge Function (admin "Add Player" flow, single-add per call). For bulk seeding without sending emails, `admin.createUser` is the alternative — it predates the unified flow and is still in scripts. **There is no `handle_new_user` trigger** despite an earlier version of this doc claiming otherwise; the FIRST `auth.users` trigger in this project is `link_player_on_auth_signup` from migration 020 (2026-05-09), which auto-links a pending players row by email match on first sign-in.
- **Three-folder repo layout, single Vercel deploy target.** Mobile/PWA, admin UI, and backend/scripts coexist in one repo to keep the data model, types, and migrations co-located. Only `windex-expo/` deploys to Vercel today; `windex-admin/` is currently expected to be run locally.

## Live URLs

- **Production (PWA):** https://windexgolf.com — cut over from `app.lateaddgolf.com` on 2026-05-05; `app.lateaddgolf.com` now 308-redirects to `windexgolf.com` (kept as redirect source for legacy bookmarks; do not delete or unlink). `lateaddgolf.com` (apex) and `www.lateaddgolf.com` remain GoDaddy parking pages and were intentionally never wired to Vercel.
- **GitHub repo:** https://github.com/buzzstryker/windex
- **Supabase project ID (ref):** `ftmqzxykwcccocogkjhc` (URL: `https://ftmqzxykwcccocogkjhc.supabase.co`). Project ref unchanged across the rename.
- **Vercel project name:** `late-add-v2` (still — rename of the Vercel project is deferred; it doesn't affect production URL or the build, only the auto-generated `*.vercel.app` preview URLs). Project's **Root Directory** setting was updated `late-add-expo` → `windex-expo` on 2026-05-05 alongside the folder rename.
- **Supabase auth additional_redirect_urls:** `https://windexgolf.com/**`, `https://www.windexgolf.com/**`, and `https://late-add-v2.vercel.app/**` (the third one tracks the Vercel-project name and gets revisited when the Vercel project is renamed). `site_url` is `https://windexgolf.com`.

---

## Working agreement with Claude

**All Claude Code prompts drafted in this project must enforce the following sections of `Buzz_Project_Development_Procedure.md` (kept at `C:\Users\buzzs\OneDrive\Desktop\Projects\Buzz_Project_Development_Procedure.md`):**

- **3.2a — Working-tree hygiene.** Every Claude Code session ends with a clean `git status`. No "I'll commit this later." Backend deploys (Supabase migrations, Edge Functions) and the corresponding git commits are paired operations.
- **3.2b — Backend deploys are git operations.** Any `npx supabase db query`, `npx supabase functions deploy`, or `npx vercel env add` must be followed by a git commit of the source in the same session.
- **4.1a — Path-filter Vercel deploys.** This project deploys to Vercel from `windex-expo/`; the project's `vercel.json` includes `"ignoreCommand": "git diff --quiet HEAD^ HEAD -- ."` so commits outside that folder don't trigger rebuilds.

When drafting prompts for Claude Code, include verifications for these rules where relevant — e.g. "verify clean working tree before starting," "commit any backend deploy source in the same session," etc.

---

## Delete Capability Audit (resolved 2026-05-07)

*Read-only audit performed 2026-05-07. Goal: determine what already exists for deleting a group or removing a player from a group, before designing any new delete UX. **Resolution implemented same day** — see "Resolution" at the bottom of this section.*

### 1. windex-admin UI — current state

| Surface | File | Delete capability? |
|---|---|---|
| `/groups` list | `windex-admin/src/pages/Groups.tsx` | **No.** Each row only has a "View seasons" link. No delete button, no row-level action menu. |
| `/groups/:id` detail | `windex-admin/src/pages/GroupDetail.tsx` | **No "Delete Group" button.** Page renders the group name, a "Back to groups" link, and a list of seasons with per-season Standings links. Nothing else. |
| `/players` (member management) | `windex-admin/src/pages/Players.tsx` + `src/api/playerAdmin.ts` | **No hard delete of `group_members`.** The "Edit" row lets an admin change `role` and toggle `is_active` (1 → 0 = soft delete), but the underlying `updateMembership()` call uses HTTP `PATCH` against `/rest/v1/group_members`. There is no `DELETE` path wired up. |

The only `DELETE`-method `fetch` calls in the admin app are in `pages/Events.tsx` against `league_scores` and `league_rounds` (round deletion). No admin code path issues a `DELETE` against `groups` or `group_members`.

### 2. Backend / schema — FK behavior

All FK constraints were created in `windex-api/supabase/migrations/001_core_schema.sql` and have not been altered by any later migration (verified by grepping `REFERENCES` across all 19 migrations).

| FK | Source → Target | ON DELETE |
|---|---|---|
| `group_members.group_id` | → `groups(id)` | **CASCADE** |
| `seasons.group_id` | → `groups(id)` | **CASCADE** |
| `league_rounds.group_id` | → `groups(id)` | **CASCADE** |
| `league_rounds.season_id` | → `seasons(id)` | **SET NULL** |
| `league_scores.league_round_id` | → `league_rounds(id)` | **CASCADE** |
| `groups.section_id` | → `sections(id)` | **SET NULL** |
| `groups.user_id` / `league_rounds.user_id` / `players.user_id` / `sections.user_id` | → `auth.users(id)` | CASCADE (irrelevant to per-group delete) |

Implication: a plain `DELETE FROM groups WHERE id = ?` will, by FK cascade alone:

- Delete all `group_members` for that group (cascade).
- Delete all `seasons` for that group (cascade).
- Delete all `league_rounds` for that group (cascade) → which in turn cascades to delete all `league_scores` for those rounds. **There is no direct FK from `league_scores` to `groups`; cleanup happens transitively via `league_rounds`.**
- Set `seasons.section_id` references to NULL where applicable (n/a — `seasons` has no `section_id`; only `groups.section_id` does).

What it will **not** clean up:

- `players` — `group_members.player_id` and `league_scores.player_id` are plain `TEXT` columns with **no FK to `players`** (intentional per the comment at the top of `006_players.sql`: *"No FK from group_members/league_scores to keep scope narrow; player_id in those tables remains TEXT"*). Players whose only group membership was the deleted group will be orphaned-but-still-present.
- `player_mappings` / `player_mapping_queue` — no FK to groups.

### 3. Edge Function / RPC for cascading delete

- **No `delete-group` Edge Function exists.** Inventory of `windex-api/supabase/functions/`: `admin-reset`, `compute-money-deltas`, `events`, `generate-payment-requests`, `get-points-analysis`, `get-points-matrix`, `get-standings`, `groups` (GET-only, lines 16–21 reject any non-GET method), `ingest-event-results`, `players`, `review`, `seasons`, `standings-player-history`. None delete a single group.
- **No SQL function/RPC** for cascading group delete (no `CREATE FUNCTION ... delete_group` anywhere in migrations).
- **`admin-reset`** (`functions/admin-reset/index.ts`) is the closest existing thing, but it is a **global wipe** — uses `SUPABASE_SERVICE_ROLE_KEY` to bypass RLS and clears every row from `league_scores`, `league_rounds`, `player_mapping_queue`, `player_mappings`, `group_members`, `players`, `seasons`, `groups`, `sections` in FK-safe order. Not per-group, and not safe for production use against a single league.
- **A `DELETE FROM groups WHERE id = ?` from the admin client would therefore rely solely on FK cascade behavior** documented in §2. As a super-admin authenticated user, RLS would allow it (see §4), and FK cascades would clean up `group_members` / `seasons` / `league_rounds` / `league_scores`.

### 4. RLS — super admin DELETE policies

The brief said "should be from migration 3," but migration `003_scoring_mode_and_override.sql` only touches `league_scores` columns. The actual super-admin DELETE policies were introduced in **`015_rls_overhaul.sql`** (which uses helpers from `014_permissions.sql`: `am_i_super_admin()`, `am_i_group_admin(gid)`, `am_i_group_member(gid)`).

Confirmed DELETE policies on the audit-relevant tables:

| Table | Policy | `USING` clause |
|---|---|---|
| `groups` | `groups_delete` | `am_i_super_admin()` — **super admin only** |
| `group_members` | `group_members_delete` | `am_i_super_admin() OR am_i_group_admin(group_id)` — super admin or that group's admin |
| `seasons` | `seasons_delete` | `am_i_super_admin()` — super admin only |
| `league_rounds` | `league_rounds_delete` | `am_i_super_admin() OR am_i_group_admin(group_id)` |
| `league_scores` | `league_scores_delete` | super admin OR group admin of the round's group (via `EXISTS` join on `league_rounds`) |
| `players` | `players_delete` | `am_i_super_admin()` |
| `sections` | `sections_delete` | `am_i_super_admin()` |

So both required policies (super admin DELETE on `groups` and on `group_members`) **do exist** — just in migration 015, not migration 3. RLS will not block a super admin from issuing `DELETE FROM groups WHERE id = ?` directly via PostgREST or the Supabase client.

### Summary — what's missing if we want a "Delete Group" / "Remove Member" feature

1. **No admin UI affordance** for either operation. UI work would be net-new on `Groups.tsx` / `GroupDetail.tsx` (group delete) and `Players.tsx` (member remove vs. existing soft-toggle).
2. **No backend endpoint or RPC.** Two viable paths: (a) call `DELETE` directly via PostgREST and let FK cascades + RLS do the work, or (b) add an Edge Function for safety (confirm-by-name, audit log, orphan-player cleanup).
3. **Orphan player risk.** Cascade deletes `group_members` rows but does not touch `players`. If a player exists in only one group, after delete they remain in `players` with no membership. Decide whether that's acceptable (it's the current implicit behavior of `admin-reset` reversed) or whether the delete flow should also prune zero-membership players.
4. **`league_scores.player_id` and `group_members.player_id` are TEXT, not FK.** Any future "delete player" feature would need an explicit cleanup step; not relevant for group/member delete but worth flagging because related work on this surface will run into it.

### Resolution — implemented 2026-05-07 (option 1: group-only delete, orphans left in place)

A super-admin-only "Delete Group" capability was added to the admin UI on `/groups/:id`:

- **Files modified / added**
  - `windex-admin/src/components/ConfirmModal.tsx` *(new)* — generic destructive-action modal (Esc-to-cancel, backdrop-click-to-cancel, in-modal error surface).
  - `windex-admin/src/api/groups.ts` — added `isCurrentUserSuperAdmin()` (calls the `am_i_super_admin()` RPC from migration `014_permissions.sql`), `getGroupDeleteCounts(groupId)` (parallel `Prefer: count=exact` queries on `group_members`, `seasons`, `league_rounds`, plus a derived `league_scores` count via `league_round_id=in.(...)`), and `deleteGroup(groupId)` (single `DELETE` against `/rest/v1/groups`).
  - `windex-admin/src/pages/GroupDetail.tsx` — added a `DangerZone` section that renders only when `isCurrentUserSuperAdmin()` returns `true`. Click → modal showing the group name, the four cascade counts, the orphan-player caveat, and an irreversibility warning. Confirm → `DELETE` → navigate to `/groups` with a flash state.
  - `windex-admin/src/pages/Groups.tsx` — reads `location.state.flash` once on mount and shows a `ConfirmToast`, then strips the state via `navigate(..., { replace: true })` so back/forward doesn't re-trigger the toast.

- **Delete mechanics:** unchanged from the audit — a single `DELETE FROM groups WHERE id = ?` via PostgREST. FK `ON DELETE CASCADE` cleans up `group_members`, `seasons`, `league_rounds`, and (transitively via rounds) `league_scores`. RLS policy `groups_delete = am_i_super_admin()` from migration 015 gates the operation. **Player records are intentionally not touched** — orphans by design, surfaced in the modal copy.
- **Not implemented:** member-removal hard-delete on `/players` (still soft-toggle of `is_active`); delete action on the `/groups` list page (detail-only per spec).

---

## Recent changes / project log

- **[2026-05-09] Unified Add-Player flow with auth auto-linking (windex-api + windex-admin).** New `invite-player` Edge Function (super-admin gated; `verify_jwt = false` matching project pattern, JWT verified handler-side via `am_i_super_admin()` RPC) creates a `players` row, optionally fires an OTP invite via `supabase.auth.admin.inviteUserByEmail` (`redirectTo: https://windexgolf.com`), and assigns the player to one or more groups with per-group role. Migration `020_player_invite_and_auth_link.sql` does three things: (a) drops the legacy composite PK on `players`, makes `user_id` nullable, FK switches to `ON DELETE SET NULL` — required so a player row can exist before the auth user does; (b) adds `link_player_on_auth_signup()` SECURITY DEFINER trigger on `auth.users` AFTER INSERT that links a pending players row by email match (case-insensitive, oldest-by-`created_at` wins on multi-match with a `RAISE NOTICE` warning); (c) one-time backfill UPDATE to link any pre-existing email matches at deploy time. Admin UI: `+ Add Player` button + `<AddPlayerModal />` on `windex-admin/src/pages/Players.tsx`, gated by `isCurrentUserSuperAdmin()` (matches the GroupDetail Danger Zone pattern). Modal validates display_name + email format, checkbox for "send invite", multi-select group list with per-row admin/member dropdown. 409 duplicate-email is surfaced as a typed `DuplicatePlayerEmailError` with the existing player id. Partial-failure rollback: if `group_members` insert fails after `players` insert succeeds, the orphan player row is deleted before the error returns. Player IDs generated as 20-char `[A-Za-z0-9]` to match the historical Glide row-id shape; `group_members.id` is the deterministic `gm_<group>_<player>` shape used by `sync-glide-members.mjs` and `generate-seed-bundle.mjs`. The trigger is the **first** `auth.users` trigger ever in this project — there has never been a `handle_new_user` trigger, despite an earlier version of this doc claiming otherwise. **Glide imports are retired** (one-time launch migration, complete); going forward, new player onboarding goes exclusively through this Add Player flow. Files: `windex-api/supabase/migrations/020_player_invite_and_auth_link.sql` *(new)*, `windex-api/supabase/functions/invite-player/index.ts` *(new)*, `windex-api/supabase/config.toml`, `windex-admin/src/components/AddPlayerModal.tsx` *(new)*, `windex-admin/src/api/playerAdmin.ts`, `windex-admin/src/pages/Players.tsx`.
- **[2026-05-09] Phone-only group picker — now lives in the centered header title (`windex-expo`).** Picker placement was moved from a separate row between `<Header />` and `<GroupBanner />` into the green header itself. The combined title now reads `Standings ▾ Windex Cup` (multi-membership), `Standings · Windex Cup` (single membership, static), or just `Standings` (desktop / no-membership), centered between the hamburger and the right-spacer. Implementation choice: `Header.tsx` was widened to accept `title: string | ReactNode`, and `GroupPicker` was rewritten to take a `tabName` prop and *always* render — desktop returns a plain centered title, phone single-membership returns "tab · group" static, phone multi returns the pressable `tab ▾ group` unit + modal. Tab files now compose `<Header title={<GroupPicker tabName="…" />} />`; the standalone picker line was removed. The whole combined unit is the tap target on multi-membership (not just the chevron). Long group names truncate with ellipsis inside the centered slot rather than pushing the hamburger off-screen. Picker is still gated to `useWindowDimensions().width < 768`. Group list, `joined_at` ordering, default-selection chain, persistence, drawer single-source-of-truth — all unchanged from earlier 2026-05-09 commits. Files: `components/Header.tsx`, `components/GroupPicker.tsx`, `app/(tabs)/{standings,rounds,analysis}.tsx`. Earlier history below.
- **[2026-05-09, superseded above] Phone-only group picker, original placement.** First landed as a separate `<GroupPicker />` row between header and banner on all three tabs. Same group list, ordering, persistence, and breakpoint gating as the current header-title placement. Replaced with the in-header version on the same day for tighter vertical space. Files (initial): `components/GroupPicker.tsx` *(new)*, `lib/userPrefs.ts` *(new)*, `contexts/AuthContext.tsx`, `contexts/GroupContext.tsx`, `components/Drawer.tsx`, `app/(tabs)/{standings,rounds,analysis}.tsx`. Schema note: `group_members.joined_at` already existed (`TIMESTAMPTZ NOT NULL DEFAULT now()`, migration 001); no schema change was needed.
- **[2026-05-05] Renamed Late Add v2 → Windex** — code, config, UI strings, folder paths, GitHub repo. Domain stays `lateaddgolf.com` until a separate cutover session. Vercel project Root Directory updated to `windex-expo`. Bundle IDs added (`com.buzzstryker.windex`) for future native builds. Branch: `rename/late-add-to-windex`. Commits: `5623efd` (backend cleanup), `e68787b` (code/config), `0a5c2fe` (UI strings), `96195cf` (subfolder rename). PR #1 (squash-merged to master at `6afafe1`). Parent folder rename `Desktop\Projects\late-add-v2\` → `Desktop\Projects\windex\` deferred to post-session `rename-windex.bat` (Phase 8).
- **[Earlier 2026-05-04, pre-rename]** — `chore(api): trigger ignoreCommand skip test` (`d805a18`); `chore(vercel): skip web rebuilds for commits that don't touch late-add-expo` (`d799e48`); `chore(branding): swap Expo template icon/favicon for Late Add brand assets` (`46fbac6`); `fix: surface score-save errors, hide stack header on player route, extract RoundCard` (`1d408b0`); `chore: gitignore .vercel, .env*.local, .claude/` (`c6d3137`).
