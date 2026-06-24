# ETH Staking Tax Tracker

A self-hosted app to track Ethereum staking rewards and generate tax reports —
inspired by [ethstaker.tax](https://github.com/serenita-org/ethstaker.tax).

**Why a backend?** A browser-only version can't build the daily history a tax
report needs, and beaconcha.in is now paid-only. So a small backend reads from
**your own beacon node** and **persists to SQLite**, accumulating history over
time — like ethstaker.tax's backend, but fully self-hosted with no external API
or key.

## Architecture

```
┌─────────────────────────────────────────────┐
│ One container (in your Docker Swarm)         │
│  Fastify (server/)                           │
│   ├─ /api/* — status, settings (read-only),  │
│   │           collect, summary, report (+CSV)│
│   ├─ collector → your beacon node            │
│   │     • daily validator balances           │
│   │     • exact attestation rewards / epoch  │
│   ├─ SQLite (validators, balances, income,   │
│   │          prices)                         │
│   └─ serves the React build (web/)           │
└─────────────────────────────────────────────┘
   │ internal                       │ external
   ▼                                ▼
 your Lighthouse (5052) + Geth   CoinGecko (ETH/fiat prices)
```

- **server/** — Fastify + better-sqlite3 + the reward engine, Beacon Node API
  client, pricing, and collector (TypeScript).
- **web/** — React + Vite frontend; calls the backend `/api`, holds no secrets.

**Data source:** your own **archive** beacon node. Validators are entered by
index (a raw node can't map a withdrawal address → validators). Consensus income
comes from the Beacon **attestation-rewards API** (exact, per epoch); the backend
reaches the node directly on the internal network — no public exposure, no key,
no rate limit.

## Tax bases
- **Accrual** — exact daily consensus (attestation) income from the rewards API.
- **Receipt** — withdrawals, derived per day as `income − balance_delta`.

**Execution-layer rewards** (block proposals: priority fees + MEV-boost) are
reported separately. The collector finds blocks your validators proposed (from
the beacon node) and values each as the fee recipient's balance change across
the block. On a non-archive execution node it falls back to priority-fees only
per block, which can undercount MEV (flagged in the report).

Each event is priced in fiat (EUR default) from CoinGecko, exportable as **CSV**
or **print-to-PDF**.

## Run locally (Docker)

```bash
cp docker-compose.example.yml docker-compose.yml   # then edit in your node URLs + validators
docker compose up --build
# open http://localhost:3000
```

`docker-compose.yml` is gitignored so your node URLs and validator indices stay
private; `docker-compose.example.yml` is the committed template. Config is set
via the `STT_*` env vars (beacon URL + validator indices — see Configuration
below). Then: **Dashboard** → **Collect / Refresh data**. Data persists in
`./data`.

## Run locally (without Docker)

```bash
# terminal 1 — backend (http://localhost:3000)
cd server && npm install && npm run dev
# terminal 2 — frontend dev server (proxies /api to :3000)
cd web && npm install && npm run dev
```

Build everything: `npm run build` (root). Run tests: `npm test` (engine units).

## Configuration (env)

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `3000` | Listen port |
| `STT_DB_PATH` | `./data/stakingtracker.db` | SQLite file |
| `STT_WEB_DIR` | `../web/dist` (rel. to server) | Static frontend dir |
| `STT_USER` / `STT_PASS` | — | Optional app-level basic auth |
| `STT_BEACON_URL` | `http://mainnet-lighthouse:5052` | Beacon Node URL |
| `STT_EXECUTION_URL` | `http://mainnet-geth:8545` | Execution RPC URL (optional) |
| `STT_VALIDATORS` | — | Comma-separated validator indices |
| `STT_CURRENCY` | `eur` | Report currency, e.g. `eur` |
| `STT_SCAN_FROM_BLOCK` | — | First execution block to scan (history start) |
| `STT_SCAN_MAX` | `250000` | Max execution blocks scanned per run (withdrawals) |
| `STT_PROP_SCAN_MAX` | `100000` | Max beacon slots scanned per run (EL proposals) |
| `STT_PROP_CONCURRENCY` | `64` | In-flight requests for the per-slot proposal scan (raise for a fast/remote node) |
| `STT_CONCURRENCY` | `12` | In-flight requests for balance/other scans |

All config comes from these env vars — the Settings page is read-only. Pin the
whole config in `docker-compose.yml`. At minimum set `STT_BEACON_URL` and
`STT_VALIDATORS`.

## Deploy to the homelab (Docker Swarm)

See [deploy/homelab.md](deploy/homelab.md) — a single service behind Traefik with
basic-auth, SQLite on a `/mnt/homelab` volume.

## Accuracy notes (important for a tax tool)
- History accumulates from when you start collecting; beaconcha.in's window plus
  daily collection fills it going forward. Gaps before first collection are
  flagged in the report.
- **Not tax advice.** Capital gains on later disposal of the ETH are out of
  scope. Verify against official sources before filing.
