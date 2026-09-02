import { useEffect, useId, useState, type ReactNode } from 'react'

import {
  getOverview,
  type DatasetOverview,
  type DimensionSummary,
  type DuplicateSummary,
  type SampleFilters,
} from '../dataset/api'
import {
  binFilters,
  filterChips,
  galleryPath,
  parseRank,
  SPLITS,
  withoutFilters,
} from '../dataset/filters'
import {
  formatDimensions,
  formatSplit,
  getErrorMessage,
} from '../dataset/formatters'
import SampleLink from '../detail/SampleLink'
import { isSampleDrawerOpen } from '../detail/sampleRoute'
import DatasetImage from '../shared/DatasetImage'
import EmptyResults from '../shared/EmptyResults'
import FilterChips from '../shared/FilterChips'
import SearchForm from '../shared/SearchForm'
import SplitSelect from '../shared/SplitSelect'
import { useFilterParams } from '../shared/useFilterParams'
import BarList from './BarList'
import Histogram from './Histogram'

type LoadState = 'loading' | 'ready' | 'error'
/** Gallery path for the current scope with `extra` applied and `clear` removed first. */
type ScopedPath = (extra: SampleFilters, clear?: readonly (keyof SampleFilters)[]) => string

function OverviewPage() {
  const {
    searchParams,
    setSearchParams,
    filters,
    requestVersion,
    refresh,
    setSplit,
    applySearch,
    removeChip,
  } = useFilterParams()
  const [overview, setOverview] = useState<DatasetOverview | null>(null)
  const [status, setStatus] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const rank = parseRank(searchParams)
  const chips = filterChips(filters)
  const scopeSuffix = Object.keys(filters).length > 0 ? ' in scope' : ''
  const empty = overview !== null && overview.sample_count === 0
  const hasSamplesInOtherSplits =
    overview !== null &&
    filters.split !== undefined &&
    empty &&
    SPLITS.some(
      (split) => split !== filters.split && overview.split_counts[split] > 0,
    )
  const busy = status === 'loading'
  const contentClass = `overview-content${busy ? ' overview-content--busy' : ''}`
  const announcement =
    status === 'loading'
      ? 'Loading overview'
      : status === 'ready' && overview
        ? empty
          ? 'No samples match the current filters.'
          : `Overview of ${overview.sample_count.toLocaleString()} samples and ${overview.caption_count.toLocaleString()} captions${scopeSuffix}`
        : ''

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    setError('')

    getOverview(filters, controller.signal)
      .then((result) => {
        setOverview(result)
        setStatus('ready')
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        setError(getErrorMessage(reason))
        setStatus('error')
      })

    return () => controller.abort()
  }, [filters, requestVersion])

  // Chart links keep the current scope and replace only the chart's own keys.
  // Ranges clear both bounds first: an open-ended bin sets only the lower one,
  // so a scoped upper bound must not survive the merge.
  const scopedPath: ScopedPath = (extra, clear = []) =>
    galleryPath({ ...withoutFilters(filters, clear), ...extra }, rank)
  const clearSampleFilters = () => setSearchParams(rank ? { rank } : {})

  return (
    <section className="overview-section" aria-labelledby="overview-title">
      <div className="toolbar">
        <h2 id="overview-title" tabIndex={-1} className="visually-hidden">
          Dataset overview
        </h2>
        <p className="visually-hidden" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>
        <div className="toolbar-controls">
          <SearchForm
            filters={filters}
            shortcutEnabled={!isSampleDrawerOpen(searchParams)}
            onSubmit={(query) => applySearch(query, rank)}
          />
          <SplitSelect value={filters.split} onChange={setSplit} />
        </div>
        <p className="toolbar-hint">
          Click a chart value to open those samples in Browse. The filter stays
          on as a removable chip on both pages.
        </p>
        <FilterChips chips={chips} onRemove={removeChip} />
      </div>

      {status === 'loading' && !overview && <OverviewSkeleton />}

      {status === 'error' && (
        <div className="state-card" role="alert">
          <span className="state-card__mark">!</span>
          <h3>Couldn’t load the overview</h3>
          <p>{error}</p>
          <p className="state-card__hint">Make sure the local API is running, then try again.</p>
          <button className="button button--primary" type="button" onClick={refresh}>
            Try again
          </button>
        </div>
      )}

      {/* Data quality is dataset-wide, so it stays even when nothing matches. */}
      {status !== 'error' && overview && empty && (
        <div className={contentClass} aria-busy={busy} inert={busy}>
          <EmptyResults
            query={filters.q ?? ''}
            hasOtherFilters={chips.some((chip) => !chip.keys.includes('q'))}
            onClearSearch={() => applySearch('', rank)}
            onClearFilters={clearSampleFilters}
          />
          {hasSamplesInOtherSplits && (
            <OverviewGroup title="Samples" description="0 samples in scope">
              <div className="overview-grid">
                <SplitComparison
                  selectedSplit={filters.split}
                  counts={overview.split_counts}
                  scopedPath={scopedPath}
                />
              </div>
            </OverviewGroup>
          )}
          <DataQuality duplicates={overview.duplicates} />
        </div>
      )}

      {/* Previous charts stay in place, dimmed and inert, while a new scope loads. */}
      {status !== 'error' && overview && !empty && (
        <div className={contentClass} aria-busy={busy} inert={busy}>
          <OverviewGroup
            title="Samples"
            description={`${overview.sample_count.toLocaleString()} samples${scopeSuffix}`}
          >
            <div className="overview-grid">
              <SplitComparison
                selectedSplit={filters.split}
                counts={overview.split_counts}
                scopedPath={scopedPath}
              />

              <ChartCard
                title="Aspect ratio"
                note="Width ÷ height; below 1 is portrait, above 1 is landscape."
              >
                <Histogram
                  bins={overview.aspect_ratios}
                  countNoun="samples"
                  binHref={(bin) =>
                    scopedPath(binFilters(bin, 'min_ratio', 'max_ratio'), [
                      'min_ratio',
                      'max_ratio',
                    ])
                  }
                />
              </ChartCard>

              <ChartCard
                title="Image dimensions"
                note="Most common exact sizes in pixels (width × height), after EXIF orientation."
                wide
              >
                <DimensionList dimensions={overview.dimensions} scopedPath={scopedPath} />
              </ChartCard>
            </div>
          </OverviewGroup>

          <OverviewGroup
            title="Captions"
            description={`${overview.caption_count.toLocaleString()} captions${scopeSuffix}`}
          >
            <div className="overview-grid">
              <ChartCard
                title="Caption length"
                note="Whitespace-separated tokens per caption. Filters select samples, and every caption of each matching sample is counted."
                wide
              >
                <Histogram
                  bins={overview.caption_lengths}
                  countNoun="captions"
                  binHref={(bin) =>
                    scopedPath(binFilters(bin, 'min_words', 'max_words'), [
                      'min_words',
                      'max_words',
                    ])
                  }
                />
              </ChartCard>

              <ChartCard
                title="Common caption terms"
                note="Most frequent words after removing short and function words. Filters select samples, and every caption of each matching sample is counted."
                wide
              >
                <BarList
                  columns
                  items={overview.top_terms.map(({ term, count }) => ({
                    key: term,
                    label: term,
                    count,
                    href: scopedPath({ term }),
                  }))}
                />
              </ChartCard>
            </div>
          </OverviewGroup>

          <DataQuality duplicates={overview.duplicates} />
        </div>
      )}
    </section>
  )
}

