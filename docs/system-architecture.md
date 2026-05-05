\# Windex System Architecture



\## Structure

- **`windex-api/`** — Supabase backend, migrations, Edge Functions, tests. See [../windex-api/README.md](../windex-api/README.md).
- **`windex-admin/`** — Admin web UI (Vite + React).
- **`docs/`** (this folder) — High-level architecture and product notes; canonical API is in **windex-api/docs/**.
- **`windex-expo/`** — Expo app (web via `expo start --web`, iOS/iPad via Expo Go).



\## Backend responsibilities



\- ingest event results

\- compute standings

\- support overrides

\- compute money deltas

\- generate payment requests



\## Product rules



\- standings are points-only

\- money is only for settlement/payment request generation

\- Windex does not track payment completion



\## Core backend flow



1\. ingest event results

2\. compute standings from effective points

3\. compute money deltas for a round

4\. generate payer → payee payment requests



\## Current backend endpoints



\- `ingest-event-results`

\- `get-standings`

\- `compute-money-deltas`

\- `generate-payment-requests`

