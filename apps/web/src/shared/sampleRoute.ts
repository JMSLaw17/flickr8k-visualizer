const DRAWER_STATE_KEY = 'sampleDrawerOpened'
const DRAWER_OPENER_KEY = 'sampleDrawerOpener'
const DRAWER_EXIT_KEY = 'sampleDrawerExited'

export function appOpenedDrawerState(
  state: unknown,
  openerId: string,
): Record<string, unknown> {
  return {
    ...(isStateRecord(state) ? state : {}),
    [DRAWER_STATE_KEY]: true,
    [DRAWER_OPENER_KEY]: openerId,
  }
}

export function isAppOpenedDrawer(state: unknown): boolean {
  return isStateRecord(state) && state[DRAWER_STATE_KEY] === true
}

/**
 * State for a navigation that leaves the drawer for new results. Focus then
 * belongs on the page heading, not back on the card that opened the drawer.
 */
export function drawerExitState(): Record<string, unknown> {
  return { [DRAWER_EXIT_KEY]: true }
}

export function isDrawerExit(state: unknown): boolean {
  return isStateRecord(state) && state[DRAWER_EXIT_KEY] === true
}

export function drawerOpenerId(state: unknown): string | null {
  if (!isStateRecord(state)) return null
  const openerId = state[DRAWER_OPENER_KEY]
  return typeof openerId === 'string' ? openerId : null
}

const DRAWER_SCOPE_PARAM = 'scope'
const DATASET_SCOPE = 'dataset'

/** Mark a drawer URL to navigate the whole dataset instead of the page's filters. */
export function markUnscopedDrawer(params: URLSearchParams): void {
  params.set(DRAWER_SCOPE_PARAM, DATASET_SCOPE)
}

export function isUnscopedDrawer(params: URLSearchParams): boolean {
  return params.get(DRAWER_SCOPE_PARAM) === DATASET_SCOPE
}

export function isSampleDrawerOpen(params: URLSearchParams): boolean {
  return params.has('sample')
}

/** Remove every drawer parameter from the URL. */
export function clearDrawerParams(params: URLSearchParams): void {
  params.delete('sample')
  params.delete(DRAWER_SCOPE_PARAM)
}

function isStateRecord(state: unknown): state is Record<string, unknown> {
  return typeof state === 'object' && state !== null
}
