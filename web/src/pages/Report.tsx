import { useEffect, useState } from 'react'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts'
import { useData } from '../state/DataContext'
import { api, type TaxReport, type IncomeRow } from '../api'

type Method = 'accrual' | 'receipt'

/**
 * Aggregate consensus + execution income by a key (YYYY-MM or YYYY-MM-DD),
 * keeping the two income types separate so they can be stacked in the chart.
 */
function aggregate(consensus: IncomeRow[], execution: IncomeRow[], keyLen: number) {
  type Acc = { consEth: number; execEth: number; consEur: number; execEur: number }
  const map = new Map<string, Acc>()
  const get = (k: string): Acc => {
    let a = map.get(k)
    if (!a) map.set(k, (a = { consEth: 0, execEth: 0, consEur: 0, execEur: 0 }))
    return a
  }
  for (const r of consensus) {
    const a = get(r.date.slice(0, keyLen))
    a.consEth += r.amountEth
    a.consEur += r.valueEur ?? 0
  }
  for (const r of execution) {
    const a = get(r.date.slice(0, keyLen))
    a.execEth += r.amountEth
    a.execEur += r.valueEur ?? 0
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, v]) => ({
      key,
      consEth: Number(v.consEth.toFixed(6)),
      execEth: Number(v.execEth.toFixed(6)),
      consEur: Number(v.consEur.toFixed(2)),
      execEur: Number(v.execEur.toFixed(2)),
    }))
}

