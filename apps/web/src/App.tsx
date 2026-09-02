import { useEffect, useRef } from 'react'
import {
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useSearchParams,
} from 'react-router-dom'

import { parseOrdering, sampleFiltersKey, withOrdering } from './dataset/filters'
import RoutedDetailPanel from './detail/RoutedDetailPanel'
import GalleryPage from './gallery/GalleryPage'
import OverviewPage from './overview/OverviewPage'
import { getRouteMetadata } from './routes'

function RouteChangeEffects() {
  const { pathname } = useLocation()
  const previousPathname = useRef(pathname)

  useEffect(() => {
    const metadata = getRouteMetadata(pathname)
    if (!metadata) return

    document.title = metadata.title
    if (previousPathname.current === pathname) return

    previousPathname.current = pathname
    document.getElementById(metadata.headingId)?.focus()
  }, [pathname])

  return null
}

function App() {
  const [searchParams] = useSearchParams()
  // Both pages keep their filters in the URL, so switching pages keeps the
  // scope. The ranking rides along so a round trip does not lose it, while
  // pagination and the open sample stay page-specific.
  const scope = withOrdering(
    new URLSearchParams(sampleFiltersKey(searchParams)),
    parseOrdering(searchParams),
  ).toString()

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
            <NavLink to={{ pathname: '/', search: scope }} end>
              Browse
            </NavLink>
            <NavLink to={{ pathname: '/overview', search: scope }}>Overview</NavLink>
          </nav>
        </div>
      </header>

      <main>
        <Routes>
          <Route path="/" element={<GalleryPage />} />
          <Route path="/overview" element={<OverviewPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>

      <RoutedDetailPanel />

      <footer>
        <span>Flickr8k</span>
        <span>Stored and served locally</span>
      </footer>
    </div>
  )
}

export default App
