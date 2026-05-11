# Windex — Backlog

- **Vercel password protection on `admin.windexgolf.com` (defense-in-depth, optional).** Today the admin app at `admin.windexgolf.com` is publicly reachable; security is enforced by Supabase RLS (every admin-only operation is gated by `am_i_super_admin()` or per-table policies). That's correct and sufficient — the URL itself doesn't grant access to anything. Vercel offers "Password Protection" as an add-on (Pro plan and up) that puts a password wall in front of the deploy, before users even see the login page. Reasons we'd want it: (a) reduce the surface area for opportunistic discovery / bot scanning; (b) avoid load on the Supabase auth endpoint from drive-by traffic; (c) make the audit log cleaner by not capturing failed-OTP attempts from randos who Google'd "site:vercel.app admin". One-checkbox setting in the Vercel project dashboard once enabled. Cost is a single shared password; not worth it today (low traffic, no signals of abuse) but cheap to flip on if anything shifts.

- **Cup Champion per season — phone app display + admin manual input.** Manually-recorded per-season Cup Champion (separate from the auto-computed points standings winner). Two surfaces and one schema change.

  - **Phone app (`windex-expo`)** — on the GroupDetail "Previous Seasons" section: add a "Cup Champion" column displaying the manually-recorded champion's `display_name`, or "—" if none recorded. **Remove** the existing date-range hint column (`start_date` / `end_date`). **Keep** the existing Points Standings winner + Points total columns as-is. Applies to **all groups**, not just Windex Cup — every group's Previous Seasons section gets the new column.

  - **Admin UI (`windex-admin`)** — manual input flow. **Open question** to decide at build time: standalone "Cup Champions" tab in the nav, OR fold into the existing GroupDetail Seasons section as a "Set Cup Champion" action per season row? Folding into GroupDetail is probably cleaner since it co-locates the champion with the season; standalone tab is simpler navigation. Form: for a given season, pick a player from the group's members. Save. Optional notes field (e.g. "decided via 18-hole match play playoff"). Super admin only (matches the rest of the admin app).

  - **Schema changes** (new migration when built). Add to `seasons` table:
    - `cup_champion_player_id TEXT NULL REFERENCES public.players(id) ON DELETE SET NULL`
    - `cup_champion_notes TEXT NULL`

    Nullable because (a) the current season has no champion yet, (b) older seasons may never get one designated, (c) leagues that don't run a Cup-style competition can leave it null.

  - **Design decisions to lock down at build time:**
    - Whether the phone app shows current-season Cup Champion at all (probably not — it's an end-of-season thing; or show "TBD" if you want a placeholder visible).
    - Whether the points-winner is auto-computed and stored vs computed on the fly; if the latter, Cup Champion is the only manually-stored field.
    - Whether to log Cup Champion assignments in `user_events` for audit (probably yes given the manual nature — `championship_assigned` event type).

  - **Scope guard**: one feature, two surfaces, one schema change. Do **not** expand into Cup runner-up, multi-place rankings, or other tournament metadata unless explicitly asked.

- **Leap-year drift in season-rollover dates (low priority, cosmetic):** `ensure_next_season_for_group()` (migration 021) computes `next_end = next_start + INTERVAL '1 year' - INTERVAL '1 day'`. When `next_start` is March 1 of a year following a leap year (or any date crossing a Feb-29 boundary), Postgres `+ INTERVAL '1 year'` truncates to the last valid day of February, which makes the resulting `end_date` drift back one day. For golf league seasons this is invisible — Windex Cup's Dec-Nov and YC Windex's Sept-Aug never cross Feb-29 in their start_date. Flagged in case Windex ever picks up a group whose start_date IS in March, in which case we'd want to switch to month-based arithmetic instead.

- ~~**Activity viewer in windex-admin — covers both login_events and user_events.**~~ **Done 2026-05-11.** "App Activity" admin tab at `/activity` (list) and `/activity/:player_id` (detail) consumes the `public.activity_events` view (migration 024) plus three RPC helpers (`get_players_with_last_activity`, `get_player_activity_timeline`, `get_player_activity_summary`). Token refresh is excluded at the view level. Super-admin gated via `isCurrentUserSuperAdmin()` + RLS on the underlying tables. Naive "views per group" queries on user_events should filter `event_type = 'view_leaderboard'` explicitly, because a group switch fires `group_switch` + a view_* event per currently-mounted tab — documented in `windex-expo/lib/userEvents.ts` header.

- ~~**Manual linking after each Glide import:**~~ **Obsolete — Glide imports are retired** (one-time launch migration, complete). New player onboarding is exclusively via the unified Add Player flow on `windex-admin/Players.tsx` (`+ Add Player` button → `invite-player` Edge Function), which also auto-links the auth user via the `link_player_on_auth_signup` trigger added in migration 020 (2026-05-09). The `windex-api/scripts/sync-glide-members.mjs` and friends are kept for historical reference only.

- ~~**Pre-existing Players.tsx edit bug (low priority):**~~ **Done 2026-05-09.** `updatePlayer()` now PATCHes by `id` only and relies on RLS (`players_update`: super admin OR owning user) for permissions. The `userId` parameter was removed from the function signature; the sole call site in `Players.tsx#handleSave` was updated to match.

- **Future access-control review:** Evaluate whether round-level actions should authorize by `league_rounds.user_id` or by group-based permissions derived from membership/role in the associated group.

- **Scorekeeper integration:** When Scorekeeper is ready, wire up `POST /ingest-event-results` as the submission target after a round is scored. Requirements:
  - Player ID mapping between Scorekeeper and Windex (use `player_mappings` table with `source_app = "scorekeeper"`)
  - Use `source_app = "scorekeeper"` and `external_event_id` for idempotency (prevents duplicate rounds)
  - Send `game_points` per player — Windex computes the head-to-head differential (`score_value = N × game_points - round_total`) server-side
  - Reference `shared-golf-types` for shared player/round TypeScript types
  - Scorekeeper does NOT need to compute standings or differentials — Windex handles all aggregation
  - Test with the adapter pattern in `windex-api/adapters/` and `docs/SOURCE_ADAPTERS.md`

- ~~**Round edit/delete permission enforcement:**~~ **Done.** Edit/delete buttons on Round Detail are now hidden for members. `GroupContext` resolves `isSuperAdmin` and `isGroupAdmin(groupId)` on login via RPC. Backend RLS enforces at DB level as backup.

- **Migrate `dev@lateaddgolf.com` auth user to `dev@windexgolf.com`:** The Supabase Auth user with email `dev@lateaddgolf.com` (UUID `c49d7e41-...`) owns all bulk-created players and is hardcoded as the admin login pre-fill. Migration steps:
  1. Create new Supabase auth user with email `dev@windexgolf.com` (via dashboard or `admin.createUser`)
  2. Migrate data tied to the old user's UUID — primarily `players.user_id` rows (likely the bulk-created roster); audit other tables with `user_id` FKs (`groups`, `sections`, `league_rounds`, etc.) for any rows owned by the old UUID
  3. Update the 5 code/doc references inventoried in the 2026-05-05 cutover Phase 5 Group E:
     - `Windex_Permissions_Spec.md:22`
     - `windex-admin/src/pages/Login.tsx:20`
     - `windex-admin/README.md:33`
     - `windex-admin/README.md:40`
     - `windex-admin/README.md:59`
  4. Delete the old auth user once data migration is verified
  5. Coordinate with `lateaddgolf.com` email DNS/MX cleanup if/when that happens (currently MX records are unchanged so the old email still receives mail)

- **Re-skin olive-green UI to Windex deep-blue brand:** The Windex icon, splash, and OTP-email heading use deep blue `#091648`, but the in-app UI is still olive green `#4B5E2A` throughout (12+ hardcoded sites: `windex-expo/constants/theme.ts`, `Drawer.tsx`, `AddRoundModal.tsx`, `HistoryChart.tsx`, multiple route files in `app/`). Out-of-scope for the 2026-05-05 domain cutover; visual mismatch (deep-blue chrome + olive-green UI) is expected until this lands. **This is a multi-day design task, not a one-liner:** new palette decision (primary, accent, text-on-color combinations), `theme.ts` refactor (extract every hardcoded `#4B5E2A` to a token), component-by-component visual audit, light/dark mode testing, accessibility contrast checks, and `Windex_UI_Architecture.md:77` doc update once the new palette is in place.
