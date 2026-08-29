import { useEffect, useRef } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'

import { useSampleFilters } from '../filters'
import { getRouteMetadata } from '../routes'
import { drawerOpenerId, isAppOpenedDrawer } from '../sampleRoute'
import DetailPanel from './DetailPanel'

function RoutedDetailPanel() {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const sampleId = searchParams.get('sample') || null
  const filters = useSampleFilters(searchParams)
  const previousDrawer = useRef({
    pathname: location.pathname,
    sampleId,
    state: location.state,
  })

  useEffect(() => {
    const previous = previousDrawer.current
    previousDrawer.current = {
      pathname: location.pathname,
      sampleId,
      state: location.state,
    }

    if (
      sampleId ||
      !previous.sampleId ||
      previous.pathname !== location.pathname ||
      !isAppOpenedDrawer(previous.state)
    ) {
      return
    }
    const openerId = drawerOpenerId(previous.state)
    if (!openerId) return

    const frame = requestAnimationFrame(() => {
      const opener = Array.from(
        document.querySelectorAll<HTMLElement>('[data-sample-opener]'),
      ).find((element) => element.dataset.sampleOpener === openerId)
      opener?.focus({ preventScroll: true })
    })

    return () => cancelAnimationFrame(frame)
  }, [location.pathname, location.state, sampleId])

  if (!sampleId) return null

  const removeSample = () => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        next.delete('sample')
        return next
      },
      { replace: true, preventScrollReset: true },
    )

    const headingId = getRouteMetadata(location.pathname)?.headingId
    if (!headingId) return
    requestAnimationFrame(() => {
      document.getElementById(headingId)?.focus({ preventScroll: true })
    })
  }

  const close = () => {
    if (isAppOpenedDrawer(location.state)) navigate(-1)
    else removeSample()
  }

  const showSample = (id: string) => {
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous)
        next.set('sample', id)
        return next
      },
      {
        replace: true,
        state: location.state,
        preventScrollReset: true,
      },
    )
  }

  return (
    <DetailPanel
      sampleId={sampleId}
      filters={filters}
      onClose={close}
      onNavigate={showSample}
    />
  )
}

export default RoutedDetailPanel
