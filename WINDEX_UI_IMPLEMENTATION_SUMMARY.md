# Windex Admin UI — Implementation Summary

Summary of the first usable admin UI in **`windex-admin/`** (Vite + React) in this directory. No backend or Scorekeeper app code was changed.

---

## 1. Routes added

| Route | Purpose |
|-------|---------|
| `/` | Redirects to `/dashboard`. |
| `/login` | Sign-in: email/password (default) or paste JWT tab. |
| `/dashboard` | Operational snapshot: summary cards, recent rounds, Attention Required. Dev tools: Reset & Import All, Import New Rounds. |
| `/events` | **Rounds** list with filters and sorting (played date, game points). Signature Event star toggle per round. |
| `/events/new` | **Round Entry** — manual round creation form. |
| `/events/:eventId` | Round detail: metadata, status, results, links to edit and review. |
| `/events/:eventId/edit` | Round edit / override form. |
| `/review/attribution` | **Attribution Review** — queue and resolution. |
| `/review/player-mapping` | **Player Mapping** — queue and resolution. |
| `/standings` | Standings — Group + Season selectors; points-only table with player drilldown. |
| `/groups` | Groups list. |
| `/groups/:groupId` | Group detail with seasons list. |
| `/players` | **Players** — view and edit player data by group (name, email, Venmo, role, active). |
| `/analytics/points` | **Points Analysis** — all-vs-all matrix via `GET /get-points-matrix`, head-to-head drill-down via `GET /get-points-analysis`. All computation server-side. Worst matchups with player filter. Season filter (2023+), Exclude Signature Events toggle. |

---

## 2. Components added

- **Layout** — Nav bar (Dashboard, Rounds, Round Entry, Standings, Groups, Players, Points Analysis, Attribution Review, Player Mapping) + Sign in / Sign out + outlet.
- **PageHeader** — Title, optional subtitle, optional action slot.
- **StatusBadge** — Normalized status (processed, pending_attribution, pending_player_mapping, validation_error, duplicate_ignored).
- **DataTable** — Generic table with columns (key, label, optional render), row click optional.
- **FilterBar** — Wrapper for filter controls.
- **EmptyState** — Message + optional action.
- **ErrorState** — Message + optional Retry.
- **LoadingSpinner** — Centered spinner.
- **ConfirmToast** — Temporary success toast.
- **FormSection** — Optional title + children for forms.

---

## 3. Forms added

- **Round entry** (`/events/new`) — Group (required), Season (optional), Played date (required), Source app `manual`, dynamic list of player_id + game_points; server computes score_value via head-to-head formula (`N × game_points - round_total`). Submit calls `POST /ingest-event-results`. Expo app: Add Round bottom sheet on Rounds tab with player chip selector.
- **Round edit** (`/events/:eventId/edit`) — Played date, Season ID, results table (score_value, score_override); submit calls `PATCH /events/:eventId` (see backend gaps).
- **Attribution resolution** — Inline on Attribution Review: Group ID (required), Season ID (optional); submit calls `POST /review/attribution/:id/resolve`.
- **Player mapping resolution** — Inline on Player Mapping: Windex player ID (required), optional suggestions; submit calls `POST /review/player-mapping/:id/resolve`.

---

## 4. API assumptions

- **Base URL** — From `VITE_LATE_ADD_API_URL` (default `https://ftmqzxykwcccocogkjhc.supabase.co/functions/v1`). All requests use `Authorization: Bearer <JWT>` when token is set (see `api/client.ts`).
- **Documented and used**  
  - `POST /ingest-event-results` — Used for manual round entry and matches windex-api contract.  
  - `GET /get-standings?season_id=&group_id=` — Used for Standings screen.
- **Assumed for UI to work** (may not exist yet in windex-api):  
  - `GET /events` — List events (query: group_id, season_id, source_app, status, from_date, to_date).  
  - `GET /events/:eventId` — Event detail with results.  
  - `GET /groups` — List groups.  
  - `GET /seasons` or `GET /seasons?group_id=` — List seasons.  
  - `GET /review/attribution` — List unresolved attribution items.  
  - `POST /review/attribution/:id/resolve` — Body: `{ group_id, season_id? }`.  
  - `GET /review/player-mapping` — List unresolved player mapping items.  
  - `POST /review/player-mapping/:id/resolve` — Body: `{ player_id }`.  
  - `PATCH /events/:eventId` — Update event metadata and/or results (see backend gaps).

