import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import './styles.css'

// HashRouter (not BrowserRouter): Swarm serves the app under /bzz/<hash>/ with
// no server-side rewrites, so URL-path routing would break. Hash routing works
// from any mount point.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
)
