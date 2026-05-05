# Windex Admin UI — Implementation Report

Built from the approved Windex UI plan (Screen Map, UI Architecture). Prioritized working routes, navigation, layout, tables, forms, and mutation flows. Windex operates as a **points ledger + standings aggregation platform**: atomic point records in the backend are the single source of truth; standings are derived from those records only (never edited directly). Aggregation and validation remain in the backend (no golf-format calculation in the product).

---

## Routes completed

| Route | Purpose | Status |
|-------|---------|--------|
| `/` | Redirect to `/dashboard` | Done |
| `/login` | Sign-in (JWT paste or continue without token) | Done |
| `/dashboard` | Operational snapshot, recent events, attention required | Done |
| `/events` | Events list with filters (group, source, status, date range) | Done |
| `/events/new` | Manual round entry form | Done |
| `/events/:eventId` | Event detail, links to edit and review flows | Done |
| `/events/:eventId/edit` | Round edit / override form | Done |
| `/review/attribution` | Attribution queue and resolution | Done |
| `/review/player-mapping` | Player mapping queue and resolution | Done |
| `/standings` | Group + Season selectors, standings table (read-only) | Done |
| `/groups` | Groups list | Done |
| `/groups/:groupId` | Group detail with seasons, links to Standings | Done |

---

## Screens completed

| Screen | Route(s) | Behavior |
|--------|----------|----------|
| **Dashboard** | `/dashboard` | Summary (showing latest 15 events, pending attribution, pending player mapping), Attention Required (links to attribution queue, player mapping queue, events with unresolved players), Recent Events table (click → event detail), View all events link. Uses listEvents, listAttributionQueue, listPlayerMappingQueue. |
| **Events** | `/events` | Filterable list (group, source app, processing status, attribution status, from/to date). Columns: event id, external id, source app, played date, group, season, status, attribution (StatusBadge), Received. Row click → event detail. "New round" → `/events/new`. Uses GET /events with optional `attribution_status` when filter set. |
| **Event Detail** | `/events/:eventId` | Source metadata, status and attribution (StatusBadge), unresolved count when partial, mapping_issues with link to Player Mapping, results table (effective points, original when overridden, override value with reason and optional actor/timestamp), Actions (Attribution review, Player mapping, Edit round / override). |
| **Attribution Review** | `/review/attribution` | Queue list from GET /review/attribution; select row (highlighted) → detail panel; group and season dropdowns; submit resolution → POST /review/attribution/:id/resolve; confirmation and refresh. Empty state explains when items appear (ingested without season). |
| **Player Mapping** | `/review/player-mapping` | Queue list; select row (highlighted) → detail panel; choose Windex player (with candidate suggestions), confirm mapping. Empty state explains when items appear (source player not matched). List returns [] if GET /review/player-mapping missing (404). |
| **Standings** | `/standings` | Helper text (select group then season; standings points-only from ledger). Group and Season dropdowns (from GET /groups, GET /seasons). Standings table from GET /get-standings (read-only). **Click a row** to open point-history drilldown (GET standings-player-history): rounds, points per round, override value and reason/actor when present; link to event. Empty state when no season selected or no data. Supports `?group_id=&season_id=` deep link. |
| **Round Entry** | `/events/new` | Form: group, season, played date, source_app = manual, dynamic player/points rows. Submit → POST /ingest-event-results → redirect to event detail. Validation for required fields and at least one player. (Event name field removed; was not sent to API.) |
| **Round Edit / Override** | `/events/:eventId/edit` | Load event; form for played date, season (dropdown for event’s group), results with labeled Points and Override columns; Override reason (required when any override is set) and optional Override actor; existing override reason/actor/timestamp shown when present. Submit → PATCH /events/:eventId with override_actor/override_reason when applicable. Backend updates atomic point records in the ledger; standings are derived from the ledger on next read. |

Additional: **Login** (`/login`), **Groups** (`/groups`), **Group Detail** (`/groups/:groupId`) for navigation and standings deep links.

---

## Components completed