If list/detail/review endpoints are missing, the UI will show empty lists or errors until windex-api adds them (or exposes equivalent data via PostgREST).

---

## 5. Backend gaps that block or weaken the UI

- **Events list and event detail** — If `GET /events` and `GET /events/:eventId` are not implemented, the Dashboard “Recent events” and the Events screen cannot show data. The UI composes from these; no client-side fallback.
- **Groups and seasons list** — If `GET /groups` and `GET /seasons` are missing, Standings and Round entry cannot populate group/season selectors; Round entry would be blocked.
- **Attribution review** — If `GET /review/attribution` and `POST /review/attribution/:id/resolve` do not exist, the Attribution Review screen stays empty and resolution is impossible.
- **Player mapping** — If `GET /review/player-mapping` and `POST /review/player-mapping/:id/resolve` do not exist, the Player Mapping screen stays empty and mapping is impossible.
- **Round update** — If `PATCH /events/:eventId` (or equivalent) is not implemented, Round edit will fail on save. The UI does not invent an alternative; the backend should define the update contract (allowed fields, validation, audit if any).

Recommendation: Add the above endpoints (or equivalent PostgREST usage) in windex-api and document them in `docs/api.md`. The admin UI is built to call these paths and body shapes.

---

## 6. Documentation updates

- **Windex_Screen_Map.md** — Updated to state three ways events enter (API ingestion, manual entry, round edit/override); added Dashboard, Events, Event detail, Round entry, Round edit, Attribution review, Player mapping, Standings; normalized status values; added flows.
- **Windex_UI_Architecture.md** — Updated UI goals (manual entry and round override as first-class); application structure and routing; API interaction (manual creation, update); shared UI requirements and status design.
- **README.md** (this directory) — Noted that the first usable admin UI lives in `windex-admin/` and supports API ingestion, manual round entry, and round edit/override.

---

## 7. Where the code lives

- **App and routing:** `windex-admin/src/App.tsx`, `main.tsx`, `components/Layout.tsx`
- **Pages:** `windex-admin/src/pages/` (Login, Dashboard, Events, EventDetail, RoundEntry, RoundEdit, AttributionReview, PlayerMapping, Standings, Groups, GroupDetail)
- **API:** `windex-admin/src/api/` (client, events, standings, groups, attribution, playerMapping)
- **Types:** `windex-admin/src/types/index.ts`
- **Shared components:** `windex-admin/src/components/`

To run: `cd windex-admin && npm install && npm run dev` (see `windex-admin/README.md`).

---

## 8. Deliverables summary (product requirement alignment)

| Deliverable | Status |
|-------------|--------|
| **1. Admin UI screens** | Dashboard, Events (list + detail), Attribution Review, Player Mapping, Standings, Round Entry (`/events/new`), Round Edit/Override (`/events/:eventId/edit`). Plus Login, Groups, Group detail. |
| **2. Shared components** | PageHeader, StatusBadge, DataTable, FilterBar, EmptyState, ErrorState, LoadingSpinner, ConfirmToast, FormSection. |
| **3. Routing** | `/dashboard`, `/events`, `/events/new`, `/events/:eventId`, `/events/:eventId/edit`, `/review/attribution`, `/review/player-mapping`, `/standings`, `/groups`, `/groups/:groupId`, `/login`. |
| **4. API assumptions** | See section 4 above. Ingest and get-standings are documented; list/detail/review/update are assumed and documented as backend gaps if missing. |
| **5. Backend gaps** | See section 5 above. GET events, GET event detail, GET groups, GET seasons, review endpoints, PATCH event must exist or be added for full UI operation. |
| **Product rule** | Manual entry and ingested rounds converge into the same canonical event/result model; no manual-only logic in UI beyond source labeling. Standings, attribution, validation, recalculation remain backend responsibilities. Docs updated: Screen Map (core product rule), UI Architecture (product requirement). |
