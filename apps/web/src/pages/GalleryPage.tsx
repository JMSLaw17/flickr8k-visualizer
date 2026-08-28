import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { listSamples, type SamplePage } from '../api'
import DetailPanel from '../components/DetailPanel'
import GallerySkeleton from '../components/GallerySkeleton'
import SampleCard from '../components/SampleCard'
import { filterChips, parseOffset, parseSampleFilters, type FilterChip } from '../filters'
import { getErrorMessage, splitLabels, type SplitFilter } from '../formatters'

const PAGE_SIZE = 24

type LoadState = 'loading' | 'ready' | 'error'

function GalleryPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [page, setPage] = useState<SamplePage | null>(null)
  const [status, setStatus] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [requestVersion, setRequestVersion] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const filters = useMemo(() => parseSampleFilters(searchParams), [searchParams])
  const offset = parseOffset(searchParams)
  const chips = filterChips(filters)
  const hasFilters = chips.length > 0 || filters.split !== undefined

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    setError('')
    setPage(null)

    listSamples({ limit: PAGE_SIZE, offset, ...filters }, controller.signal)
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
  }, [filters, offset, requestVersion])

  const updateParams = (mutate: (params: URLSearchParams) => void) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous)
      mutate(next)
      return next
    })
  }

  const setOffset = (nextOffset: number) => {
    updateParams((params) => {
      if (nextOffset > 0) params.set('offset', String(nextOffset))
      else params.delete('offset')
    })
  }

  const setSplit = (value: SplitFilter) => {
    updateParams((params) => {
      params.delete('offset')
      if (value === 'all') params.delete('split')
      else params.set('split', value)
    })
  }

  const removeChip = (chip: FilterChip) => {
    updateParams((params) => {
      params.delete('offset')
      for (const key of chip.keys) params.delete(key)
    })
  }

  const pageInfo = useMemo(() => {
    if (!page) return null

    const totalPages = Math.max(1, Math.ceil(page.total / page.limit))
    const currentPage = Math.floor(page.offset / page.limit) + 1
    const firstItem = page.total === 0 ? 0 : page.offset + 1
    const lastItem = Math.min(page.offset + page.items.length, page.total)

    return { totalPages, currentPage, firstItem, lastItem }
  }, [page])

  return (
    <section className="gallery-section" aria-labelledby="gallery-title">
      <div className="toolbar">
        <div>
          <p className="eyebrow">Browse</p>
          <h2 id="gallery-title" tabIndex={-1}>
            Dataset samples
          </h2>
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
            value={filters.split ?? 'all'}
            onChange={(event) => setSplit(event.target.value as SplitFilter)}
          >
            {Object.entries(splitLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {chips.length > 0 && (
        <ul className="filter-chips" aria-label="Active filters">
          {chips.map((chip) => (
            <li className="filter-chip" key={chip.keys.join('-')}>
              <span>{chip.label}</span>
              <button
                type="button"
                aria-label={`Remove filter: ${chip.label}`}
                onClick={() => removeChip(chip)}
              >
                <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
        </ul>
      )}

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
          <p>There are no locally ingested samples matching these filters.</p>
          {hasFilters && (
            <button
              className="button button--secondary"
              type="button"
              onClick={() => setSearchParams({})}
            >
              Clear filters
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
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
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
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next →
              </button>
            </nav>
          )}
        </>
      )}

      {selectedId && <DetailPanel sampleId={selectedId} onClose={() => setSelectedId(null)} />}
    </section>
  )
}

export default GalleryPage
