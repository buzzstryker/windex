# Windex

**Windex and Scorekeeper are separate apps.** Windex is its own product: a **points ledger + standings aggregation platform** for golf, with its own API and (in progress) UI. Windex does not compute golf competition formats (e.g. Stableford, match play, best ball, skins); external systems or human admins determine points. Scorekeeper is a separate golf scoring app and may use the Windex API to submit rounds; that is Scorekeeper’s only relation to Windex. **This directory** (`Desktop\windex`) holds the Windex documentation, admin UI, API, and mobile app: **`late-add-api/`** (Supabase backend), **`late-add-admin/`** (Vite + React admin web UI), **`late-add-expo/`** (Expo app — web via `expo start --web`, iOS/iPad via Expo Go), root-level product docs, **`patches/`** (WIP patches), and **`glide-export/`** (Glide ODS export).

Windex exposes an API so that **any** third-party golf app (e.g. Scorekeeper, 18Birdies, or others) can submit round results and consume standings and settlement data. Windex does not run the round or capture scores itself; it ingests **points and results** from external sources and maintains groups, seasons, standings, and optional payout/settlement outputs.

**Status:** Project is in progress. Backend and API are implemented; the team is moving into **UI work** for the Windex app experience.

### Recommended testing order

1. **Web admin UI first** — Run **`late-add-admin/`** against your API (local or hosted). Confirm flows, data, and auth there before moving on.
2. **Then mobile (iPad / iPhone)** — After the web UI checks out, exercise the same backend through **`late-add-expo/`** (Expo Go). The mobile app is a thinner client; fixing issues in admin first avoids chasing device-only problems when the API or data is wrong.

**Mobile (Expo Go):** From this repo folder run `npm install` once inside `late-add-expo`, then from **there** run `npx expo start --tunnel` to open the app on iPhone/iPad with Expo Go. Details: [late-add-expo/README.md](./late-add-expo/README.md).

### How the docs are organized

All Windex documentation lives in this folder. Start here for overview and terminology; use the links below for specific topics.

