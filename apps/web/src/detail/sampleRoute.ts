const DRAWER_STATE_KEY = 'sampleDrawerOpened'
const DRAWER_OPENER_KEY = 'sampleDrawerOpener'

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

export function drawerOpenerId(state: unknown): string | null {
  if (!isStateRecord(state)) return null
  const openerId = state[DRAWER_OPENER_KEY]
  return typeof openerId === 'string' ? openerId : null
}

function isStateRecord(state: unknown): state is Record<string, unknown> {
  return typeof state === 'object' && state !== null
}
