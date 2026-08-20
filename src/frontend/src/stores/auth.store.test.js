/**
 * The capability flags every component asks before showing an action.
 *
 * These mirror the server's rules. They are not the enforcement — the API
 * re-checks everything — but a flag that is too generous shows a button that
 * 403s, and one that is too strict hides work a user is entitled to do. The
 * second failure is the quiet one: nobody reports a button they never saw.
 *
 * Written as a role × capability matrix rather than a test per flag, so adding
 * a role or a capability forces a decision here instead of silently defaulting.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAuthStore } from './auth.store'

vi.mock('@/services/auth.service', () => ({ default: {} }))

const CAPABILITIES = [
  'isAdmin', 'isStaff',
  'canCreateSubmission', 'canDeleteSubmission', 'canHideSubmission',
  'canManageUsers', 'canViewUsers', 'canEditAnyUser', 'canEditAdminUsers', 'canDeleteUsers',
  'canManageTeams', 'canManageTeamEmails',
  'canViewJobInternals', 'canManageJobs',
  'canManageEnrichments', 'canManageResourceTypes', 'canManageValidationRules'
]

/** What each role may do. `true` = the flag must be on, `false` = off. */
const MATRIX = {
  author: {
    isAdmin: false, isStaff: false,
    canCreateSubmission: true, canDeleteSubmission: false, canHideSubmission: true,
    canManageUsers: false, canViewUsers: false, canEditAnyUser: false,
    canEditAdminUsers: false, canDeleteUsers: false,
    canManageTeams: false, canManageTeamEmails: false,
    canViewJobInternals: false, canManageJobs: false,
    canManageEnrichments: false, canManageResourceTypes: false, canManageValidationRules: false
  },
  asap_pm: {
    isAdmin: false, isStaff: false,
    canCreateSubmission: true, canDeleteSubmission: false, canHideSubmission: true,
    canManageUsers: false, canViewUsers: true, canEditAnyUser: false,
    canEditAdminUsers: false, canDeleteUsers: false,
    canManageTeams: false, canManageTeamEmails: true,
    // A PM debugs pipeline behaviour, so they see internals — but do not drive jobs.
    canViewJobInternals: true, canManageJobs: false,
    canManageEnrichments: false, canManageResourceTypes: false, canManageValidationRules: false
  },
  ds_annotator: {
    isAdmin: false, isStaff: true,
    canCreateSubmission: true, canDeleteSubmission: true, canHideSubmission: true,
    canManageUsers: true, canViewUsers: true, canEditAnyUser: true,
    // Only an admin may touch an admin account, or delete a user at all.
    canEditAdminUsers: false, canDeleteUsers: false,
    canManageTeams: true, canManageTeamEmails: true,
    canViewJobInternals: true, canManageJobs: true,
    canManageEnrichments: true, canManageResourceTypes: true, canManageValidationRules: false
  },
  admin: {
    isAdmin: true, isStaff: true,
    canCreateSubmission: true, canDeleteSubmission: true, canHideSubmission: true,
    canManageUsers: true, canViewUsers: true, canEditAnyUser: true,
    canEditAdminUsers: true, canDeleteUsers: true,
    canManageTeams: true, canManageTeamEmails: true,
    canViewJobInternals: true, canManageJobs: true,
    canManageEnrichments: true, canManageResourceTypes: true, canManageValidationRules: true
  }
}

const user = (role, over = {}) => ({ id: 'u1', email: 'x@y.z', role, teams: [], ...over })

let store
beforeEach(() => {
  setActivePinia(createPinia())
  store = useAuthStore()
})

describe('the role × capability matrix', () => {
  for (const [role, expected] of Object.entries(MATRIX)) {
    it(`${role} gets exactly the capabilities it should`, () => {
      store.user = user(role)
      for (const capability of CAPABILITIES) {
        expect(store[capability], `${role}.${capability}`).toBe(expected[capability])
      }
    })
  }

  it('covers every capability the store exposes', () => {
    // If a new flag appears and nobody decides who gets it, this fails rather
    // than letting it default to whatever the implementation happens to do.
    store.user = user('admin')
    const exposed = Object.keys(store).filter((k) => /^(can|is)[A-Z]/.test(k) && typeof store[k] === 'boolean')
    const untested = exposed.filter((k) => !CAPABILITIES.includes(k) && k !== 'isAuthenticated' && k !== 'isRealAdmin' && k !== 'isAuth0User')
    expect(untested, 'new capability flags must be added to the matrix above').toEqual([])
  })
})