| Component | Purpose |
|-----------|---------|
| **Layout** | Nav (Dashboard, Events, Round entry, Standings, Groups, Attribution review, Player mapping) + Sign in/Sign out + outlet. |
| **PageHeader** | Title, optional subtitle, optional action slot. |
| **StatusBadge** | Normalized status: processed, partial_unresolved_players, pending_attribution, pending_player_mapping, validation_error, duplicate_ignored; attribution: attributed, attribution_resolved. |
| **DataTable** | Generic table: columns (key, label, optional render), getRowKey, optional onRowClick, optional selectedRowKey for row highlight (queue screens). |
| **FilterBar** | Wrapper for filter controls. |
| **EmptyState** | Message + optional detail (e.g. when items would appear) + optional action. |
| **ErrorState** | Message + optional Retry. 404 from API shows "Endpoint not implemented (404): <path>. Add in windex-api or use PostgREST." |
| **LoadingSpinner** | Centered spinner. |
| **ConfirmToast** | Temporary success toast. |
| **FormSection** | Optional title + children for forms. |

---

## Endpoints used

| Endpoint | Used by | Backend status |
|----------|---------|----------------|
| **POST /ingest-event-results** | Round Entry | Implemented (windex-api Edge Function). |
| **GET /get-standings?season_id=&group_id=** | Standings | Implemented; response includes `player_name` when present. |
| **GET /standings-player-history?group_id=&season_id=&player_id=** | Standings drilldown | Implemented (Edge Function `standings-player-history`). Read-only round-level point history for one player in group/season. |
| **GET /groups** | Events filter, Round Entry, Standings, Groups | Implemented (windex-api Edge Function `groups`). |
| **GET /seasons?group_id=** | Round Entry, Standings, Group Detail | Implemented (windex-api Edge Function `seasons`). |
| **GET /events** (with query params) | Dashboard, Events | Implemented (windex-api Edge Function `events`). |
| **GET /events/:eventId** | Event Detail, Round Edit | Implemented; `player_name` populated from canonical `players` when present. |
| **PATCH /events/:eventId** | Round Edit | Implemented (windex-api Edge Function `events`). |
| **GET /players?group_id=** | Round entry player picker, player mapping | Implemented (Edge Function `players`). Optional `group_id` restricts to active group members. |
| **GET /review/attribution** | Dashboard, Attribution Review | Implemented (Edge Function `review`). Returns rounds with `attribution_status = pending_attribution`. |
| **POST /review/attribution/:id/resolve** | Attribution Review | Implemented. Body: `{ "group_id", "season_id"? }`; updates round and sets `attribution_status = attribution_resolved`. |
| **GET /review/player-mapping** | Dashboard, Player Mapping | Implemented (Edge Function `review`). Returns pending queue items. |
| **POST /review/player-mapping/:id/resolve** | Player Mapping | Implemented. Body: `{ "player_id": "<canonical id>" }`; marks item resolved and persists to `player_mappings`. |
| **GET /get-points-matrix?group_id=&exclude_signature_events=** | Points Analysis (matrix) | Implemented. Returns all-vs-all pairwise differential, active players, top 10 worst matchups. All computation server-side. |
| **GET /get-points-analysis?group_id=&player_a_id=&player_b_id=&exclude_signature_events=** | Points Analysis (drill-down) | Implemented. Returns lifetime + per-season breakdown with per-round detail. Filters 2023+ and sig events server-side. |
| **POST /admin-reset** | Dashboard (dev tools) | Implemented. Truncates all data tables using service role key. |

---

## Endpoints missing (backend gaps)

None. All UI-used endpoints are implemented.

**Implemented (windex-api):** GET /groups, GET /seasons, GET /events, GET /events/:eventId, PATCH /events/:eventId, GET /players, get-standings with player_name, GET /review/player-mapping, POST /review/player-mapping/:id/resolve, **GET /review/attribution**, **POST /review/attribution/:id/resolve**. See `windex-api/docs/api.md` and `windex-api/docs/admin-ui-endpoints.md`.

---

## Blockers

1. None. Attribution review is implemented: ingest without `season_id` sets `attribution_status = pending_attribution`; GET/POST /review/attribution provide queue and resolve; UI uses group/season dropdowns and resolve flow.
2. **Player mapping** — Implemented. Backend provides GET /review/player-mapping (queue) and POST /review/player-mapping/:id/resolve; UI loads queue, fetches GET /players for canonical player dropdown, and resolves with selected player_id; queue refreshes after success. Ingest (POST /ingest-event-results) resolves source identity via player_mappings when source_app and per-player source_player_ref/source_player_name are sent; unresolved identities are enqueued (one pending per identity, idempotent). Event-level processing status (processed / partial_unresolved_players) is persisted and exposed in GET /events and GET /events/:id; Dashboard and Events list show real status; Event detail shows unresolved count and links to Player Mapping.
3. No other current blockers: GET /groups, GET /seasons, GET /events, GET /events/:id, PATCH /events/:id, and player-mapping review are implemented. With Supabase Cloud and imported data, Dashboard, Rounds, Round Entry, Round Edit, Standings, Groups, Players, Points Analysis, and Player Mapping work with real data.