function OverviewGroup({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: ReactNode
}) {
  const titleId = useId()

  return (
    <section className="overview-group" aria-labelledby={titleId}>
      <div className="overview-group__heading">
        <h3 id={titleId} className="overview-group__title">
          {title}
        </h3>
        {description && <p className="overview-group__description">{description}</p>}
      </div>
      {children}
    </section>
  )
}

function ChartCard({
  title,
  note,
  wide = false,
  children,
}: {
  title: string
  note?: string
  wide?: boolean
  children: ReactNode
}) {
  return (
    <section className={`chart-card${wide ? ' chart-card--wide' : ''}`}>
      <h4>{title}</h4>
      {note && <p className="chart-card__note">{note}</p>}
      {children}
    </section>
  )
}

function SplitComparison({
  selectedSplit,
  counts,
  scopedPath,
}: {
  selectedSplit: SampleFilters['split']
  counts: DatasetOverview['split_counts']
  scopedPath: ScopedPath
}) {
  return (
    <ChartCard
      title={selectedSplit ? 'Samples by split (all splits)' : 'Samples by split'}
      note={
        selectedSplit
          ? 'Ignores the split selected above, so the other filters can be compared across splits.'
          : undefined
      }
    >
      <BarList
        activeKey={selectedSplit}
        items={SPLITS.map((split) => ({
          key: split,
          label: formatSplit(split),
          count: counts[split],
          href: scopedPath({ split }),
        }))}
      />
    </ChartCard>
  )
}

