# Windex Admin UI — Review & Usability Pass

Structured review of operator workflows: manual round entry, event inspection/detail, round edit/override, player mapping, attribution review, standings. Goal: reduce friction, improve scanability, make exception states clear, keep actions deliberate—without expanding product scope or changing backend logic.

---

## Top 10 usability issues / friction points

1. **Round entry: Event name collected but not sent to API** — The "Event name (optional)" field is stored in local state only; ingest payload has no event name. Operators may think it is saved. Either remove the field or document clearly (removed in this pass to avoid confusion).

2. **Round edit: Season is a raw UUID input** — "Season ID (optional)" requires pasting a UUID. Operators have no way to pick a season by date range. Should be a dropdown of seasons for the event’s group (implemented: load seasons for event.group_id, show dropdown).

3. **Round edit: Points columns unlabeled** — Two number inputs per row (points stored, points override) with no column headers in the form. Unclear which is "Points" vs "Override" and what "Override" means. Added labels and short helper text (implemented).

4. **Event detail: Attribution shown as raw value** — Attribution status shown as plain text instead of the same StatusBadge used elsewhere. Inconsistent and less scannable. Use StatusBadge for attribution (implemented). "Actions" card duplicates header links; kept but simplified.

5. **Events list: Dense columns, "Received / created" verbose** — Many columns (Event ID, External ID, Source, Date, Group, Season, Status, Attribution, Received/created) can overwhelm. Shortened "Received / created" to "Received" and kept table; no column removal to preserve audit trail (implemented label change).

6. **Dashboard: "Recent events" count ambiguous** — "Recent events: 15" could mean total events or "showing 15". Clarified as "Showing latest 15" and made "View all events" more visible (implemented).

7. **Queue screens: No selected-row highlight** — On Player mapping and Attribution review, clicking a row fills the detail panel below but the selected row in the table is not visually highlighted. Operators can lose context. Added row highlight for selected item (implemented).

8. **Empty states: Minimal copy** — "No unresolved attribution items" / "No unresolved player mapping items" don’t explain when items would appear. Added one line of context so operators know the queue is empty vs broken (implemented).

9. **Standings: No hint that season depends on group** — Selectors work (season filters by group) but first-time users may not know to pick group first. Added short helper text (implemented).

10. **Status badges: Attribution values missing CSS** — "Attributed" and "Attribution resolved" use StatusBadge but had no distinct styles; fell back to default. Added `.badge.attributed` and `.badge.attribution_resolved` for consistency (implemented).

---

## Improvements implemented (this pass)

- **Round entry:** Removed unused "Event name" field so the form only collects data that is sent to the API.
- **Round edit:** Season dropdown for event’s group; labeled "Points" and "Override" with brief explanation; helper text that override is for corrections.
- **Event detail:** Attribution shown with StatusBadge; Actions section kept but wording tightened.
- **Events list:** Column label "Received / created" → "Received".
- **Dashboard:** Summary line "Recent events: N" → "Showing latest 15 events" (and link "View all events" styled as primary link).
- **Player mapping / Attribution review:** Selected queue row gets a background highlight so the active item is obvious.
- **Empty states:** Attribution queue: "When events are ingested without a season, they appear here." Player mapping: "When a source player can’t be matched, they appear here."
- **Standings:** Helper text: "Select a group, then a season. Standings are points-only and derived from the ledger."
- **CSS:** `.badge.attributed` and `.badge.attribution_resolved` for status badges.

---

## Deferred (larger UX improvements)

- **Player mapping: Filter players by group** — Show only players in the group for the related event. Requires passing group context from queue item or API; deferred.
- **Events list: Column visibility or reorder** — Allow hiding or reordering columns for different roles. Bigger change; deferred.
- **Round entry: Inline validation before submit** — e.g. duplicate player warning, date in future. Improves clarity but adds logic; deferred.
- **Dashboard: Quick filters** — e.g. "Events needing attention" as a single link that applies filters. Partially exists via "Attention required"; could be expanded later.
- **Breadcrumbs** — Event detail / Round edit could show Events > Event XYZ > Edit. Improves navigation; deferred as a larger nav change.
- **Keyboard / a11y** — Focus management, ARIA labels, and keyboard navigation for queues and forms. Important but out of scope for this pass.

---

## Workflow order reviewed

1. Manual round entry — Labels, removed dead field, clarity.
2. Event inspection / event detail — Status and attribution consistency, actions.
3. Round edit / override — Season dropdown, labels, helper text.
4. Player mapping — Selected row highlight, empty state copy.
5. Attribution review — Selected row highlight, empty state copy.
6. Standings — Helper text, no logic change.

Constraints respected: no product redesign, no new features, no business logic moved into the UI; small, practical improvements only.
