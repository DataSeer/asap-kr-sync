/**
 * Telling this browser's other tabs that the session is over.
 *
 * Logging out revokes every refresh token for the user server-side, so a
 * sibling tab is already dead — but it does not know it until its next API
 * call, and until then it keeps rendering a signed-in page (ASAP, 2026-09).
 * One BroadcastChannel message closes that gap: the other tabs drop their
 * user state and go to the login page immediately.
 *
 * Deliberately small. It carries no tokens and no user data — only the fact
 * that a logout happened — so nothing here is worth intercepting, and a
 * forged message can do no more than send a tab to a page it can always
 * reach anyway. BroadcastChannel is same-origin by construction.
 *
 * Degrades quietly: a browser without BroadcastChannel simply falls back to
 * the old behaviour, signing the tab out on its next request.
 */
const CHANNEL_NAME = 'asap-kr-session'
const LOGOUT = 'logout'

let channel = null

function getChannel() {
  if (channel) return channel
  if (typeof BroadcastChannel === 'undefined') return null
  channel = new BroadcastChannel(CHANNEL_NAME)
  return channel
}

/**
 * Tell the other tabs that this session ended.
 *
 * BroadcastChannel never delivers to the tab that posted, so the sender
 * cannot trigger its own handler.
 */
export function announceLogout() {
  getChannel()?.postMessage({ type: LOGOUT })
}

/**
 * Run `handler` when another tab announces a logout.
 *
 * @param {() => void} handler
 * @returns {() => void} unsubscribe
 */
export function onLogout(handler) {
  const ch = getChannel()
  if (!ch) return () => {}
  const listener = (event) => {
    if (event?.data?.type === LOGOUT) handler()
  }
  ch.addEventListener('message', listener)
  return () => ch.removeEventListener('message', listener)
}

/** Test hook: drop the channel so the next call opens a fresh one. */
export function _resetForTests() {
  channel?.close?.()
  channel = null
}
