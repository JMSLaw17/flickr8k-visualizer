import { useEffect, useMemo, useRef, useState } from 'react'

import { listSamples, type SamplePage } from '../dataset/api'
import GallerySkeleton from './GallerySkeleton'
import SampleCard from './SampleCard'
import { filterChips, parseOffset, parseOrdering, type FilterChip } from '../dataset/filters'
import { getErrorMessage } from '../dataset/formatters'
import { isSampleDrawerOpen } from '../detail/sampleRoute'
import EmptyResults from '../shared/EmptyResults'
import FilterChips from '../shared/FilterChips'
import SearchForm from '../shared/SearchForm'
import SplitSelect from '../shared/SplitSelect'
import { useFilterParams } from '../shared/useFilterParams'

const PAGE_SIZE = 24

type LoadState = 'loading' | 'ready' | 'error'

function GalleryPage() {
  const {
    searchParams,
    setSearchParams,
    filters,
    requestVersion,
    refresh,
    updateParams,
    setSplit,
    applySearch,
    removeChip,
    resetView,
  } = useFilterParams()
  const [page, setPage] = useState<SamplePage | null>(null)
  const [status, setStatus] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  // Optimistic until a listing reports otherwise; refreshed on every listing
  // so finishing `npm run prepare:data` re-enables ranking without a reload.
  const [rankingReady, setRankingReady] = useState(true)
  const setSearchParamsRef = useRef(setSearchParams)

  const offset = parseOffset(searchParams)
  const committedQuery = filters.q ?? ''
  // An ordering, by a description or by a reference image, sorts results by
  // CLIP similarity; it is not a filter and never changes which samples match.
  const ordering = parseOrdering(searchParams)
  const committedRank = ordering.rank ?? ''
  const rankActive = committedRank !== ''
  const similarTo = ordering.similar_to ?? ''
  const similarActive = similarTo !== ''
  const orderingActive = rankActive || similarActive
  const orderingLabel = rankActive
    ? `similarity to “${committedRank}”`
    : similarActive
      ? `similarity to image ${similarTo}`
      : ''
  const chips: FilterChip[] = [
    ...filterChips(filters),
    ...(rankActive
      ? [{ label: `Ranked by: “${committedRank}”`, keys: ['rank'] }]
      : []),
    ...(similarActive ? [{ label: `Similar to: ${similarTo}`, keys: ['similar_to'] }] : []),
  ]
  const hasOtherFilters = chips.some((chip) => !chip.keys.includes('q'))

  useEffect(() => {
    setSearchParamsRef.current = setSearchParams
  }, [setSearchParams])

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
        similar_to: similarActive ? similarTo : undefined,
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
  }, [committedRank, filters, offset, rankActive, requestVersion, similarActive, similarTo])

  const setOffset = (nextOffset: number) => {
    updateParams((params) => {
      if (nextOffset > 0) params.set('offset', String(nextOffset))
      else params.delete('offset')
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

  const rankSuffix = orderingActive ? ` · ranked by ${orderingLabel}` : ''
  const resultSummary =
    page && pageInfo && page.total > 0
      ? committedQuery
        ? `Showing ${pageInfo.firstItem.toLocaleString()}–${pageInfo.lastItem.toLocaleString()} of ${page.total.toLocaleString()} matching samples for “${committedQuery}”${rankSuffix}`
        : `Showing ${pageInfo.firstItem.toLocaleString()}–${pageInfo.lastItem.toLocaleString()} of ${page.total.toLocaleString()}${rankSuffix}`
      : ''
  const resultAnnouncement =
    status === 'loading'
      ? orderingActive
        ? `Ranking images by ${orderingLabel}`
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
        <h2 id="gallery-title" tabIndex={-1} className="visually-hidden">
          Dataset samples
        </h2>
        <p className="visually-hidden" aria-live="polite" aria-atomic="true">
          {resultAnnouncement}
        </p>

        <div className="toolbar-controls">
          <SearchForm
            filters={filters}
            rank={{ value: committedRank, ready: rankingReady }}
            shortcutEnabled={!isSampleDrawerOpen(searchParams)}
            onSubmit={applySearch}
          />
          <SplitSelect value={filters.split} onChange={setSplit} />
        </div>

        <FilterChips chips={chips} onRemove={removeChip} />
      </div>

      {/* Always rendered so the layout keeps its height and the grid
          doesn't jump while results load. */}
      <p className="results-summary results-summary--grid" aria-hidden="true">
        {resultSummary}
      </p>

      {status === 'loading' && <GallerySkeleton />}

      {status === 'error' && (
        <div className="state-card" role="alert">
          <span className="state-card__mark">!</span>
          <h3>
            {orderingActive
              ? 'Couldn’t rank images'
              : committedQuery
                ? 'Couldn’t search captions'
                : 'Couldn’t load the dataset'}
          </h3>
          <p>{error}</p>
          <p className="state-card__hint">
            {orderingActive && error.includes('Visual search is not prepared')
              ? 'Run npm run prepare:data to build the visual ranking index, then try again.'
              : 'Make sure the local API is running, then try again.'}
          </p>
          <button
            className="button button--primary"
            type="button"
            onClick={refresh}
          >
            Try again
          </button>
        </div>
      )}

      {status === 'ready' && page && page.items.length === 0 && (
        <EmptyResults
          query={committedQuery}
          hasOtherFilters={hasOtherFilters}
          onClearSearch={() => applySearch('', committedRank)}
          onClearFilters={resetView}
        />
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