describe('signed out', () => {
  it('grants nothing at all', () => {
    store.user = null
    for (const capability of CAPABILITIES) {
      expect(store[capability], capability).toBe(false)
    }
    expect(store.isAuthenticated).toBe(false)
  })

  it('reports no role and no teams rather than undefined', () => {
    store.user = null
    expect(store.userRole).toBe(null)
    expect(store.userTeams).toEqual([])
  })
})

describe('viewing as another role', () => {
  it('lets an admin see the app as a lesser role', () => {
    store.user = user('admin')
    store.setViewAsRole('author')

    expect(store.effectiveRole).toBe('author')
    expect(store.canDeleteSubmission).toBe(false)
    expect(store.canViewJobInternals).toBe(false)
  })

  it('does not change who they really are', () => {
    // The simulation is a UI preview; anything gated on real identity must not
    // move with it.
    store.user = user('admin')
    store.setViewAsRole('author')

    expect(store.isRealAdmin).toBe(true)
    expect(store.userRole).toBe('admin')
  })

  it('is refused to everyone else', () => {
    for (const role of ['author', 'asap_pm', 'ds_annotator']) {
      setActivePinia(createPinia())
      const s = useAuthStore()
      s.user = user(role)
      s.setViewAsRole('admin')

      expect(s.effectiveRole, `${role} must not be able to simulate admin`).toBe(role)
      expect(s.isAdmin).toBe(false)
    }
  })

  it('is refused even when the state is set directly, not via the action', () => {
    // `viewAsRole` is part of the store's public surface, so setViewAsRole is
    // not the only way in. The guard has to live in `effectiveRole` too —
    // otherwise a component assigning the ref would escalate itself.
    store.user = user('author')
    store.viewAsRole = 'admin'

    expect(store.effectiveRole).toBe('author')
    expect(store.isAdmin).toBe(false)
    expect(store.canDeleteSubmission).toBe(false)
  })

  it('is cleared by clearViewAsRole', () => {
    store.user = user('admin')
    store.setViewAsRole('author')
    store.clearViewAsRole()

    expect(store.effectiveRole).toBe('admin')
    expect(store.canDeleteSubmission).toBe(true)
  })
})

describe('canEditSubmission', () => {
  const submission = (over = {}) => ({ id: 's1', userId: 'someone-else', ...over })

  it('lets an author edit only their own', () => {
    store.user = user('author')
    expect(store.canEditSubmission(submission({ userId: 'u1' }))).toBe(true)
    expect(store.canEditSubmission(submission({ userId: 'u2' }))).toBe(false)
  })

  it('lets staff edit anything', () => {
    for (const role of ['admin', 'ds_annotator']) {
      store.user = user(role)
      expect(store.canEditSubmission(submission()), role).toBe(true)
    }
  })

  it('lets a PM edit what they can see', () => {
    // The server only lists submissions owned by the PM's teammates and
    // re-enforces on write, so the client does not re-derive team membership.
    store.user = user('asap_pm')
    expect(store.canEditSubmission(submission())).toBe(true)
  })

  it('refuses when there is no user or no submission', () => {
    store.user = null
    expect(store.canEditSubmission(submission())).toBe(false)

    store.user = user('admin')
    expect(store.canEditSubmission(null)).toBe(false)
    expect(store.canEditSubmission(undefined)).toBe(false)
  })

  it('follows the simulated role, so the preview is honest', () => {
    store.user = user('admin')
    store.setViewAsRole('author')
    expect(store.canEditSubmission(submission({ userId: 'u2' }))).toBe(false)
    expect(store.canEditSubmission(submission({ userId: 'u1' }))).toBe(true)
  })

  it('refuses an unknown role rather than falling through to allow', () => {
    store.user = user('some_new_role')
    expect(store.canEditSubmission(submission())).toBe(false)
  })
})

describe('the Auth0 flag', () => {
  it('reads the boolean the server sends, not the stripped claim', () => {
    // `toJSON()` removes auth0Sub and replaces it with this flag; reading the
    // stripped field made this always false.
    store.user = user('author', { isAuth0User: true })
    expect(store.isAuth0User).toBe(true)

    store.user = user('author', { auth0Sub: 'auth0|123' })
    expect(store.isAuth0User).toBe(false)
  })
})
