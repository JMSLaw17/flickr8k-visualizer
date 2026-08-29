interface RouteMetadata {
  headingId: string
  title: string
}

const ROUTE_METADATA: Record<string, RouteMetadata> = {
  '/': { headingId: 'gallery-title', title: 'Browse · Flickr8k Explorer' },
  '/overview': {
    headingId: 'overview-title',
    title: 'Dataset overview · Flickr8k Explorer',
  },
}

export function getRouteMetadata(pathname: string): RouteMetadata | undefined {
  const normalizedPath = pathname === '/' ? pathname : pathname.replace(/\/+$/, '')
  return ROUTE_METADATA[normalizedPath]
}
