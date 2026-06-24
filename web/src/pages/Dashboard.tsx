import { useData } from '../state/DataContext'
import type { ValidatorStatus } from '../api'

// Operational view: are my validators running and online? Income/tax lives on
// the Report page; this page is live status straight from the beacon node.

function statusLabel(s: string): string {
  if (s.startsWith('active')) return 'Active'
  if (s.startsWith('pending')) return 'Pending'
  if (s.includes('slashed')) return 'Slashed'
  if (s.startsWith('exited')) return 'Exited'
  if (s.startsWith('withdrawal')) return 'Withdrawn'
  return s
}

function OnlineBadge({ v }: { v: ValidatorStatus }) {
  if (!v.status.startsWith('active')) return <span className="muted">—</span>
  if (v.online === true) return <span className="ok">● Online</span>
  if (v.online === false) return <span className="error">● Offline</span>
  return <span className="muted">unknown</span>
}

export default function Dashboard() {
  const { status, validators, collecting, error, collect } = useData()
  const configured = status?.configured ?? false
  const lastCollected = status?.lastCollectedAt
    ? new Date(status.lastCollectedAt).toLocaleString()
    : 'never'

  const active = (validators ?? []).filter((v) => v.status.startsWith('active'))
  const online = active.filter((v) => v.online === true).length
  const offline = active.filter((v) => v.online === false).length

  return (
    <section>
      <div className="row">
        <h2>Validators</h2>
        <button onClick={() => void collect()} disabled={collecting || !configured}>
          {collecting ? 'Collecting…' : 'Collect / Refresh data'}
        </button>
      </div>

      {!configured && (
        <p className="warn">
          Set <code>STT_BEACON_URL</code> and <code>STT_VALIDATORS</code> in the environment, then
          restart the server.
        </p>
      )}
      {collecting && (
        <p className="muted">{status?.collector.progress || 'Collecting from your beacon node…'}</p>
      )}
      {error && <p className="error">{error}</p>}

      {validators == null ? (
        <p className="muted">Loading validators from your beacon node…</p>
      ) : validators.length === 0 ? (
        <p className="muted">No validators configured.</p>
      ) : (
        <>
          <p className="muted">
            {validators.length} tracked · {active.length} active · {online} online
            {offline > 0 && <span className="error"> · {offline} offline</span>}
          </p>
          <table>
            <thead>
              <tr>
                <th>Index</th>
                <th>Status</th>
                <th>Online</th>
                <th>Balance (ETH)</th>
              </tr>
            </thead>
            <tbody>
              {validators.map((v) => (
                <tr key={v.index}>
                  <td>{v.index}</td>
                  <td>{statusLabel(v.status)}</td>
                  <td>
                    <OnlineBadge v={v} />
                  </td>
                  <td>{v.balanceEth.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <p className="muted">Last collected: {lastCollected}</p>
    </section>
  )
}
