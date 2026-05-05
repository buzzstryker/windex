# Windex — Master Spec

Product goals and scope. For status, architecture, UI direction, and terminology see [README.md](./README.md).

---

## Goals

- Provide a **points ledger + standings aggregation platform** for golf that any compliant app or admin can use as a backend.
- Ingest or accept **final point totals per player** from external apps or manual admin entry; store them as **atomic point records** (one per player per round); derive **standings only** from those records (no direct editing of standings).
- Support optional **payout configuration** and **round-scoped payment request generation** for settlement workflows, without tracking payment completion in the product.

## Scope

- **In scope:** API-first ingestion; groups, seasons, events (rounds), **points ledger** (atomic point records per player per round), **standings derived only from the ledger** (no mutable standings table); group-level payout config; round-scoped money_delta computation and payment-request generation; Windex app UI (in progress). Windex is a **points ledger + standings aggregation platform**—not a competition rules engine.
- **Out of scope (current):** Running rounds or capturing scores inside Windex; settlement ledger or payment-completion tracking; stroke-play or handicap calculation inside the API; any internal scoring logic for golf formats (Stableford, match play, best ball, skins, etc.). External systems or human admins determine points; Windex stores, maps, attributes, corrects, audits, and aggregates them. **Do not add rules-engine or format-calculation roadmap items for v2.**

## Success criteria

- External apps can POST event results and read standings and payment requests using the documented API.
- Standings are correct and points-only; payout and payment-request behavior are optional and do not affect standings.
- Windex app UI supports the core flows (groups, seasons, ingest, standings, rounds, payment requests) using the existing API.

## References

- [README.md](./README.md) — Overview, current architecture, UI starting point, terminology
- [Data Model](./Windex_Data_Model.md)
- [API Spec](./Windex_API_Spec.md)
- [Screen Map](./Windex_Screen_Map.md)
