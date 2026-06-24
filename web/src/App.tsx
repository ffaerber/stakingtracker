import { NavLink, Route, Routes } from 'react-router-dom'
import { DataProvider } from './state/DataContext'
import Dashboard from './pages/Dashboard'
import Report from './pages/Report'
import Settings from './pages/Settings'

export default function App() {
  return (
    <DataProvider>
      <header className="topbar">
        <h1>ETH Staking Tax Tracker</h1>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/report">Report</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
      </header>
      <main className="container">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/report" element={<Report />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
      <footer className="disclaimer">
        Not tax advice. This is a reporting aid; figures depend on third-party API data and may be
        incomplete. Verify against official sources before filing.
      </footer>
    </DataProvider>
  )
}