---

## Recommended next build step

1. **UI (optional)**  
   Further polish as needed. Override reason/details are now surfaced: Event Detail and Standings drilldown show reason (and optional actor/timestamp); Round Edit has explicit override reason and actor fields and displays existing override info when loading.

---

## Summary

- **Routes:** 12 routes implemented (dashboard, events, event detail, round entry, round edit, attribution review, player mapping, standings, groups, group detail, login).
- **Screens:** All 8 approved workflows implemented (Dashboard, Events, Event Detail, Attribution Review, Player Mapping, Standings, Round Entry, Round Edit) plus Login, Groups, Group Detail.
- **Components:** 10 shared components; no business logic in UI.
- **Endpoints used:** 12 implemented (ingest-event-results; get-standings; **standings-player-history** for drilldown; groups; seasons; events list/detail; PATCH events; GET /players; GET/POST review/player-mapping; GET/POST review/attribution).
- **Blockers:** None.
- **Next step:** Optional UI polish (player drilldown, override reason field).

**Events list attribution filter:** Events page has an "Attribution" filter (All / Pending attribution / Attributed / resolved). "Pending attribution" calls GET /events?attribution_status=pending_attribution; "Attributed / resolved" merges results from attribution_status=attributed and attribution_status=attribution_resolved. Table shows an Attribution column (StatusBadge) so operators can see and filter events that need attribution review; row click goes to Event Detail with link to Attribution Review.

---

## UI review and usability pass

A structured review of operator workflows (manual round entry, event detail, round edit, player mapping, attribution review, standings) was done to reduce friction and improve clarity without expanding scope. Full report: [docs/UI_REVIEW_REPORT.md](./docs/UI_REVIEW_REPORT.md).

**Top 10 issues identified:** (1) Round entry collected event name but did not send it — removed. (2) Round edit had raw UUID for season — replaced with season dropdown for event’s group. (3) Round edit points columns unlabeled — added Points/Override labels and helper text. (4) Event detail showed attribution as raw text — now uses StatusBadge. (5) Events list column "Received / created" — shortened to "Received". (6) Dashboard "Recent events" count ambiguous — clarified as "Showing latest 15 events"; "View all events" as button-style link. (7) Queue screens had no selected-row highlight — DataTable now supports `selectedRowKey`; Player mapping and Attribution review highlight the active row. (8) Empty states minimal — added optional `detail` to EmptyState; queue screens explain when items appear. (9) Standings had no hint — added helper text: select group then season; standings points-only from ledger. (10) Status badges for attributed/attribution_resolved had no CSS — added in index.css.

**Changes made:** Round entry: removed event name field. Round edit: season dropdown (listSeasons for event.group_id), labeled Points/Override with short explanation. Event detail: attribution as StatusBadge; actions wording. Events: column label "Received". Dashboard: summary and View all events link. DataTable: optional `selectedRowKey` for row highlight. EmptyState: optional `detail` prop. Player mapping / Attribution review: `selectedRowKey` and empty-state detail copy. Standings: helper text. CSS: `.badge.attributed`, `.badge.attribution_resolved`, `tr.selected-row`.

**Deferred (larger UX):** Player mapping filter players by group; events list column visibility/reorder; round entry inline validation; dashboard quick filters; breadcrumbs; keyboard/a11y pass. **Override audit:** Full revision history (multiple edits per score) is out of scope; current scope is single override_reason/override_actor/override_at per score, surfaced in Event Detail, Round Edit, and Standings drilldown.

**Standings drilldown:** Backend GET `/standings-player-history?group_id=&season_id=&player_id=` returns round-level point records for one player (ledger drilldown). Standings screen: click a player row → detail panel with total, rounds played, and table of (date, event link, points, override when present, source). Override shown in orange with “(override)” label. Empty state when no history. See windex-api/docs/api.md and POINTS_LEDGER_ARCHITECTURE.md. **Deferred enhancements:** Export history to CSV; filter history by date range (backend could support optional from_date/to_date).
