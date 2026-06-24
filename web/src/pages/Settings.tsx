import { useEffect, useState } from 'react'
import { api, type PublicSettings } from '../api'

// Read-only: every setting is supplied via STT_* env vars (see docker-compose).
// This page shows the active config; it cannot be changed from the UI.
export default function Settings() {
  const [s, setS] = useState<PublicSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api
      .getSettings()
      .then(setS)
      .catch((e) => setError(String(e)))
  }, [])

  if (!s) return <p className="muted">{error ?? 'Loading settings…'}</p>

  return (
    <section>
      <h2>Settings</h2>
      <p className="muted">
        Configuration is set entirely through <code>STT_*</code> environment variables (see
        <code> docker-compose.yml</code>). This page is read-only — edit the env vars and restart
        the server to change anything.
      </p>

      <div className="field">
        <span>Beacon Node URL</span>
        <div className="readonly">{s.beaconUrl || <em className="muted">not set</em>}</div>
        <small>
          <code>STT_BEACON_URL</code>
        </small>
      </div>

      <div className="field">
        <span>Execution RPC URL</span>
        <div className="readonly">{s.executionUrl || <em className="muted">not set</em>}</div>
        <small>
          <code>STT_EXECUTION_URL</code>
        </small>
      </div>

      <div className="field">
        <span>Validator indices ({s.validatorIds.length})</span>
        <div className="readonly">
          {s.validatorIds.length ? s.validatorIds.join(', ') : <em className="muted">none</em>}
        </div>
        <small>
          <code>STT_VALIDATORS</code>
        </small>
      </div>

      <div className="field">
        <span>Report currency</span>
        <div className="readonly">{s.currency.toUpperCase()}</div>
        <small>
          <code>STT_CURRENCY</code>
        </small>
      </div>
    </section>
  )
}
