# Windex — UI Architecture

Front-end structure for the Windex admin UI. For screens and flows see [Screen Map](./Windex_Screen_Map.md); for API contract see [API Spec](./Windex_API_Spec.md) and [windex-api/docs/](./windex-api/docs/).

---

## 1. UI Goals

- **Admin-focused interface** — For league admins who manage groups, seasons, events, and standings (points ingestion, attribution, correction, aggregation).
- **Manage groups, seasons, events, standings** — Create and edit groups and seasons; view and manage events (rounds); view points-only standings.
- **Product requirement:** Windex must support: (1) **API-ingested results** from external apps such as Scorekeeper or 18Birdies; (2) **Manual round entry** as a first-class workflow; (3) **Round edit / override / correction** by an admin. The UI cannot be limited to passive review; it must support operational round creation and correction.
- **Three ways events enter** — All converge into the same canonical event/result model in the backend. No separate "manual-only" data model; source labeling and input workflow only.
- **Resolve attribution conflicts** — Surface events that cannot be assigned cleanly to group/season; support resolution (choose canonical, merge, or reject).
- **Resolve player mapping** — Map source-player identities to canonical Windex players.
- **Operational, not passive** — The UI supports active round creation and correction, not only review of ingested data.

---

## 2. Application Structure

Main UI areas (aligned with [Screen Map](./Windex_Screen_Map.md)):

| Area | Purpose |
|------|---------|
| **Dashboard** | Operational snapshot: recent events (ingested + manual), pending attribution and player mapping counts, standings shortcut; Recent Events table; Attention Required links. |
| **Events** | Audit trail for all events; filterable/sortable list; event detail with links to edit, attribution review, player mapping. |
| **Round entry** | Manual creation of a round (group, season, date, players, scores); first-class flow at e.g. `/events/new`. |
| **Round edit / override** | Correct or override an existing round; entry from event detail; route e.g. `/events/:eventId/edit`. |
| **Attribution review** | Queue of unresolved attribution items; list + detail; admin selects group/season and submits resolution. |
| **Player mapping** | Queue of unmapped source players; list + detail; admin maps to Windex player and confirms. |
| **Standings** | Group + Season selectors; read-only points-only standings from API. |
| **Groups** | List and manage groups (and sections if used). |
| **Seasons** | List and manage seasons per group. |
| **Admin settings** | Auth, profile, app-level settings. |

---

## 3. Routing Model

| Route | Purpose |
|-------|---------|
| `/login` | Sign in (email/password or paste JWT). |
| `/dashboard` | Home / dashboard. Dev tools: Reset & Import All, Import New Rounds. |
| `/events` | Rounds list (sortable by date/game points; filterable by group, source, status, date). Signature Event flag toggle. |
| `/events/new` | Round Entry — manual round creation. |
| `/events/:eventId` | Round detail. |
| `/events/:eventId/edit` | Round edit / override. |
| `/review/attribution` | Attribution Review — queue and resolution. |
| `/review/player-mapping` | Player Mapping — queue and resolution. |
| `/standings` | Standings — Group + Season selectors; points-only table with player drilldown. |
| `/groups` | Groups list. |
| `/groups/:groupId` | Group detail. |
| `/players` | Players — view and edit player data by group (name, email, Venmo, role, active). |
| `/analytics/points` | Points Analysis — all-vs-all matrix via `GET /get-points-matrix`, head-to-head drill-down via `GET /get-points-analysis`. All computation server-side. Season filter (2023+), Signature Events toggle. |

Auth (sign-in) is a separate flow (e.g. `/login`) before the above.

### Expo app (windex-expo) — 3-tab structure

| Tab / Route | Purpose |
|-------------|---------|
| **Standings** (tab) | Shared group/season context; group selector in header (tap → modal); standings table with medals, dollar/point amounts, alternating rows. |
| **Rounds** (tab) | Shared group/season context; group selector in header; round cards with date, score pills. Tap → Round detail. |
| **Analysis** (tab) | All-vs-all matrix (`GET /get-points-matrix`), worst matchups, drill-down via `GET /get-points-analysis`. Exclude Signature Events toggle. All computation server-side. |
| Round detail (`/round/[id]`) | Pushed screen: PLAYER / GAME PTS / +/- table; edit scores inline, delete round. **Quick Payout** (minimized transactions: match biggest loser→winner) and **Payout** (every loser pays every winner the game_points difference × dollars_per_point). Venmo deep links: `https://venmo.com/{handle}?txn=pay&amount=X&note={group}%20Golf%20-%20{date}`. Only shown when group has dollars_per_point. |
| Groups (`/groups`) | From drawer: groups listed by section with logo thumbnails. Tap → Group detail. |
| Group detail (`/group/[id]`) | Banner, stats grid, current season, previous seasons with champion. Tap Active Members → member list with inline editing. |
| Group members (`/group-members`) | Member list with edit modal (display name, full name, Venmo, active toggle). |
| Drawer | Hamburger menu (top-left on every tab). **Group selection lives here**: "My Groups" section with logo thumbnails + checkmark on selected group. "Other Groups" section below divider. Group Details link, Sign out. User info at bottom. |

