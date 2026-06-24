import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { api, type Summary, type Status, type ValidatorStatus } from '../api'

// Holds the dashboard summary + collector status, and exposes a "collect"
// action that triggers a backend collection and polls until it finishes.

interface DataState {
  summary: Summary | null
  status: Status | null
  validators: ValidatorStatus[] | null
  collecting: boolean
  error: string | null
  reload: () => Promise<void>
  collect: () => Promise<void>
}

const Ctx = createContext<DataState | null>(null)

export function DataProvider({ children }: { children: ReactNode }) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const [validators, setValidators] = useState<ValidatorStatus[] | null>(null)
  const [collecting, setCollecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const [st, sum] = await Promise.all([api.status(), api.summary()])
      setStatus(st)
      setSummary(sum)
      setError(st.collector.lastError ?? null)
      // Live validator status is a direct beacon-node call; don't let a slow or
      // unreachable node block the rest of the dashboard.
      api
        .validators()
        .then(setValidators)
        .catch(() => setValidators([]))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const collect = useCallback(async () => {
    setError(null)
    setCollecting(true)
    try {
      await api.collect()
      // Poll status until the collector is idle, then refresh the summary.
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000))
        const st = await api.status()
        setStatus(st)
        if (!st.collector.running) {
          if (st.collector.lastError) setError(st.collector.lastError)
          break
        }
      }
      await reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCollecting(false)
    }
  }, [reload])

  useEffect(() => {
    void reload()
  }, [reload])

  return (
    <Ctx.Provider value={{ summary, status, validators, collecting, error, reload, collect }}>
      {children}
    </Ctx.Provider>
  )
}

export function useData(): DataState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useData must be used within DataProvider')
  return ctx
}
