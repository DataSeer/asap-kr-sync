// @vitest-environment happy-dom
/**
 * Step 3 says who edited the table before you approve it.
 *
 * A PM may edit any submission owned by someone in their team, and staff may
 * edit any submission at all. So the person who submitted a manuscript is not
 * necessarily the only one who has touched its Key Resources Table — and the
 * person approving it at step 3 is the one who most needs to know that.
 *
 * The information was already recorded and already sent: `GET /changes`
 * includes each change's user. It was only reachable by turning on "Show
 * changes", finding a highlighted cell and opening its history, one cell at a
 * time. Nobody does that, so in practice an edit by someone else was invisible.
 *
 * These tests pin the summary that replaced it: every human editor named, the
 * submitter distinguished from everyone else, and the pipeline's own writes
 * left out — they are not a person, and listing them as one would make the
 * "someone else edited this" signal meaningless.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { tooltip } from '@/directives/tooltip'

const getChanges = vi.fn()
const getSubmission = vi.fn()

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal()),
  useRoute: () => ({ params: { id: 'sub-1' } }),
  useRouter: () => ({ push: vi.fn() })
}))
vi.mock('@/services/submission.service', () => ({
  default: {
    getById: (...a) => getSubmission(...a),
    getChanges: (...a) => getChanges(...a),
    update: vi.fn()
  }
}))
vi.mock('@/services/suggestion.service', () => ({
  default: { getSuggestions: vi.fn().mockResolvedValue({ suggestions: [] }) }
}))
vi.mock('@/services/resourceTypes.service', () => ({
  default: { getResourceTypeNames: vi.fn().mockResolvedValue([]), getResourceTypes: vi.fn().mockResolvedValue([]) }
}))
vi.mock('@/services/file.service', () => ({
  default: { download: vi.fn(), getFiles: vi.fn().mockResolvedValue([]) }
}))
vi.mock('@/services/krt.service', () => ({
  default: {
    getData: vi.fn().mockResolvedValue({
      rows: [], validationErrors: [], totalErrors: 0, totalRows: 0
    }),
    validate: vi.fn()
  }
}))

import ReviewView from './ReviewView.vue'

const OWNER = { id: 'author-1', name: 'Dr Author', email: 'author@example.com' }
const PM = { id: 'pm-1', name: 'Team PM', email: 'pm@example.com' }

/**
 * One cell edit by `user`, or by the pipeline when `user` is null.
 *
 * `action: 'edit'` with a `columnName` is what a KRT cell edit actually looks
 * like here — the same shape the page's own statistics count. An earlier draft
 * of this fixture invented `update_cell`, which no part of the app emits, and
 * so it agreed with a bug rather than catching it.
 */
const change = (user, over = {}) => ({
  id: Math.random().toString(36).slice(2),
  action: 'edit',
  columnName: 'identifier',
  source: 'manual',
  rowId: 'row-1',
  oldValue: 'a',
  newValue: 'b',
  createdAt: '2026-08-24T10:00:00Z',
  user,
  ...over
})

async function mountPage(changes) {
  setActivePinia(createPinia())
  // The store unwraps `{ submission, latestFiles }` — returning the submission
  // bare leaves currentSubmission undefined, and then nobody is the owner.
  getSubmission.mockResolvedValue({
    submission: {
      id: 'sub-1', title: 'A manuscript', currentRound: 1,
      status: 'step_review', userId: OWNER.id, user: OWNER
    },
    latestFiles: {}
  })
  getChanges.mockResolvedValue({ changes })

  const wrapper = mount(ReviewView, {
    global: {
      directives: { tooltip },
      stubs: { RouterLink: { template: '<a><slot /></a>' }, SubmissionHeader: true }
    }
  })
  await flushPromises()
  return wrapper
}

/** The editors panel, or null when the page did not render one. */
function panel(wrapper) {
  const card = wrapper.findAll('.card')
    .find((c) => c.text().includes('Who edited this table'))
  return card || null
}

describe('who edited this table', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('is absent when nobody has edited anything', async () => {
    const wrapper = await mountPage([])

    expect(panel(wrapper)).toBe(null)
  })

  it('names the submitter and marks them as the submitter', async () => {
    const wrapper = await mountPage([change(OWNER), change(OWNER)])
    const card = panel(wrapper)

    expect(card).not.toBe(null)
    expect(card.text()).toContain('Dr Author')
    expect(card.text()).toContain('submitter')
    expect(card.text()).toContain('2 changes')
  })

  it('calls out an editor who is not the submitter', async () => {
    // The case this panel exists for: a PM editing a teammate's table.
    const wrapper = await mountPage([change(OWNER), change(PM)])
    const card = panel(wrapper)

    expect(card.text()).toContain('Team PM')
    expect(card.text()).toContain('not the submitter')
    expect(card.text()).toContain('other than the submitter')
  })

  it('does not cry wolf when only the submitter has edited', async () => {
    const wrapper = await mountPage([change(OWNER)])

    expect(panel(wrapper).text()).not.toContain('other than the submitter')
  })

  it('counts each person separately and orders by who did most', async () => {
    const wrapper = await mountPage([change(PM), change(PM), change(PM), change(OWNER)])
    const names = panel(wrapper).findAll('li').map((li) => li.text())

    expect(names[0]).toContain('Team PM')
    expect(names[0]).toContain('3 changes')
    expect(names[1]).toContain('Dr Author')
    expect(names[1]).toContain('1 change')
  })

  it('leaves out what the pipeline wrote', async () => {
    // Applied pipeline output carries no user (change_logs.user_id is nullable
    // precisely so the system need not borrow someone's name). Counting it as a
    // person would put "not the submitter" on every submission and make the
    // signal worthless.
    const wrapper = await mountPage([
      change(null, { source: 'pipeline', action: 'apply' }),
      change(OWNER)
    ])
    const card = panel(wrapper)

    expect(card.findAll('li')).toHaveLength(1)
    expect(card.text()).not.toContain('other than the submitter')
  })

  it('ignores changes that are not edits to the table', async () => {
    // Found by screenshotting a real submission: its log held three uploads and
    // two rejected suggestions, so the page's banner correctly said "No changes
    // have been made to this KRT" — while this panel, counting every log entry,
    // announced "Admin · 5 changes" directly underneath it. The panel and the
    // statistics now share one predicate, so they cannot disagree again.
    const wrapper = await mountPage([
      change(OWNER, { action: 'upload', columnName: null }),
      change(OWNER, { action: 'upload', columnName: null }),
      change(OWNER, { action: 'reject_change', columnName: null })
    ])

    expect(panel(wrapper)).toBe(null)
  })

  it('counts row additions and deletions, not only cell edits', async () => {
    const wrapper = await mountPage([
      change(PM, { action: 'add_row', columnName: null }),
      change(PM, { action: 'delete_row', columnName: null })
    ])

    expect(panel(wrapper).text()).toContain('2 changes')
  })

  it('survives a change whose user has no name', async () => {
    const wrapper = await mountPage([change({ id: 'ghost-1' })])

    expect(panel(wrapper).text()).toContain('Unknown')
  })
})
