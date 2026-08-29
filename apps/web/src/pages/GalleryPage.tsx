import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { FILTER_KEYS, listSamples, type SamplePage } from '../api'
import GallerySkeleton from '../components/GallerySkeleton'
import SampleCard from '../components/SampleCard'
import {
  filterChips,
  MAX_CAPTION_QUERY_LENGTH,
  normalizeCaptionQuery,
  parseOffset,
  type FilterChip,
  useSampleFilters,
} from '../filters'
import { getErrorMessage, splitLabels, type SplitFilter } from '../formatters'
import { isEditableTarget } from '../interaction'

const PAGE_SIZE = 24

type LoadState = 'loading' | 'ready' | 'error'

function GalleryPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [page, setPage] = useState<SamplePage | null>(null)
  const [status, setStatus] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [requestVersion, setRequestVersion] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const setSearchParamsRef = useRef(setSearchParams)

  const filters = useSampleFilters(searchParams)
  const offset = parseOffset(searchParams)
  const drawerOpen = searchParams.has('sample')
  const committedQuery = filters.q ?? ''
  const [draftQuery, setDraftQuery] = useState(committedQuery)
  const draftResetKey = JSON.stringify(
    FILTER_KEYS.filter((key) => key !== 'q').map((key) => filters[key] ?? null),
  )
  const chips = filterChips(filters)
  const hasFilters = chips.length > 0 || filters.split !== undefined
  const hasOtherFilters =
    filters.split !== undefined || chips.some((chip) => !chip.keys.includes('q'))

  useEffect(() => {
    setSearchParamsRef.current = setSearchParams
  }, [setSearchParams])

  useEffect(() => {
    setDraftQuery(committedQuery)
  }, [committedQuery, draftResetKey])

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (
        event.key !== '/' ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        drawerOpen ||
        isEditableTarget(event.target)
      ) {
        return
      }

      event.preventDefault()
      searchInputRef.current?.focus()
    }

    document.addEventListener('keydown', focusSearch)
    return () => document.removeEventListener('keydown', focusSearch)
  }, [drawerOpen])

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    setError('')
    setPage(null)

    listSamples({ limit: PAGE_SIZE, offset, ...filters }, controller.signal)
      .then((result) => {
        if (result.total > 0 && result.items.length === 0 && result.offset > 0) {
          setSearchParamsRef.current((previous) => {
            const next = new URLSearchParams(previous)
            next.delete('offset')
            return next
          }, { replace: true })
          return
        }

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

  const applySearch = (query: string) => {
    const currentQuery = searchParams.get('q')
    const queryIsCurrent = query ? currentQuery === query : currentQuery === null

    if (queryIsCurrent && !searchParams.has('offset')) {
      setRequestVersion((value) => value + 1)
      return
    }

    updateParams((params) => {
      params.delete('offset')
      if (query) params.set('q', query)
      else params.delete('q')
    })
  }

  const submitSearch = () => {
    const query = normalizeCaptionQuery(draftQuery)
    setDraftQuery(query)
    applySearch(query)
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

  const resultSummary =
    page && pageInfo && page.total > 0
      ? committedQuery
        ? `Showing ${pageInfo.firstItem.toLocaleString()}–${pageInfo.lastItem.toLocaleString()} of ${page.total.toLocaleString()} matching samples for “${committedQuery}”`
        : `Showing ${pageInfo.firstItem.toLocaleString()}–${pageInfo.lastItem.toLocaleString()} of ${page.total.toLocaleString()}`
      : ''
  const resultAnnouncement =
    status === 'loading'
      ? committedQuery
        ? `Searching captions for “${committedQuery}”`
        : 'Loading samples'
      : status === 'ready' && page?.total === 0
        ? committedQuery
          ? `No samples match the caption search for “${committedQuery}” and the current filters.`
          : 'No samples match the current filters.'
        : resultSummary

  return (
    <section className="gallery-section" aria-labelledby="gallery-title">
      <div className="toolbar">
        <div>
          <p className="eyebrow">Browse</p>
          <h2 id="gallery-title" tabIndex={-1}>
            Dataset samples
          </h2>
          <p className="visually-hidden" aria-live="polite" aria-atomic="true">
            {resultAnnouncement}
          </p>
          {resultSummary && (
            <p className="results-summary" aria-hidden="true">
              {resultSummary}
            </p>
          )}
        </div>

        <div className="gallery-controls">
          <form
            className="search-control"
            role="search"
            aria-label="Caption search"
            onSubmit={(event) => {
              event.preventDefault()
              submitSearch()
            }}
          >
            <label htmlFor="caption-search">Search captions</label>
            <div className="search-control__row">
              <input
                ref={searchInputRef}
                id="caption-search"
                type="search"
                aria-keyshortcuts="/"
                value={draftQuery}
                onChange={(event) => setDraftQuery(event.target.value)}
                placeholder="Enter an exact phrase"
                maxLength={MAX_CAPTION_QUERY_LENGTH}
              />
              <button className="button button--primary" type="submit">
                Search
              </button>
            </div>
          </form>

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
          <h3>{committedQuery ? 'Couldn’t search captions' : 'Couldn’t load the dataset'}</h3>
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
          <h3>{committedQuery ? 'No matching captions' : 'No samples found'}</h3>
          <p>
            {committedQuery
              ? `No samples in the current filters have captions matching “${committedQuery}”.`
              : 'There are no locally ingested samples matching these filters.'}
          </p>
          {committedQuery ? (
            <div className="state-card__actions">
              <button
                className="button button--secondary"
                type="button"
                onClick={() => applySearch('')}
              >
                Clear search
              </button>
              {hasOtherFilters && (
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => setSearchParams({})}
                >
                  Clear all filters
                </button>
              )}
            </div>
          ) : hasFilters ? (
            <button
              className="button button--secondary"
              type="button"
              onClick={() => setSearchParams({})}
            >
              Clear filters
            </button>
          ) : null}
        </div>
      )}

      {status === 'ready' && page && page.items.length > 0 && (
        <>
          <div className="gallery-grid">
            {page.items.map((sample) => (
              <SampleCard
                key={sample.id}
                sample={sample}
                query={committedQuery}
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
    </section>
  )
}

export default GalleryPage
