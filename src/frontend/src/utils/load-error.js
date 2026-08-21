/**
 * Turn a failed fetch into something a page can show the user.
 *
 * Every submission view needs the same three sentences, and for a while every
 * one of them carried its own byte-identical copy. Kept together so a change to
 * the wording — or to which statuses are worth retrying — happens once.
 *
 * @param {Error} err - the rejected request (an axios error, or anything else)
 * @returns {{ message: string, retryable: boolean }} what LoadError renders.
 *   `retryable` is false where retrying cannot help: a 403 will still be a 403,
 *   and a 404 will still be gone.
 */
export function describeLoadError(err) {
  const status = err?.response?.status
  if (status === 403) return { message: 'You do not have access to this submission.', retryable: false }
  if (status === 404) return { message: 'This submission no longer exists.', retryable: false }
  return { message: err?.response?.data?.error || err?.message || 'The server did not respond.', retryable: true }
}

export default describeLoadError
