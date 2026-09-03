import type { SampleSummary } from '../dataset/api'
import { formatDimensions, formatSimilarity, formatSplit } from '../dataset/formatters'
import SampleLink from '../detail/SampleLink'
import DatasetImage from '../shared/DatasetImage'
import HighlightedText from '../shared/HighlightedText'

/** A length filter can match most captions; keep cards scannable. */
const MAX_MATCHED_CAPTIONS = 2

interface SampleCardProps {
  sample: SampleSummary
  /** Text to highlight within matched captions: the phrase or exact term. */
  query?: string
}

function SampleCard({ sample, query = '' }: SampleCardProps) {
  const caption = sample.caption || 'No caption available'
  const shownMatches = sample.matched_captions.slice(0, MAX_MATCHED_CAPTIONS)
  const hiddenMatches = sample.matched_captions.length - shownMatches.length
  const accessibleCaption = shownMatches[0] ?? caption

  return (
    <article className="sample-card">
      <div className="sample-card__media">
        <DatasetImage className="sample-card__image" src={sample.thumbnail_url} alt="" />
        <div className="sample-card__badges">
          <span className={`split-badge split-badge--${sample.split}`}>
            {formatSplit(sample.split)}
          </span>
          {sample.duplicate && <span className="duplicate-badge">Duplicate</span>}
        </div>
      </div>
      <div className="sample-card__body">
        {shownMatches.length > 0 ? (
          <div className="sample-card__matches">
            <span className="sample-card__matches-label">Matched captions</span>
            <ul>
              {shownMatches.map((matchedCaption, index) => (
                <li key={`${matchedCaption}-${index}`}>
                  <HighlightedText text={matchedCaption} query={query} />
                </li>
              ))}
              {hiddenMatches > 0 && (
                <li className="sample-card__more">+{hiddenMatches} more matched</li>
              )}
            </ul>
          </div>
        ) : (
          <p className="sample-card__caption">{caption}</p>
        )}
        {typeof sample.similarity === 'number' && (
          <p className="sample-card__similarity">
            CLIP cosine similarity: {formatSimilarity(sample.similarity)}
          </p>
        )}
        <span className="sample-card__meta">
          <span>{formatDimensions(sample.width, sample.height)}</span>
          <span className="sample-card__id" title={sample.source_id}>
            {sample.source_id}
          </span>
        </span>
      </div>
      <SampleLink
        className="sample-card__open"
        sampleId={sample.id}
        aria-label={`View details for ${sample.source_id}: ${accessibleCaption}`}
      />
    </article>
  )
}

export default SampleCard
