import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'

import { useSampleFilters, type FilterChip } from '../dataset/filters'
import type { SplitFilter } from '../dataset/formatters'

/**
 * Gallery filters read from the URL, plus the shared ways of changing them.
 * Both the gallery and the overview keep their scope in the URL, so links
 * between them carry it along.
 */
export function useFilterParams() {
  const [searchParams, setSearchParams] = useSearchParams()
  const filters = useSampleFilters(searchParams)
  // Bumped to request the current scope again, such as retrying after an error.
  const [requestVersion, setRequestVersion] = useState(0)
  const refresh = () => setRequestVersion((value) => value + 1)

  const updateParams = (mutate: (params: URLSearchParams) => void) => {
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous)
      mutate(next)
      return next
    })
  }

  // Changing a filter restarts gallery pagination.
  const setSplit = (split: SplitFilter) => {
    updateParams((params) => {
      params.delete('offset')
      if (split === 'all') params.delete('split')
      else params.set('split', split)
    })
  }

  /**
   * Apply a caption search, and a rank when the caller has one; an omitted
   * rank is left as it is. Re-submitting the current values refreshes instead.
   */
  const applySearch = (query: string, rank?: string) => {
    const isCurrent = (key: string, value: string) =>
      value ? searchParams.get(key) === value : !searchParams.has(key)
    const rankIsCurrent = rank === undefined || isCurrent('rank', rank)
    if (isCurrent('q', query) && rankIsCurrent && !searchParams.has('offset')) {
      refresh()
      return
    }

    updateParams((params) => {
      params.delete('offset')
      if (query) params.set('q', query)
      else params.delete('q')
      if (rank === undefined) return
      if (rank) {
        params.set('rank', rank)
        // There is one ordering at a time: a description replaces a reference image.
        params.delete('similar_to')
      } else {
        params.delete('rank')
      }
    })
  }

  const removeChip = (chip: FilterChip) => {
    updateParams((params) => {
      params.delete('offset')
      for (const key of chip.keys) params.delete(key)
    })
  }

  const resetView = () => setSearchParams({})

  return {
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
  }
}
