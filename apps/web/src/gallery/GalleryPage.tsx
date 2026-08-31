import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { FILTER_KEYS, listSamples, type SamplePage } from '../dataset/api'
import GallerySkeleton from './GallerySkeleton'
import SampleCard from './SampleCard'
import {
  filterChips,
  MAX_CAPTION_QUERY_LENGTH,
  normalizeCaptionQuery,
  parseOffset,
  parseRank,
  type FilterChip,
  useSampleFilters,
} from '../dataset/filters'
import {
  getErrorMessage,
  splitLabels,
  type SplitFilter,
} from '../dataset/formatters'
import { isEditableTarget } from '../shared/interaction'

const PAGE_SIZE = 24

type LoadState = 'loading' | 'ready' | 'error'

function GalleryPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [page, setPage] = useState<SamplePage | null>(null)
  const [status, setStatus] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [requestVersion, setRequestVersion] = useState(0)
  // Optimistic until a listing reports otherwise; refreshed on every listing
  // so finishing `npm run prepare:data` re-enables ranking without a reload.
  const [rankingReady, setRankingReady] = useState(true)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const setSearchParamsRef = useRef(setSearchParams)

  const filters = useSampleFilters(searchParams)
  const offset = parseOffset(searchParams)
  const drawerOpen = searchParams.has('sample')
  const committedQuery = filters.q ?? ''
  // The rank description orders results by CLIP similarity; it is not a
  // filter and never changes which samples match.
  const committedRank = parseRank(searchParams)
  const rankActive = committedRank !== ''
  const [draftQuery, setDraftQuery] = useState(committedQuery)
  const [draftRank, setDraftRank] = useState(committedRank)
  const draftResetKey = JSON.stringify(
    FILTER_KEYS.filter((key) => key !== 'q').map((key) => filters[key] ?? null),
  )
  const chips: FilterChip[] = [
    ...filterChips(filters),
    ...(rankActive
      ? [{ label: `Ranked by: “${committedRank}”`, keys: ['rank'] }]
      : []),
  ]
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
    setDraftRank(committedRank)
  }, [committedRank, draftResetKey])

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

    listSamples(
      {
        limit: PAGE_SIZE,
        offset,
        ...filters,
        rank: rankActive ? committedRank : undefined,
      },
      controller.signal,
    )
      .then((result) => {
        setRankingReady(result.visual_ranking_ready)
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
  }, [committedRank, filters, offset, rankActive, requestVersion])

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

  const applySearch = (query: string, rank: string) => {
    const currentQuery = searchParams.get('q')
    const currentRank = searchParams.get('rank')
    const searchIsCurrent =
      (query ? currentQuery === query : currentQuery === null) &&
      (rank ? currentRank === rank : currentRank === null)

    if (searchIsCurrent && !searchParams.has('offset')) {
      setRequestVersion((value) => value + 1)
      return
    }

    updateParams((params) => {
      params.delete('offset')
      if (query) params.set('q', query)
      else params.delete('q')
      if (rank) params.set('rank', rank)
      else params.delete('rank')
    })
  }

  const submitSearch = () => {
    const query = normalizeCaptionQuery(draftQuery)
    const rank = normalizeCaptionQuery(draftRank)
    setDraftQuery(query)
    setDraftRank(rank)
    applySearch(query, rank)
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

  const rankSuffix = rankActive
    ? ` · ranked by similarity to “${committedRank}”`
    : ''
  const resultSummary =
    page && pageInfo && page.total > 0
      ? committedQuery
        ? `Showing ${pageInfo.firstItem.toLocaleString()}–${pageInfo.lastItem.toLocaleString()} of ${page.total.toLocaleString()} matching samples for “${committedQuery}”${rankSuffix}`
        : `Showing ${pageInfo.firstItem.toLocaleString()}–${pageInfo.lastItem.toLocaleString()} of ${page.total.toLocaleString()}${rankSuffix}`
      : ''
  const resultAnnouncement =
    status === 'loading'
      ? rankActive
        ? `Ranking images by similarity to “${committedRank}”`
        : committedQuery
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
          {/* Always rendered so the toolbar keeps its height and the search
              controls don't jump while results load. */}
          <p className="results-summary" aria-hidden="true">
            {resultSummary}
          </p>
        </div>

        <div className="gallery-controls">
          <form
            className="search-control"
            role="search"
            aria-label="Sample search"
            onSubmit={(event) => {
              event.preventDefault()
              submitSearch()
            }}
          >
            <div className="search-control__row">
              <div className="search-control__field">
                <label htmlFor="caption-search">Filter by caption</label>
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
              </div>
              <div className="search-control__field">
                <label htmlFor="visual-rank">Rank by image content</label>
                <input
                  id="visual-rank"
                  type="search"
                  value={draftRank}
                  onChange={(event) => setDraftRank(event.target.value)}
                  disabled={!rankingReady}
                  placeholder={
                    rankingReady
                      ? 'Describe image content'
                      : 'Not prepared — run npm run prepare:data'
                  }
                  title={
                    rankingReady
                      ? undefined
                      : 'Visual ranking is not prepared. Run npm run prepare:data to enable it.'
                  }
                  maxLength={MAX_CAPTION_QUERY_LENGTH}
                />
              </div>
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
          <h3>
            {rankActive
              ? 'Couldn’t rank images'
              : committedQuery
                ? 'Couldn’t search captions'
                : 'Couldn’t load the dataset'}
          </h3>
          <p>{error}</p>
          <p className="state-card__hint">
            {rankActive && error.includes('Visual search is not prepared')
              ? 'Run npm run prepare:data to build the visual ranking index, then try again.'
              : 'Make sure the local API is running, then try again.'}
          </p>
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
                onClick={() => applySearch('', committedRank)}
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
              <SampleCard key={sample.id} sample={sample} query={committedQuery} />
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
