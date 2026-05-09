# Windex — Screen Map

Screens and flows for the Windex app. For terminology (Group, Season, Event, Result, Standings, Source app) see [README — Terminology](./README.md#terminology). For UI structure and routing see [UI Architecture](./Windex_UI_Architecture.md).

---

## Product scope: three ways events enter the system

Windex supports events (rounds) from three paths. All converge into the same canonical event/result model in the backend; the UI does not maintain separate "manual-only" logic beyond source labeling and input workflow.

**Core product rule:** Manual entry and ingested rounds must converge into the same canonical event/result model in the backend. The UI must not create separate "manual-only" logic beyond source labeling and the input workflow. Standings aggregation, attribution, validation, and correction remain backend responsibilities. Windex does not compute golf competition formats (e.g. Stableford, match play); it ingests and aggregates point totals. The UI is operational (round creation and correction), not limited to passive review.

| Source | Description |
|--------|-------------|
| **API ingestion** | External apps (e.g. Scorekeeper, 18Birdies) POST event results to the Windex API. Events appear in the system with `source_app` and optional `external_event_id` for attribution and idempotency. |
| **Manual round entry** | Admins create a round/event directly in the UI when no external app supplied results or when direct entry is faster. Treated as a first-class workflow; submitted to the same backend path as ingestion (e.g. manual as `source_app`). |
| **Round edit / override** | Admins correct bad ingests, adjust entered rounds, and override round details or results. Changes flow through the backend; standings aggregation remains a backend responsibility. |

---

## App entry and navigation

- **Dashboard** — Top-level entry; summary cards and recent rounds; links to Rounds, Attribution Review, Player Mapping, Standings. Dev tools: Reset & Import Glide Data, Import New Rounds.
- **Expo app (windex-expo) tab bar** — 3 tabs: Standings, Rounds, Analysis. Olive green headers with tab name only. Hamburger drawer for group selection (My Groups / Other Groups with logo thumbnails + checkmark), Group Details, Sign out. **Phone viewports (`< 768px`) additionally show a `<GroupPicker />` dropdown directly below the header on all three tabs.** It scopes to the user's active `group_members` rows (alphabetical), persists manual selection per `user_id`, and renders as static text when the user is in only one group. The picker is absent on tablet/desktop — group switching there continues via the drawer. Both surfaces share `GroupContext.myGroups` and stay in sync.
- **Admin web UI (windex-admin) nav** — Dashboard, Rounds, Round Entry, Standings, Groups, Players, Points Analysis, Attribution Review, Player Mapping.
- **Round-centric** — Round detail links to Edit/Override, Attribution Review, and Player Mapping where relevant.

---

## Screens (implemented / target)

| Screen | Purpose |
|--------|---------|
| **Auth / sign-in** | Email OTP login (6-digit code sent to email, verified in-app) via Supabase Auth; email/password fallback for dev accounts. Route: `/login`. |
| **Dashboard** | Operational snapshot: recent rounds, pending attribution count, pending player mapping count; Attention Required section with links to review queues. Dev tools card: Reset & Import All, Import New Rounds. |
| **Rounds** | All rounds (API-ingested and manual). 🏆 for tournament rounds. "+ Add Round" visible for active season (all users) or past season (admin only). "Season ended" label shown on past seasons. Add Round form: date, tournament toggle + buy-in + pool validation, player chips, score entry with live +/- preview. Submits via `POST /ingest-event-results`. Route: `/events`. |
| **Round detail** | Single round: metadata, PLAYER / GAME PTS / +/- table, Quick Payout / Payout with Venmo. **Edit/delete: super admin and group admin only** — buttons hidden for members (client-side check + RLS backend enforcement). **Quick Payout** = minimized transactions. **Payout** = every loser pays every winner the game_points difference × dollars_per_point. Venmo deep links to `https://venmo.com/{handle}?txn=pay&amount=X&note={group}%20Golf%20-%20{date}`. Route: `/events/:eventId` (admin), `/round/[id]` (expo). |
| **Round Entry** | Manual round creation. Form: group, season, played date, players, scores. Route: `/events/new`. |
| **Round edit / override** | Correction of existing round. Entry from round detail; route: `/events/:eventId/edit`. Edit metadata, players, scores; optional override reason. |
| **Attribution Review** | Queue of rounds with unresolved attribution; admin chooses correct group/season and submits resolution. Route: `/review/attribution`. |
| **Player Mapping** | Queue of unmapped source players; admin maps to existing Windex player and confirms. Route: `/review/player-mapping`. |
| **Standings** | Shared group/season context with group selector modal (tap header → bottom sheet with groups by section, season pills). Points-only table with medals, dollar/point amounts, alternating rows. Default group = most recently active. Route: `/standings`. |
| **Groups** | List groups. Route: `/groups`. |
| **Players** | View and edit player data by group: display name, full name, email, Venmo, role, active status. Inline editing. Route: `/players`. |
| **Points Analysis** | Game points differential analysis. All-vs-all matrix via `GET /get-points-matrix`, head-to-head drill-down via `GET /get-points-analysis`. All computation server-side; both windex-admin and windex-expo render the same API responses. Season filter (2023+), Exclude Signature Events toggle. Worst matchups table with player filter. Click any cell or row to drill into detail. Admin route: `/analytics/points`. Expo: Analysis tab. |
| **Seasons** | List and manage seasons per group. |
| **Payout config** | Group-level payout (e.g. dollars_per_point) if exposed. |
| **Payment requests** | For a round: compute-money-deltas then generate-payment-requests; display payer→payee list. |

---

## Status values (normalized across UI)

- **processed** — Event fully processed and attributed.
- **pending attribution** — Awaiting admin resolution of group/season (or duplicate) attribution.
- **pending player mapping** — One or more source players not yet mapped to Windex players.
- **validation error** — Ingestion or update failed validation; needs correction.
- **duplicate / ignored** — Treated as duplicate by backend (e.g. same source_app + external_event_id).

---

## Flows

- **Ingest → inspect** — Events list and event detail show all events; filters by source, status, group, date.
- **Manual entry** — Events → New Round → fill form → submit → redirect to event detail or events list.
- **Correct round** — Event detail → Edit/Override → change fields → save → back to event detail; backend recalculates standings.
- **Resolve attribution** — Dashboard or Events → Attribution Review → select item → choose group/season → submit → item removed from queue.
- **Resolve player mapping** — Dashboard or Events → Player Mapping → select unmapped player → choose Windex player → confirm → removed from queue.
- **View standings** — Standings → select Group + Season → display API response; no client-side calculation.

---

## References

- [README.md](./README.md)
- [UI Architecture](./Windex_UI_Architecture.md)
- [API Spec](./Windex_API_Spec.md)