| Topic | Document |
|-------|----------|
| **Overview, status, terminology** | This file (README.md) |
| **Current architecture** | [Current architecture (what is built)](#current-architecture-what-is-built) (section below) |
| **API** | [Windex_API_Spec.md](./Windex_API_Spec.md) |
| **Data model** | [Windex_Data_Model.md](./Windex_Data_Model.md) |
| **Screen map** | [Windex_Screen_Map.md](./Windex_Screen_Map.md) |
| **UI architecture** | [Windex_UI_Architecture.md](./Windex_UI_Architecture.md) |
| **Backlog** | [BACKLOG.md](./BACKLOG.md) |
| **Product goals & scope** | [Windex_Master_Spec.md](./Windex_Master_Spec.md) |

Full doc index: [Doc index (this folder)](#doc-index-this-folder) at the end of this file.

---

## What Windex is

- **Standalone product** — Its own app and API; a separate codebase from Scorekeeper and from any source app that calls the API.
- **API-first ingestion** — External golf apps (sources) or admins submit event results (final point totals per player); Windex stores them, attributes them to groups/seasons, and aggregates them into standings; when configured, computes money deltas and generates payment requests.
- **Points ledger + standings aggregation platform** — Atomic point records (one per player per round in `league_scores`) are the single source of truth; standings are **derived** from those records only and are never edited directly. Groups, seasons, events (rounds), and results; points-only standings from the ledger; optional group-level payout config and round-scoped payment request generation. Windex does **not** compute golf formats (Stableford, match play, best ball, skins, etc.) and does **not** track payment completion or maintain a settlement ledger.

---

## Core product model

| Concept | Description |
|--------|--------------|
| **Source app** | Any client that can call the Windex API (e.g. Scorekeeper, 18Birdies). Submits results for a **group** and **round date**; optionally identifies the event for idempotency. |
| **Windex** | Points ledger + standings aggregation platform. Atomic point records (one per player per round) in `league_scores`; standings are derived from those records only (never edited directly). Holds groups, seasons, events (rounds), and results; optionally computes per-round money deltas and generates payment requests. Does not compute golf competition formats; does not run rounds or capture scores. |
| **Attribution** | Each ingested event can carry `source_app` and `external_event_id` so rounds are attributable and idempotent when the same event is submitted again. |

---

## Major system areas

- **Backend / API** — In **`late-add-api/`** in this directory. Supabase (Postgres, Auth, Edge Functions). Endpoints: ingest event results, get standings, compute money deltas (round-scoped), generate payment requests (round-scoped). Full contract: [late-add-api/docs/api.md](./late-add-api/docs/api.md).
- **Ingestion** — Accept POSTs with `group_id`, `round_date`, and `scores[]` (points or win/loss/tie); validate membership and domain rules; create one event (league_round) and one result row per player (league_score). `money_delta` is left to a separate, round-scoped computation step.
- **Standings aggregation** — Standings are **derived only** from the points ledger (`league_scores`); there is no separate mutable standings table. Effective result per ledger row = `COALESCE(score_override, score_value)`. View: rounds_played, total_points per player per season. No money in standings. Payout and payment-request logic are separate and do not affect standings.
- **UI / front end** — Windex app screens: Dashboard, Rounds, Round Entry, Round Edit, Standings, Groups, Players, Points Analysis, Attribution Review, Player Mapping. Admin UI in **`late-add-admin/`** (Vite + React); see that folder’s README. Supports API ingestion, manual round entry, round edit/override, player management, game points analysis (all-vs-all matrix, head-to-head drill-down, Signature Events filtering), and Glide data import. See [Screen Map](./Windex_Screen_Map.md) and [UI Architecture](./Windex_UI_Architecture.md).

---

## Current architecture (what is built)

- **late-add-api** (Windex backend; **`late-add-api/`** in this directory): Supabase project with migrations, RLS, and Edge Functions.
  - **Tables:** sections, groups, group_members, seasons, league_rounds, league_scores. Standings are a view over league_rounds + league_scores (effective points only). Optional: `groups.dollars_per_point` for payout; `league_scores.money_delta` for settlement.
  - **Functions:** `ingest-event-results` (POST), `get-standings` (GET), `compute-money-deltas` (POST, round-scoped), `generate-payment-requests` (POST, round-scoped). Auth: Bearer JWT; access enforced by RLS and round ownership.
  - **Behavior:** Idempotent ingest when `source_app` + `external_event_id` are set; points-only standings; round-scoped money_delta computation when group has payout config; payment requests generated from money_delta (not persisted).
- **Windex docs and admin UI:** This directory (root .md files and **`late-add-admin/`**). Source apps that call the API (e.g. Scorekeeper, 18Birdies) are separate apps.

---

## Next phase: UI work

The next phase is **UI and front-end work** for the Windex app: screens and flows so users can manage groups, seasons, and rounds; view standings; and trigger or view settlement/payment request outputs. Backend and API are in place to support these flows.

---

## UI work starting point

The front end should support the following, backed by the existing API:

1. **Auth** — Sign-in via email OTP (6-digit code) or email/password with Supabase Auth; use the returned JWT for all API calls (Bearer). Player accounts are created by admin via `invite-players.mjs`.
2. **Groups and seasons** — List and manage groups (and sections if used); list seasons per group; create/edit as needed (API for groups/seasons may be extended; currently ingestion and standings are the main implemented endpoints).
3. **Ingestion** — For a chosen group and round date, submit event results (scores array with player_id and points or result_type). Support optional `source_app` and `external_event_id` for idempotency and attribution.
4. **Standings** — For a season (and optional group), call `get-standings` and display points-only standings (rounds_played, total_points). No money in standings.
5. **Rounds / events** — List rounds (events) for a group or season; show which have been ingested and, where relevant, whether money_delta has been computed.
6. **Payout config** — If the product exposes group-level payout: set or edit `dollars_per_point` (or equivalent) so that `compute-money-deltas` can run for a round.
7. **Settlement / payment requests** — For a round: trigger `compute-money-deltas` (if config set), then call `generate-payment-requests` and display the list of payer→payee requests (amount_cents). Do not present payment completion as tracked in Windex; requests are generated on demand and not stored.

Screens and navigation can be designed around these flows; the API contract and error codes are in [late-add-api/docs/api.md](./late-add-api/docs/api.md).

---

## Terminology

| Term | Meaning |
|------|---------|
| **Group** | A league or competition unit (e.g. a group of players). Has optional section; has members (group_members); has seasons. |
| **Season** | A time-bounded competition window for a group (start_date, end_date). Standings are per season. |
| **Event / round** | A single round/event in the system; stored as `league_rounds`. Identified by id; has group_id, optional season_id, round_date. When `source_app` and `external_event_id` are set, ingest is idempotent by (group_id, source_app, external_event_id). |
| **Result** | A single player’s result for an event; stored as `league_scores`. One row per (event, player): points (score_value, optional score_override), optional result_type (win/loss/tie). Effective result = `COALESCE(score_override, score_value)`. |
| **Standings** | Points-only aggregate per player per season: rounds_played, total_points. Derived from events and results; no money. |
| **Source app** | The application or system that submitted an event (e.g. Scorekeeper, 18Birdies). Stored or passed for attribution and idempotency. |
| **Attribution** | Identifying which source app (and optional external_event_id) submitted an event; used for idempotency and traceability. |
| **money_delta** | Per-result dollar amount for settlement (positive = receives, negative = pays). Computed round-scoped by `compute-money-deltas` when group has payout config; used only for generating payment requests, not for standings. |
| **Payment request** | A single payer→payee instruction (from_player_id, to_player_id, amount_cents). Generated by `generate-payment-requests` from money_delta; not persisted by Windex. |

---

## Developer setup

- **late-add-api** (Windex backend): See [late-add-api/README.md](./late-add-api/README.md) and [late-add-api/docs/](./late-add-api/docs/). Typical flow: `cd late-add-api`, `npm install`, copy `.env` from `.env.example`, `supabase login --token <token>`, `supabase link --project-ref ftmqzxykwcccocogkjhc`, `supabase db push`, `supabase functions deploy --no-verify-jwt`, `supabase config push`. We use **Supabase Cloud exclusively** (no local Supabase). The `--no-verify-jwt` flag is required because functions handle auth internally. Run integration/domain tests against the cloud project as documented there.
- **late-add-expo** (web + mobile app): See [late-add-expo/README.md](./late-add-expo/README.md). Web deployment on Vercel at `https://app.lateaddgolf.com`. Auth via email OTP (6-digit code). PWA-ready with home screen icon.
- **late-add-admin** (admin UI): See [late-add-admin/README.md](./late-add-admin/README.md) for first-time setup and per-session instructions.
- **Source apps** (e.g. any golf app that calls the Windex API): Separate codebases; each implements its own client and auth to call the API.
- **Full API contract, validation rules, and error codes**: [late-add-api/docs/](./late-add-api/docs/) (api.md, payout-configuration-design.md, settlement-calculation-design.md).

---

## Testing

- **late-add-api**: Integration tests (`npm run test:integration`) and domain-rule tests (`npm run test:domain`) in **late-add-api/**; run against Supabase Cloud (see that folder’s README).
- **late-add-admin** and **source apps**: Each has its own test setup.

---

## Roadmap / open work

- **UI** — Build out Windex app screens and flows (groups, seasons, ingest, standings, rounds, payout config, payment request display).
- **Groups/seasons API** — Extend or add endpoints for listing and managing groups and seasons if the UI needs them beyond what ingestion and standings provide.
- **Backlog** — [Future access-control review](./BACKLOG.md): Evaluate whether round-level actions should authorize by `league_rounds.user_id` or by group-based permissions derived from membership/role in the associated group.

---

## Doc index (this folder)

| Document | Purpose |
|----------|---------|
| **README.md** (this file) | Overview, status, architecture, UI starting point, terminology, setup, testing, roadmap. |
| [Windex_Master_Spec.md](./Windex_Master_Spec.md) | Product goals and scope (concise). |
| [Windex_Data_Model.md](./Windex_Data_Model.md) | Entities and schema summary. |
| [Windex_API_Spec.md](./Windex_API_Spec.md) | Endpoint summary; full contract in [late-add-api/docs/](./late-add-api/docs/). |
| [Windex_Screen_Map.md](./Windex_Screen_Map.md) | Screens and flows. |
| **late-add-api/** | Backend/API (Supabase). See [late-add-api/README.md](./late-add-api/README.md) to run. Points ledger design: [late-add-api/docs/POINTS_LEDGER_ARCHITECTURE.md](./late-add-api/docs/POINTS_LEDGER_ARCHITECTURE.md). |
| [Windex_UI_Architecture.md](./Windex_UI_Architecture.md) | Front-end structure: goals, areas, routing, API usage, data flow, state, errors, principles. |
| [WINDEX_UI_IMPLEMENTATION_SUMMARY.md](./WINDEX_UI_IMPLEMENTATION_SUMMARY.md) | Admin UI implementation summary: routes, components, forms, API assumptions, backend gaps. |
| [BACKLOG.md](./BACKLOG.md) | Open backlog items (e.g. access-control review). |
| [bootstrap-late-add-api.md](./bootstrap-late-add-api.md) | Bootstrap plan for the API (late-add-api/). |
| [late-add-api.md](./late-add-api.md) | late-add-api folder structure (in this directory). |
| [late-add-api-CLAUDE.md](./late-add-api-CLAUDE.md) | CLAUDE.md template; see [late-add-api/CLAUDE.md](./late-add-api/CLAUDE.md) for the project file. |
| [shared-golf-types.md](./shared-golf-types.md) | Shared TypeScript types package (structure). |
