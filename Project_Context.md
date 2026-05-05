# Project Context — Windex

*Created from `Project_Context_TEMPLATE.md` during the Late Add v2 → Windex rename, 2026-05-05.*

---

## What this project is

Windex (formerly **Late Add v2**) is a **points ledger + standings aggregation platform for golf**. It maintains groups (leagues), seasons, players, and per-round point totals; aggregates standings; and optionally generates settlement / Venmo payment-request output. Windex does **not** compute golf competition formats (Stableford, match play, best ball, skins, etc.); external apps or human admins determine the points, and Windex stores, attributes, audits, and aggregates them. The platform exposes an API so any third-party golf app (e.g. Scorekeeper, 18Birdies) can submit results, and ships its own admin UI and player-facing PWA. The only umbrella platform is being rebranded; specific in-platform groups (e.g. "Windex Cup") keep their names.

## Stack

- **Mobile / PWA:** Expo SDK 54, React 19, React Native 0.81, Expo Router 6 (`windex-expo/`). Web build via `npx expo export --platform web`. iOS/Android via Expo Go for dev; native production builds out of current scope.
- **Admin web UI:** Vite 5, React 18, React Router 6 (`windex-admin/`). Internal tool for league admins.
- **Backend / API:** Supabase Cloud — Postgres 15 + Auth + Edge Functions (Deno) (`windex-api/`). 15 Edge Functions; 19 numbered SQL migrations.
- **Hosting:** Vercel — auto-deploys `windex-expo/` to `app.lateaddgolf.com` from `master`. Vercel `ignoreCommand` skips builds when commits don't touch the deployed folder.
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
- **Bulk user creation via `admin.createUser`, never `inviteUserByEmail`.** Avoids Supabase's 2/hour invite rate limit. 19 launch users created in seconds with zero emails sent; the `handle_new_user` trigger populates the linked `players` row from `user_metadata`.
- **Three-folder repo layout, single Vercel deploy target.** Mobile/PWA, admin UI, and backend/scripts coexist in one repo to keep the data model, types, and migrations co-located. Only `windex-expo/` deploys to Vercel today; `windex-admin/` is currently expected to be run locally.

## Live URLs

- **Production (PWA):** https://app.lateaddgolf.com — still on the `lateaddgolf.com` domain post-rename. **Domain cutover to `windexgolf.com` is a separate session, not yet scheduled.**
- **GitHub repo:** https://github.com/buzzstryker/windex
- **Supabase project ID (ref):** `ftmqzxykwcccocogkjhc` (URL: `https://ftmqzxykwcccocogkjhc.supabase.co`). Project ref unchanged across the rename.
- **Vercel project name:** `late-add-v2` (still — rename of the Vercel project is deferred; it doesn't affect production URL or the build, only the auto-generated `*.vercel.app` preview URLs). Project's **Root Directory** setting was updated `late-add-expo` → `windex-expo` on 2026-05-05 alongside the folder rename.
- **Supabase auth additional_redirect_urls:** `https://app.lateaddgolf.com/**` and `https://late-add-v2.vercel.app/**` (the second one tracks the Vercel-project name and gets revisited when the Vercel project is renamed).

---

## Working agreement with Claude

**All Claude Code prompts drafted in this project must enforce the following sections of `Buzz_Project_Development_Procedure.md` (kept at `C:\Users\buzzs\OneDrive\Desktop\Projects\Buzz_Project_Development_Procedure.md`):**

- **3.2a — Working-tree hygiene.** Every Claude Code session ends with a clean `git status`. No "I'll commit this later." Backend deploys (Supabase migrations, Edge Functions) and the corresponding git commits are paired operations.
- **3.2b — Backend deploys are git operations.** Any `npx supabase db query`, `npx supabase functions deploy`, or `npx vercel env add` must be followed by a git commit of the source in the same session.
- **4.1a — Path-filter Vercel deploys.** This project deploys to Vercel from `windex-expo/`; the project's `vercel.json` includes `"ignoreCommand": "git diff --quiet HEAD^ HEAD -- ."` so commits outside that folder don't trigger rebuilds.

When drafting prompts for Claude Code, include verifications for these rules where relevant — e.g. "verify clean working tree before starting," "commit any backend deploy source in the same session," etc.

---

## Recent changes / project log

- **[2026-05-05] Renamed Late Add v2 → Windex** — code, config, UI strings, folder paths, GitHub repo. Domain stays `lateaddgolf.com` until a separate cutover session. Vercel project Root Directory updated to `windex-expo`. Bundle IDs added (`com.buzzstryker.windex`) for future native builds. Branch: `rename/late-add-to-windex`. Commits: `5623efd` (backend cleanup), `e68787b` (code/config), `0a5c2fe` (UI strings), `96195cf` (subfolder rename). PR #1 (squash-merged to master at <hash to be filled in after Phase 7>). Parent folder rename `Desktop\Projects\late-add-v2\` → `Desktop\Projects\windex\` deferred to post-session `rename-windex.bat` (Phase 8).
- **[Earlier 2026-05-04, pre-rename]** — `chore(api): trigger ignoreCommand skip test` (`d805a18`); `chore(vercel): skip web rebuilds for commits that don't touch late-add-expo` (`d799e48`); `chore(branding): swap Expo template icon/favicon for Late Add brand assets` (`46fbac6`); `fix: surface score-save errors, hide stack header on player route, extract RoundCard` (`1d408b0`); `chore: gitignore .vercel, .env*.local, .claude/` (`c6d3137`).
