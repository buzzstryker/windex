# Windex — Backlog

- ~~**Manual linking after each Glide import:**~~ **Obsolete — Glide imports are retired** (one-time launch migration, complete). New player onboarding is exclusively via the unified Add Player flow on `windex-admin/Players.tsx` (`+ Add Player` button → `invite-player` Edge Function), which also auto-links the auth user via the `link_player_on_auth_signup` trigger added in migration 020 (2026-05-09). The `windex-api/scripts/sync-glide-members.mjs` and friends are kept for historical reference only.

- **Pre-existing Players.tsx edit bug (low priority):** The `EditRow` save path calls `updatePlayer(p.id, getCurrentUserId(), …)` which builds a PostgREST WHERE clause `id=eq.<player>&user_id=eq.<currentUserId>`. After migration 020 made `players.user_id` nullable, any newly-created player row that hasn't signed in yet has `user_id IS NULL` and won't match this WHERE clause — so the EditRow PATCH would silently no-op for those players. RLS still permits the update (super admin can update any row), so the fix is to drop the `user_id=eq.…` predicate from `updatePlayer` and rely on RLS for the gate. Out of scope for the Add Player PR; flagged for a follow-up.

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
