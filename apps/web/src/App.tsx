import { useEffect, useRef } from 'react'
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom'

import GalleryPage from './pages/GalleryPage'
import OverviewPage from './pages/OverviewPage'

const routeMetadata: Record<string, { headingId: string; title: string }> = {
  '/': { headingId: 'gallery-title', title: 'Browse · Flickr8k Explorer' },
  '/overview': {
    headingId: 'overview-title',
    title: 'Dataset overview · Flickr8k Explorer',
  },
}

function RouteChangeEffects() {
  const { pathname } = useLocation()
  const previousPathname = useRef(pathname)

  useEffect(() => {
    const metadata = routeMetadata[pathname]
    if (!metadata) return

    document.title = metadata.title
    if (previousPathname.current === pathname) return

    previousPathname.current = pathname
    document.getElementById(metadata.headingId)?.focus()
  }, [pathname])

  return null
}

function App() {
  return (
    <div className="app-shell">
      <RouteChangeEffects />
      <header className="app-header">
        <div className="header-copy">
          <p className="eyebrow">Local dataset workspace</p>
          <h1>Flickr8k Explorer</h1>
          <p className="header-description">
            Browse images, compare captions, and inspect the dataset.
          </p>
        </div>
        <div className="header-side">
          <nav className="site-nav" aria-label="Primary">
            <NavLink to="/" end>
              Browse
            </NavLink>
            <NavLink to="/overview">Overview</NavLink>
          </nav>
          <div className="local-status">
            <span className="local-status__dot" aria-hidden="true" />
            <span>
              <strong>Local dataset</strong>
              Prepared and served from this machine
            </span>
          </div>
        </div>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<GalleryPage />} />
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <footer>
        <span>Flickr8k</span>
        <span>Stored and served locally</span>
      </footer>
    </div>
  )
}

export default App
