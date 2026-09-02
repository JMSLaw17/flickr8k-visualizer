import { useEffect, useId, useRef, useState } from 'react'

import { FILTER_KEYS, type SampleFilters } from '../dataset/api'
import { MAX_CAPTION_QUERY_LENGTH, normalizeCaptionQuery } from '../dataset/filters'
import { isEditableTarget } from './interaction'

interface SearchFormProps {
  /** Committed filters: the caption query seeds the draft, the rest reset it. */
  filters: SampleFilters
  /** Committed rank description and whether ranking can be served; omit to hide the field. */
  rank?: { value: string; ready: boolean }
  shortcutEnabled?: boolean
  onSubmit: (query: string, rank: string) => void
}

/** Caption search with an optional visual-ranking field; `/` focuses the search. */
function SearchForm({ filters, rank, shortcutEnabled = true, onSubmit }: SearchFormProps) {
  const committedQuery = filters.q ?? ''
  const committedRank = rank?.value ?? ''
  const [draftQuery, setDraftQuery] = useState(committedQuery)
  const [draftRank, setDraftRank] = useState(committedRank)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const fieldId = useId()
  // Drafts reset whenever any other filter changes, such as removing a chip.
  const draftResetKey = JSON.stringify(
    FILTER_KEYS.filter((key) => key !== 'q').map((key) => filters[key] ?? null),
  )

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
        !shortcutEnabled ||
        isEditableTarget(event.target)
      ) {
        return
      }

      event.preventDefault()
      searchInputRef.current?.focus()
    }

    document.addEventListener('keydown', focusSearch)
    return () => document.removeEventListener('keydown', focusSearch)
  }, [shortcutEnabled])

  const submit = () => {
    const query = normalizeCaptionQuery(draftQuery)
    const nextRank = normalizeCaptionQuery(draftRank)
    setDraftQuery(query)
    setDraftRank(nextRank)
    onSubmit(query, nextRank)
  }

  return (
    <form
      className={`search-control${rank ? '' : ' search-control--single'}`}
      role="search"
      aria-label="Sample search"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <div className="search-control__row">
        <div className="search-control__field">
          <label htmlFor={`${fieldId}-caption`}>Filter by caption</label>
          <input
            ref={searchInputRef}
            id={`${fieldId}-caption`}
            type="search"
            aria-keyshortcuts="/"
            value={draftQuery}
            onChange={(event) => setDraftQuery(event.target.value)}
            placeholder="Enter an exact phrase"
            maxLength={MAX_CAPTION_QUERY_LENGTH}
          />
        </div>
        {rank && (
          <div className="search-control__field">
            <label htmlFor={`${fieldId}-rank`}>Rank by image content</label>
            <input
              id={`${fieldId}-rank`}
              type="search"
              value={draftRank}
              onChange={(event) => setDraftRank(event.target.value)}
              disabled={!rank.ready}
              placeholder={
                rank.ready
                  ? 'Describe image content'
                  : 'Not prepared — run npm run prepare:data'
              }
              title={
                rank.ready
                  ? undefined
                  : 'Visual ranking is not prepared. Run npm run prepare:data to enable it.'
              }
              maxLength={MAX_CAPTION_QUERY_LENGTH}
            />
          </div>
        )}
        <button className="button button--primary" type="submit">
          Search
        </button>
      </div>
    </form>
  )
}

export default SearchForm
