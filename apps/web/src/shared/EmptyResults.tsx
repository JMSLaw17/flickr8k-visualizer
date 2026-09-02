interface EmptyResultsProps {
  /** The committed caption search, if any. */
  query: string
  /** Whether filters other than the caption search are active. */
  hasOtherFilters: boolean
  onClearSearch: () => void
  onClearFilters: () => void
}

/** Zero-result state with the quickest ways back to a non-empty scope. */
function EmptyResults({
  query,
  hasOtherFilters,
  onClearSearch,
  onClearFilters,
}: EmptyResultsProps) {
  return (
    <div className="state-card">
      <span className="state-card__mark">0</span>
      <h3>{query ? 'No matching captions' : 'No samples found'}</h3>
      <p>
        {query
          ? `No samples in the current filters have captions matching “${query}”.`
          : 'There are no locally ingested samples matching these filters.'}
      </p>
      {query ? (
        <div className="state-card__actions">
          <button className="button button--secondary" type="button" onClick={onClearSearch}>
            Clear search
          </button>
          {hasOtherFilters && (
            <button className="button button--secondary" type="button" onClick={onClearFilters}>
              Clear all filters
            </button>
          )}
        </div>
      ) : hasOtherFilters ? (
        <button className="button button--secondary" type="button" onClick={onClearFilters}>
          Clear filters
        </button>
      ) : null}
    </div>
  )
}

export default EmptyResults