**Shared GroupContext:** All three tabs share a `GroupContext` with selected group and season. Changing group in the drawer updates all tabs. Current season auto-resolved. Default group = most recently active.

**Tab headers:** Simple olive green bar with tab name ("Standings", "Rounds", "Analysis") + hamburger icon. No group selector in headers — all group switching via the drawer.

**Season selector:** Compact pill/dropdown within each tab's content area (below banner, above data).

Visual design matches Late Add v1 (Glide): olive green headers (#4B5E2A), white tab bar, light gray background, white cards, green/pink score pills.

---

## 4. API Interaction

| Need | API usage |
|------|-----------|
| **Ingest events** | POST event results (group_id, round_date, scores[], optional source_app, external_event_id). Handle validation errors and duplicate responses. |
| **Manual round creation** | Same canonical path as ingest (e.g. POST with source_app = "manual" or equivalent); no separate backend model. |
| **Update / override round** | Use backend-supported update endpoint(s) for event metadata and/or results; document any override/reason field if present. |
| **Retrieve standings** | GET standings by group/season; display as returned; no client-side aggregation. |
| **Retrieve groups, seasons, events** | GET list/detail for groups, seasons, league_rounds (events); use for lists, detail views, filters. |
| **Resolve attribution** | Use API endpoints for attribution resolution (accept/reject/merge) per windex-api contract. |
| **Resolve player mappings** | Map external player identifiers to Windex player_id via supported API; refresh queues after resolution. |

All calls use **Bearer JWT** (Supabase Auth). Full contract in [windex-api/docs/](./windex-api/docs/).

---

## 5. Data Flow

```
UI → API → Canonical Event → Attribution → Results → Points → Standings
```

- **UI** submits or inspects data only via the API. Manual entry and ingested rounds both produce the same canonical event/result model.
- **API** validates and persists; aggregates standings from stored points. Round edit/override flows through the API; the client does not simulate aggregation.
- **Standings** are always computed on the backend from stored event results; the UI never computes them locally. Windex does not compute golf competition formats (e.g. Stableford, match play); it stores and aggregates point totals.

---

## 6. State Management

| Layer | Description |
|-------|-------------|
| **Server state** | Data from the API: events, groups, seasons, standings, attribution queue, player-mapping queue. Cache and invalidate/refetch after mutations. |
| **UI state** | Filters, selections, modal open/closed, form dirty state. Keep separate from server state. |
| **Review queues** | Attribution and player-mapping lists as server-state; refetch after resolution so queues stay accurate. |

---

## 7. Error Handling

| Error type | How to surface |
|------------|-----------------|
| **Ingestion validation errors** | Field-level or request-level messages from API; allow correction and retry. |
| **Duplicate events** | Clear message; link to Attribution Review or event detail. |
| **Unresolved attribution** | Dashboard and Attribution Review: count and list; link to resolution. |
| **Unresolved player mappings** | Dashboard and Player Mapping: list unmapped players; warn when standings might be affected. |

Use a shared error state component and consistent messaging.

---

## 8. UI Principles

- **Fast admin workflows** — Minimize steps for common tasks (e.g. manual entry → event detail, or resolve one attribution item).
- **Minimal clicks for attribution resolution** — Dedicated queue with short flows to accept/merge/reject.
- **Standings always from backend** — Never compute standings in the front end.
- **Manual entry is first-class** — Same visibility and treatment as API-ingested events; no hidden or second-class flows.
- **Round edit/override is correction** — Treat as audit-friendly correction; backend owns downstream effects.

---

## 9. Shared UI Requirements

- **Routing** — Clear routes per section above; e.g. `/login`, `/dashboard`, `/events`, `/events/new`, `/events/:eventId`, `/events/:eventId/edit`, `/review/attribution`, `/review/player-mapping`, `/standings`, `/groups`, `/players`, `/analytics/points`.
- **Shared components** — Page header, status badge, data table, filter bar, empty state, error state, loading spinner/skeleton, confirmation toast/banner, form section, player/result row editor for round entry and edit where useful.
- **Status design** — Normalize status across screens: processed, pending attribution, pending player mapping, validation error, duplicate/ignored. Use one shared status badge component.
- **Navigation** — Dashboard links to Events, Attribution Review, Player Mapping, Standings; Events links to event detail and Round Entry; event detail links to Edit/Override and review flows; Standings and Round Entry in primary nav.
- **Styling** — Clean, minimal, operational; readability and scanning over novelty; consistent over flashy.

---

## References

- [README](./README.md) — Overview, terminology.
- [Screen Map](./Windex_Screen_Map.md) — Screens and flows.
- [API Spec](./Windex_API_Spec.md) — Endpoints and shapes.
- [Data Model](./Windex_Data_Model.md) — Entities and schema.
