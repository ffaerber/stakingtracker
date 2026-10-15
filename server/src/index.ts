import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import basicAuth from '@fastify/basic-auth'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

import { loadSettings } from './settings'
import { collect, collectorStatus } from './collector'
import { resolveValidators, headSlot, validatorLiveness } from './beacon'
import { buildReport, summary, availableYears } from './report'
import { reportToCsv, type TaxMethod } from './engine/taxReport'
import { GWEI_PER_ETH } from './engine/rewards'
import { SLOTS_PER_EPOCH } from './time'
import { getMeta } from './db'
import { metricsText } from './metrics'
import { refreshSpot } from './prices'

// In the compiled output this file is server/dist/index.js, so ../../web/dist
// resolves to the repo's web build. Override with STT_WEB_DIR in Docker.
const WEB_DIR = process.env.STT_WEB_DIR ?? resolve(__dirname, '../../web/dist')
const PORT = Number(process.env.PORT ?? 3000)
const HOST = process.env.HOST ?? '0.0.0.0'

const app = Fastify({ logger: true })

function parseMethod(v: unknown): TaxMethod {
  return v === 'receipt' ? 'receipt' : 'accrual'
}

// ---- API ----

app.get('/api/status', async () => {
  const s = await loadSettings()
  const last = getMeta('last_collected_at')
  return {
    configured: Boolean(s.beaconUrl && s.validatorIds.length),
    lastCollectedAt: last ? Number(last) : null,
    collector: collectorStatus(),
  }
})

// Read-only: config is env-driven, so the UI shows it but cannot change it.
app.get('/api/settings', async () => loadSettings())

// Live validator status straight from the beacon node (no persistence): current
// consensus status + balance, plus liveness for the last completed epoch as the
// "online" signal. Returns [] when not configured.
app.get('/api/validators', async () => {
  const s = await loadSettings()
  if (!s.beaconUrl || !s.validatorIds.length) return []
  const vals = await resolveValidators(s.beaconUrl, s.validatorIds)
  const epoch = Math.max(0, Math.floor((await headSlot(s.beaconUrl)) / SLOTS_PER_EPOCH) - 1)
  const live = await validatorLiveness(s.beaconUrl, epoch, vals.map((v) => v.index)).catch(() => null)
  return vals.map((v) => ({
    index: v.index,
    status: v.status,
    balanceEth: v.balanceGwei / GWEI_PER_ETH,
    // null = active validator but liveness unavailable; non-active → not "online".
    online: v.status.startsWith('active') ? (live ? (live.get(v.index) ?? null) : null) : false,
  }))
})

app.post('/api/collect', async (_req, reply) => {
  if (collectorStatus().running) return reply.code(409).send({ error: 'Collection already running' })
  // Fire-and-forget; progress is observable via /api/status.
  collect((m) => app.log.info(m)).catch((e) => app.log.error(e))
  return reply.code(202).send({ started: true })
})

app.get('/api/summary', async () => summary())

// Prometheus scrape target. Persisted data only (no node requests), cached
// for 5 min. Reached on the internal network; app-level basic auth (if set)
// applies here too.
app.get('/metrics', async (_req, reply) =>
  reply.type('text/plain; version=0.0.4; charset=utf-8').send(await metricsText()),
)

app.get('/api/report', async (req) => {
  const q = req.query as { year?: string; method?: string }
  const year = Number(q.year) || availableYears()[0] || new Date().getUTCFullYear()
  return buildReport(year, parseMethod(q.method))
})

app.get('/api/report.csv', async (req, reply) => {
  const q = req.query as { year?: string; method?: string }
  const year = Number(q.year) || availableYears()[0] || new Date().getUTCFullYear()
  const method = parseMethod(q.method)
  const csv = reportToCsv(await buildReport(year, method))
  reply.header('content-type', 'text/csv; charset=utf-8')
  reply.header('content-disposition', `attachment; filename="eth-staking-${year}-${method}.csv"`)
  return csv
})

// ---- Daily collector schedule ----

const DAY_MS = 24 * 60 * 60 * 1000
async function maybeCollect() {
  const s = await loadSettings()
  if (!s.beaconUrl || !s.validatorIds.length) return
  const last = Number(getMeta('last_collected_at') ?? 0)
  if (Date.now() - last < 12 * 60 * 60 * 1000) return
  app.log.info('Starting scheduled collection…')
  collect((m) => app.log.info(m)).catch((e) => app.log.error(e))
}

async function main() {
  // Optional app-level basic auth (set STT_USER/STT_PASS). In the homelab this
  // is typically handled by the Traefik basic-auth middleware instead.
  if (process.env.STT_USER && process.env.STT_PASS) {
    await app.register(basicAuth, {
      validate: async (user, pass) => {
        if (user !== process.env.STT_USER || pass !== process.env.STT_PASS) {
          return new Error('Unauthorized')
        }
      },
      authenticate: { realm: 'stakingtracker' },
    })
    app.addHook('onRequest', app.basicAuth)
  }

  // Static frontend (SPA) with fallback to index.html.
  if (existsSync(WEB_DIR)) {
    await app.register(fastifyStatic, { root: WEB_DIR })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) return reply.code(404).send({ error: 'Not found' })
      return reply.sendFile('index.html')
    })
  } else {
    app.log.warn(`Web dir not found at ${WEB_DIR}; serving API only.`)
  }

  await app.listen({ port: PORT, host: HOST })
  setInterval(() => void maybeCollect(), DAY_MS)
  // Live ETH price for /metrics, polled in the background (see prices.ts).
  const pollSpot = async () => {
    try {
      await refreshSpot((await loadSettings()).currency)
    } catch (e) {
      app.log.debug(`spot price fetch failed: ${e instanceof Error ? e.message : e}`)
    }
  }
  void pollSpot()
  setInterval(() => void pollSpot(), 60_000)
  // Kick a collection shortly after boot if data is stale.
  setTimeout(() => void maybeCollect(), 5000)
}

main().catch((e) => {
  app.log.error(e)
  process.exit(1)
})