export default function Report() {
  const { summary } = useData()
  const years = summary?.years ?? []
  const [method, setMethod] = useState<Method>('receipt')
  const [year, setYear] = useState<number | null>(null)
  const [report, setReport] = useState<TaxReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Month drilled into via the chart (YYYY-MM); also filters the tables below.
  const [month, setMonth] = useState<string | null>(null)

  const activeYear = year ?? years[0] ?? new Date().getUTCFullYear()

  useEffect(() => {
    let cancelled = false
    setError(null)
    setMonth(null) // a different year/method invalidates the drilled-in month
    api
      .report(activeYear, method)
      .then((r) => !cancelled && setReport(r))
      .catch((e) => !cancelled && setError(String(e)))
    return () => {
      cancelled = true
    }
  }, [activeYear, method])

  if (!summary) return <p className="muted">Collect data on the Dashboard first.</p>
  const cur = (report?.currency ?? 'eur').toUpperCase()

  return (
    <section className="report">
      <div className="row no-print">
        <h2>Tax report</h2>
        <label>
          Year{' '}
          <select value={activeYear} onChange={(e) => setYear(Number(e.target.value))}>
            {(years.length ? years : [activeYear]).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <label>
          Method{' '}
          <select value={method} onChange={(e) => setMethod(e.target.value as Method)}>
            <option value="accrual">Accrual (daily earned)</option>
            <option value="receipt">Receipt (on withdrawal)</option>
          </select>
        </label>
        <a className="btn" href={api.csvUrl(activeYear, method)}>
          Download CSV
        </a>
        <button className="secondary" onClick={() => window.print()}>
          Print / PDF
        </button>
      </div>

      <div className="print-only report-head">
        <h2>
          ETH staking income {activeYear} — {method === 'accrual' ? 'accrual basis' : 'receipt basis'}
        </h2>
      </div>

      {error && <p className="error">{error}</p>}
      {report && (
        <>
          <div className="cards">
            <Card label={`Staking income (${cur})`} value={report.totalIncomeEur.toFixed(2)} />
            <Card label="Staking income (ETH)" value={report.totalIncomeEth.toFixed(6)} />
            <Card label={`EL rewards (${cur})`} value={report.totalExecutionEur.toFixed(2)} />
            <Card label="EL rewards (ETH)" value={report.totalExecutionEth.toFixed(6)} />
          </div>

          {report.rows.length === 0 && (
            <p className="muted">
              No {method === 'accrual' ? 'accrued income' : 'withdrawals'} recorded for {activeYear} yet.
              {method === 'accrual'
                ? ' Accrual needs daily balances (historical ones require an archive node); try the Receipt basis.'
                : ' If a scan is still running for this year, it will appear once it finishes.'}
            </p>
          )}

          <MonthlyChart
            rows={report.rows}
            execution={report.executionRows}
            cur={cur}
            method={method}
            month={month}
            setMonth={setMonth}
          />

          {report.gaps.length > 0 && (
            <div className="warn">
              <strong>Data notes:</strong>
              <ul>
                {report.gaps.map((g, i) => (
                  <li key={i}>{g.message}</li>
                ))}
              </ul>
            </div>
          )}

          <Table
            title={(method === 'accrual' ? 'Daily accrued income' : 'Withdrawals') + (month ? ` — ${month}` : '')}
            rows={month ? report.rows.filter((r) => r.date.startsWith(month)) : report.rows}
            cur={cur}
          />
          {report.executionRows.length > 0 && (
            <Table
              title={'Execution-layer rewards' + (month ? ` — ${month}` : '')}
              rows={month ? report.executionRows.filter((r) => r.date.startsWith(month)) : report.executionRows}
              cur={cur}
            />
          )}
        </>
      )}
    </section>
  )
}

function MonthlyChart({
  rows,
  execution,
  cur,
  method,
  month,
  setMonth,
}: {
  rows: IncomeRow[]
  execution: IncomeRow[]
  cur: string
  method: Method
  month: string | null
  setMonth: (m: string | null) => void
}) {
  // Toggle whole currency groups (each is a stacked pair). EUR hidden by default.
  const [hidden, setHidden] = useState<Record<string, boolean>>({ eur: true })
  const label = method === 'receipt' ? 'Withdrawals' : 'Accrued income'
  const groupOf = (key?: string) => (key?.toLowerCase().endsWith('eur') ? 'eur' : 'eth')
  const toggle = (key?: string) => {
    const g = groupOf(key)
    setHidden((h) => ({ ...h, [g]: !h[g] }))
  }

  const byMonth = (rs: IncomeRow[]) => (month ? rs.filter((r) => r.date.startsWith(month)) : rs)
  const monthly = aggregate(rows, execution, 7)
  const data = month ? aggregate(byMonth(rows), byMonth(execution), 10) : monthly
  if (!monthly.length) return null

  return (
    <>
      <h3 className="row" style={{ gap: '0.75rem' }}>
        {month ? (
          <>
            <button className="secondary no-print" onClick={() => setMonth(null)}>
              ← Months
            </button>
            <span>
              {label} + EL per day — {month}
            </span>
          </>
        ) : (
          <span>
            {label} + EL per month{' '}
            <small className="muted no-print">— stacked; click a bar for daily detail</small>
          </span>
        )}
      </h3>
      <div style={{ width: '100%', height: 280 }}>
        <ResponsiveContainer>
          <BarChart
            data={data}
            onClick={(s) => {
              if (!month && s && (s as { activeLabel?: string }).activeLabel) {
                setMonth((s as { activeLabel?: string }).activeLabel!)
              }
            }}
          >
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="key" />
            <YAxis yAxisId="eur" orientation="left" stroke="#627eea" />
            <YAxis yAxisId="eth" orientation="right" stroke="#3fb950" />
            <Tooltip
              formatter={(value: number, name: string) =>
                name.includes('ETH') ? [`${value} ETH`, name] : [`${value.toFixed(2)} ${cur}`, name]
              }
            />
            <Legend
              onClick={(e) => toggle((e as { dataKey?: string }).dataKey)}
              wrapperStyle={{ cursor: 'pointer' }}
              formatter={(value, entry) => (
                <span style={{ opacity: hidden[groupOf((entry as { dataKey?: string }).dataKey)] ? 0.4 : 1 }}>
                  {value}
                </span>
              )}
            />
            <Bar yAxisId="eth" dataKey="consEth" stackId="eth" fill="#3fb950" name="Consensus (ETH)" hide={hidden.eth} cursor={month ? 'default' : 'pointer'} />
            <Bar yAxisId="eth" dataKey="execEth" stackId="eth" fill="#1f6feb" name="Execution (ETH)" hide={hidden.eth} cursor={month ? 'default' : 'pointer'} />
            <Bar yAxisId="eur" dataKey="consEur" stackId="eur" fill="#627eea" name={`Consensus (${cur})`} hide={hidden.eur} cursor={month ? 'default' : 'pointer'} />
            <Bar yAxisId="eur" dataKey="execEur" stackId="eur" fill="#a371f7" name={`Execution (${cur})`} hide={hidden.eur} cursor={month ? 'default' : 'pointer'} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </>
  )
}

function Table({ title, rows, cur }: { title: string; rows: IncomeRow[]; cur: string }) {
  if (!rows.length) return null
  return (
    <>
      <h3>{title}</h3>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>ETH</th>
            <th>Price ({cur})</th>
            <th>Value ({cur})</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.date}</td>
              <td>{r.amountEth.toFixed(9)}</td>
              <td>{r.priceEur != null ? r.priceEur.toFixed(2) : '—'}</td>
              <td>{r.valueEur != null ? r.valueEur.toFixed(2) : '—'}</td>
              <td>{r.note ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div className="card">
      <div className="card-value">{value}</div>
      <div className="card-label">{label}</div>
    </div>
  )
}
