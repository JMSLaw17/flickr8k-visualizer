import { useEffect, useState, type ReactNode } from 'react'

import { getOverview, type DatasetOverview, type DuplicateSummary } from '../api'
import BarList from '../components/BarList'
import DatasetImage from '../components/DatasetImage'
import DetailPanel from '../components/DetailPanel'
import Histogram from '../components/Histogram'
import { binFilters, galleryPath, SPLITS } from '../filters'
import { formatSplit, getErrorMessage } from '../formatters'

type LoadState = 'loading' | 'ready' | 'error'

function OverviewPage() {
  const [overview, setOverview] = useState<DatasetOverview | null>(null)
  const [status, setStatus] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [requestVersion, setRequestVersion] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setStatus('loading')
    setError('')

    getOverview(controller.signal)
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
  }, [requestVersion])

  return (
    <section className="overview-section" aria-labelledby="overview-title">
      <div className="toolbar">
        <div>
          <p className="eyebrow">Understand</p>
          <h2 id="overview-title" tabIndex={-1}>
            Dataset overview
          </h2>
          {status === 'ready' && overview && (
            <p className="results-summary">
              {overview.sample_count.toLocaleString()} samples ·{' '}
              {overview.caption_count.toLocaleString()} captions · chart values open
              the matching gallery page
            </p>
          )}
        </div>
      </div>

      {status === 'loading' && <OverviewSkeleton />}

      {status === 'error' && (
        <div className="state-card" role="alert">
          <span className="state-card__mark">!</span>
          <h3>Couldn’t load the overview</h3>
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

      {status === 'ready' && overview && (
        <>
          <div className="overview-grid">
            <ChartCard title="Samples by split">
              <BarList
                items={SPLITS.map((split) => ({
                  key: split,
                  label: formatSplit(split),
                  count: overview.split_counts[split] ?? 0,
                  href: galleryPath({ split }),
                }))}
              />
            </ChartCard>

            <ChartCard
              title="Caption length"
              note="Whitespace-separated tokens per caption, across all five captions."
            >
              <Histogram
                bins={overview.caption_lengths}
                countNoun="captions"
                binHref={(bin) => galleryPath(binFilters(bin, 'min_words', 'max_words'))}
              />
            </ChartCard>

            <ChartCard
              title="Common caption terms"
              note="Most frequent words after removing short and function words."
              wide
            >
              <BarList
                columns
                items={overview.top_terms.map(({ term, count }) => ({
                  key: term,
                  label: term,
                  count,
                  href: galleryPath({ term }),
                }))}
              />
            </ChartCard>

            <ChartCard title="Image width" note="Pixels, after EXIF orientation.">
              <Histogram
                bins={overview.widths}
                countNoun="samples"
                binHref={(bin) => galleryPath(binFilters(bin, 'min_width', 'max_width'))}
              />
            </ChartCard>

            <ChartCard title="Image height" note="Pixels, after EXIF orientation.">
              <Histogram
                bins={overview.heights}
                countNoun="samples"
                binHref={(bin) => galleryPath(binFilters(bin, 'min_height', 'max_height'))}
              />
            </ChartCard>

            <ChartCard
              title="Aspect ratio"
              note="Width ÷ height; below 1 is portrait, above 1 is landscape."
            >
              <Histogram
                bins={overview.aspect_ratios}
                countNoun="samples"
                binHref={(bin) => galleryPath(binFilters(bin, 'min_ratio', 'max_ratio'))}
              />
            </ChartCard>
          </div>

          <DataQuality duplicates={overview.duplicates} onOpenSample={setSelectedId} />
        </>
      )}

      {selectedId && <DetailPanel sampleId={selectedId} onClose={() => setSelectedId(null)} />}
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
      <h3>{title}</h3>
      {note && <p className="chart-card__note">{note}</p>}
      {children}
    </section>
  )
}

function DataQuality({
  duplicates,
  onOpenSample,
}: {
  duplicates: DuplicateSummary
  onOpenSample: (id: string) => void
}) {
  const hasCrossSplit = duplicates.cross_split_group_count > 0

  return (
    <section className="quality-section" aria-labelledby="quality-title">
      <div className="quality-heading">
        <p className="eyebrow">Data quality</p>
        <h2 id="quality-title">Exact duplicates</h2>
        <p className="quality-description">
          Byte-identical images, detected by hashing the original file contents
          (SHA-256). Click any image to inspect it.
        </p>
      </div>

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
                    <button
                      className="duplicate-sample"
                      type="button"
                      onClick={(event) => {
                        event.currentTarget.focus({ preventScroll: true })
                        onOpenSample(member.id)
                      }}
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
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function OverviewSkeleton() {
  return (
    <div className="overview-grid" aria-label="Loading overview">
      {Array.from({ length: 6 }, (_, index) => (
        <div className="chart-card chart-card--skeleton" key={index}>
          <div className="chart-skeleton__title" />
          <div className="chart-skeleton__body" />
        </div>
      ))}
    </div>
  )
}

export default OverviewPage
