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

  /** Apply a caption search and rank; re-submitting the current ones refreshes instead. */
  const applySearch = (query: string, rank: string) => {
    const isCurrent = (key: string, value: string) =>
      value ? searchParams.get(key) === value : !searchParams.has(key)
    if (isCurrent('q', query) && isCurrent('rank', rank) && !searchParams.has('offset')) {
      refresh()
      return
    }

    updateParams((params) => {
      params.delete('offset')
      for (const [key, value] of [
        ['q', query],
        ['rank', rank],
      ] as const) {
        if (value) params.set(key, value)
        else params.delete(key)
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
