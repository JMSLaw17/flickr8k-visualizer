import { useEffect, useRef } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'

import { galleryPath, parseOrdering, useSampleFilters } from '../dataset/filters'
import { getRouteMetadata } from '../routes'
import DetailPanel from './DetailPanel'
import {
  clearDrawerParams,
  drawerExitState,
  drawerOpenerId,
  isAppOpenedDrawer,
  isDrawerExit,
  isUnscopedDrawer,
} from './sampleRoute'

function RoutedDetailPanel() {
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const sampleId = searchParams.get('sample') || null
  const filters = useSampleFilters(searchParams)
  // With an ordering context, the drawer navigates in ranked order and shows
  // the sample's similarity; without one it follows stable-ID order.
  const ordering = parseOrdering(searchParams)
  // Links such as duplicate members open the drawer over the whole dataset.
  const unscoped = isUnscopedDrawer(searchParams)
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
      !isAppOpenedDrawer(previous.state) ||
      isDrawerExit(location.state)
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
        clearDrawerParams(next)
        return next
      },
      { replace: true, preventScrollReset: true },
    )

    focusHeading(location.pathname)
  }

  const focusHeading = (pathname: string) => {
    const headingId = getRouteMetadata(pathname)?.headingId
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

  // Opens Browse ranked by this sample's image within the drawer's scope. The
  // listing URL has no drawer parameters, so the drawer closes with it, and
  // focus moves to the gallery heading as it does when the drawer is removed.
  const findSimilar = () => {
    navigate(galleryPath(unscoped ? {} : filters, { similar_to: sampleId }), {
      state: drawerExitState(),
    })
    focusHeading('/')
  }

  return (
    <DetailPanel
      sampleId={sampleId}
      filters={unscoped ? {} : { ...filters, ...ordering }}
      onClose={close}
      onNavigate={showSample}
      onFindSimilar={findSimilar}
    />
  )
}

export default RoutedDetailPanel