function DimensionList({
  dimensions,
  scopedPath,
}: {
  dimensions: DimensionSummary
  scopedPath: ScopedPath
}) {
  return (
    <>
      <BarList
        columns
        items={dimensions.top.map(({ width, height, count }) => ({
          key: `${width}x${height}`,
          label: formatDimensions(width, height),
          count,
          // The numeric filters are half-open, so [w, w + 1) selects exactly w.
          href: scopedPath({
            min_width: width,
            max_width: width + 1,
            min_height: height,
            max_height: height + 1,
          }),
        }))}
      />
      {dimensions.other_sample_count > 0 && (
        <p className="chart-note">
          {dimensions.other_sample_count.toLocaleString()} samples use one of{' '}
          {dimensions.other_size_count.toLocaleString()} other sizes.
        </p>
      )}
    </>
  )
}

function DataQuality({ duplicates }: { duplicates: DuplicateSummary }) {
  const hasCrossSplit = duplicates.cross_split_group_count > 0

  return (
    <OverviewGroup
      title="Data quality"
      description="Always computed over the whole dataset; the split and filters above do not apply here."
    >
      <dl className="quality-tiles">
        <div className="quality-tile">
          <dt>Duplicate groups</dt>
          <dd>{duplicates.group_count.toLocaleString()}</dd>
        </div>
        <div className="quality-tile">
          <dt>Affected images</dt>
          <dd>{duplicates.affected_sample_count.toLocaleString()}</dd>
        </div>
        <div className={`quality-tile ${hasCrossSplit ? 'quality-tile--warn' : 'quality-tile--ok'}`}>
          <dt>Cross-split groups</dt>
          <dd>{duplicates.cross_split_group_count.toLocaleString()}</dd>
          <p className="quality-tile__note">
            {hasCrossSplit
              ? 'The same image appears in more than one split — possible evaluation leakage.'
              : 'No image appears in more than one split.'}
          </p>
        </div>
      </dl>

      <h4 className="quality-subheading">Exact duplicates</h4>
      <p className="quality-description">
        Byte-identical images, detected by hashing the original file contents
        (SHA-256). Click any image to inspect it.
      </p>

      {duplicates.groups.length === 0 ? (
        <p className="muted">No exact-duplicate images in this dataset.</p>
      ) : (
        <ul className="duplicate-groups">
          {duplicates.groups.map((group) => (
            <li
              className={`duplicate-group${group.cross_split ? ' duplicate-group--cross' : ''}`}
              key={group.content_sha256}
            >
              <div className="duplicate-group__header">
                {group.cross_split && (
                  <span className="cross-split-badge">Cross-split</span>
                )}
                <span className="duplicate-group__title">
                  {group.sample_count} identical images
                </span>
                <span className="duplicate-group__hash" title={group.content_sha256}>
                  sha256:{group.content_sha256.slice(0, 12)}…
                </span>
              </div>
              <ul className="duplicate-group__samples">
                {group.samples.map((member) => (
                  <li key={member.id}>
                    <SampleLink
                      className="duplicate-sample"
                      sampleId={member.id}
                      unscoped
                      aria-label={`View details for ${member.source_id}`}
                    >
                      <DatasetImage
                        className="duplicate-sample__image"
                        src={member.thumbnail_url}
                        alt=""
                      />
                      <span className="duplicate-sample__meta">
                        <span className={`split-badge split-badge--${member.split}`}>
                          {formatSplit(member.split)}
                        </span>
                        <span className="duplicate-sample__id">{member.source_id}</span>
                      </span>
                    </SampleLink>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </OverviewGroup>
  )
}

function OverviewSkeleton() {
  return (
    <div className="overview-grid" aria-label="Loading overview">
      {Array.from({ length: 5 }, (_, index) => (
        <div className="chart-card chart-card--skeleton" key={index}>
          <div className="chart-skeleton__title" />
          <div className="chart-skeleton__body" />
        </div>
      ))}
    </div>
  )
}

export default OverviewPage
