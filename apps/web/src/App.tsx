import { useEffect, useMemo, useState } from 'react'

import { listSamples, type SamplePage } from './api'
import DetailPanel from './components/DetailPanel'
import GallerySkeleton from './components/GallerySkeleton'
import SampleCard from './components/SampleCard'
import { getErrorMessage, splitLabels, type SplitFilter } from './formatters'

const PAGE_SIZE = 24

type LoadState = 'loading' | 'ready' | 'error'

function App() {
  const [split, setSplit] = useState<SplitFilter>('all')
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<SamplePage | null>(null)
  const [status, setStatus] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [requestVersion, setRequestVersion] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    setError('')
    setPage(null)

    listSamples(
      {
        limit: PAGE_SIZE,
        offset,
        split: split === 'all' ? undefined : split,
      },
      controller.signal,
    )
      .then((result) => {
        setPage(result)
        setStatus('ready')
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        setError(getErrorMessage(reason))
        setStatus('error')
      })

    return () => controller.abort()
  }, [offset, requestVersion, split])

  const pageInfo = useMemo(() => {
    if (!page) return null

    const totalPages = Math.max(1, Math.ceil(page.total / page.limit))
    const currentPage = Math.floor(page.offset / page.limit) + 1
    const firstItem = page.total === 0 ? 0 : page.offset + 1
    const lastItem = Math.min(page.offset + page.items.length, page.total)

    return { totalPages, currentPage, firstItem, lastItem }
  }, [page])

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-copy">
          <p className="eyebrow">Local dataset workspace</p>
          <h1>Flickr8k Explorer</h1>
          <p className="header-description">
            Browse images, compare captions, and inspect the records behind the dataset.
          </p>
        </div>
        <div className="local-status">
          <span className="local-status__dot" aria-hidden="true" />
          <span>
            <strong>Local dataset</strong>
            {page ? `${page.total.toLocaleString()} matching samples` : 'Ready to explore'}
          </span>
        </div>
      </header>

      <main>
        <section className="gallery-section" aria-labelledby="gallery-title">
          <div className="toolbar">
            <div>
              <p className="eyebrow">Browse</p>
              <h2 id="gallery-title">Dataset samples</h2>
              {page && pageInfo && (
                <p className="results-summary" aria-live="polite">
                  Showing {pageInfo.firstItem.toLocaleString()}–
                  {pageInfo.lastItem.toLocaleString()} of {page.total.toLocaleString()}
                </p>
              )}
            </div>

            <label className="filter-control">
              <span>Dataset split</span>
              <select
                value={split}
                onChange={(event) => {
                  setSplit(event.target.value as SplitFilter)
                  setOffset(0)
                }}
              >
                {Object.entries(splitLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {status === 'loading' && <GallerySkeleton />}

          {status === 'error' && (
            <div className="state-card" role="alert">
              <span className="state-card__mark">!</span>
              <h3>Couldn’t load the dataset</h3>
              <p>{error}</p>
              <p className="state-card__hint">Make sure the local API is running, then try again.</p>
              <button
                className="button button--primary"
                type="button"
                onClick={() => setRequestVersion((value) => value + 1)}
              >
                Try again
              </button>
            </div>
          )}

          {status === 'ready' && page && page.items.length === 0 && (
            <div className="state-card">
              <span className="state-card__mark">0</span>
              <h3>No samples found</h3>
              <p>There are no locally ingested samples in this split.</p>
              {split !== 'all' && (
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => {
                    setSplit('all')
                    setOffset(0)
                  }}
                >
                  View all splits
                </button>
              )}
            </div>
          )}

          {status === 'ready' && page && page.items.length > 0 && (
            <>
              <div className="gallery-grid">
                {page.items.map((sample) => (
                  <SampleCard
                    key={sample.id}
                    sample={sample}
                    onOpen={() => setSelectedId(sample.id)}
                  />
                ))}
              </div>

              {pageInfo && pageInfo.totalPages > 1 && (
                <nav className="pagination" aria-label="Gallery pages">
                  <button
                    className="button button--secondary"
                    type="button"
                    disabled={pageInfo.currentPage === 1}
                    onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
                  >
                    ← Previous
                  </button>
                  <span>
                    Page <strong>{pageInfo.currentPage.toLocaleString()}</strong> of{' '}
                    {pageInfo.totalPages.toLocaleString()}
                  </span>
                  <button
                    className="button button--secondary"
                    type="button"
                    disabled={pageInfo.currentPage === pageInfo.totalPages}
                    onClick={() => setOffset((value) => value + PAGE_SIZE)}
                  >
                    Next →
                  </button>
                </nav>
              )}
            </>
          )}
        </section>
      </main>

      <footer>
        <span>Flickr8k</span>
        <span>Stored and served locally</span>
      </footer>

      {selectedId && <DetailPanel sampleId={selectedId} onClose={() => setSelectedId(null)} />}
    </div>
  )
}

export default App
