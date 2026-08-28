import type { SampleSummary } from '../api'
import { formatDimensions, formatSplit } from '../formatters'
import DatasetImage from './DatasetImage'
import HighlightedText from './HighlightedText'

interface SampleCardProps {
  sample: SampleSummary
  query?: string
  onOpen: () => void
}

function SampleCard({ sample, query = '', onOpen }: SampleCardProps) {
  const caption = sample.caption || 'No caption available'
  const matchedCaptions = query ? sample.matched_captions : []
  const accessibleCaption = matchedCaptions[0] ?? caption

  return (
    <article className="sample-card">
      <div className="sample-card__media">
        <DatasetImage className="sample-card__image" src={sample.thumbnail_url} alt="" />
        <span className={`split-badge split-badge--${sample.split}`}>
          {formatSplit(sample.split)}
        </span>
      </div>
      <div className="sample-card__body">
        {matchedCaptions.length > 0 ? (
          <div className="sample-card__matches">
            <span className="sample-card__matches-label">Matched captions</span>
            <ul>
              {matchedCaptions.map((matchedCaption, index) => (
                <li key={`${matchedCaption}-${index}`}>
                  <HighlightedText text={matchedCaption} query={query} />
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="sample-card__caption">{caption}</p>
        )}
        <span className="sample-card__meta">
          {formatDimensions(sample.width, sample.height)}
        </span>
      </div>
      <button
        className="sample-card__open"
        type="button"
        aria-label={`View details for ${sample.source_id}: ${accessibleCaption}`}
        onClick={(event) => {
          // Safari and Firefox skip focusing a clicked button; the dialog restores focus here.
          event.currentTarget.focus({ preventScroll: true })
          onOpen()
        }}
      />
    </article>
  )
}

export default SampleCard
