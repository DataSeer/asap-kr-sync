// @vitest-environment happy-dom
/**
 * The two module tables that shipped broken, rendered rather than reasoned about.
 *
 * Both failures were invisible to every other kind of check. The build passed,
 * lint passed, and the unit tests on their row models passed — because the
 * faults were in the components:
 *
 *   - GroundingTable's template called `groundingFills()`, a helper that stayed
 *     behind in JobStatusPanel when the module pages were extracted. Under the
 *     blind pipeline (`surfaceValues: true`) that column renders, the call
 *     threw, and the WHOLE table disappeared.
 *   - DetectionsTable's root element was `v-if="items.length"`, so the "no
 *     detections" message nested inside it could never appear. A module that
 *     legitimately found nothing rendered as a blank area.
 *
 * So these mount the real components and assert on the output.
 */

import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import GroundingTable from './GroundingTable.vue'
import DetectionsTable from './DetectionsTable.vue'

setActivePinia(createPinia())

const outcome = (over = {}) => ({
  resourceType: 'Dataset',
  resourceName: 'PD-related snRNA-seq',
  source: 'Levin lab',
  identifier: '10.5281/zenodo.16885839',
  newReuse: 'reuse',
  verdict: 'confirmed',
  found: { status: 'yes', on: 'name' },
  ...over
})

const detection = (over = {}) => ({
  resourceType: 'Datasets',
  canonical_name: 'RNA-seq atlas',
  source: 'GEO',
  identifier: 'GSE12345',
  newReuse: 'new',
  ...over
})

const mountGrounding = (props) => mount(GroundingTable, {
  props: { outcomes: [], policy: null, search: '', ...props },
  global: { stubs: { RouterLink: true } }
})

const mountDetections = (props) => mount(DetectionsTable, {
  props: { items: [], search: '', jobType: 'datasets_detection', ...props },
  global: { stubs: { RouterLink: true } }
})

describe('GroundingTable', () => {
  it('renders a row per author-KRT outcome', () => {
    const wrapper = mountGrounding({ outcomes: [outcome(), outcome({ resourceName: 'Second row' })] })
    expect(wrapper.text()).toContain('PD-related snRNA-seq')
    expect(wrapper.text()).toContain('Second row')
  })

  it('survives the blind pipeline, which is what used to kill it', () => {
    // `surfaceValues: true` is the flag that made the "More information" column
    // render — and with it the missing helper. The whole table went blank.
    const wrapper = mountGrounding({
      policy: { surfaceValues: true },
      outcomes: [outcome({ foundValues: { identifier: '10.5281/zenodo.1', source: 'Zenodo' } })]
    })

    expect(wrapper.findAll('tbody tr').length).toBeGreaterThan(0)
    expect(wrapper.text()).toContain('PD-related snRNA-seq')
  })

  it('lists each surfaced value as "field: value"', () => {
    const wrapper = mountGrounding({
      policy: { surfaceValues: true },
      outcomes: [outcome({ foundValues: { identifier: '10.5281/zenodo.1' } })]
    })
    expect(wrapper.text()).toContain('identifier: 10.5281/zenodo.1')
  })

  it('an outcome carrying no values renders without complaint', () => {
    const wrapper = mountGrounding({
      policy: { surfaceValues: true },
      outcomes: [outcome({ foundValues: undefined }), outcome({ foundValues: {} })]
    })
    expect(wrapper.findAll('tbody tr').length).toBeGreaterThan(0)
  })

  it('withholds candidate-derived values when no policy was stamped', () => {
    // Default-deny: a run with no policy is a defect, and the safe failure is
    // to show less rather than something possibly contaminated by seeding.
    const withValues = mountGrounding({
      policy: { surfaceValues: true }, outcomes: [outcome({ foundValues: { source: 'Zenodo' } })]
    })
    const withoutPolicy = mountGrounding({
      policy: null, outcomes: [outcome({ foundValues: { source: 'Zenodo' } })]
    })

    expect(withValues.text()).toContain('source: Zenodo')
    expect(withoutPolicy.text()).not.toContain('source: Zenodo')
  })

  it('treats anything other than an explicit true as "do not surface"', () => {
    for (const policy of [{}, { surfaceValues: false }, { surfaceValues: 'yes' }]) {
      const wrapper = mountGrounding({ policy, outcomes: [outcome({ foundValues: { source: 'Zenodo' } })] })
      expect(wrapper.text(), JSON.stringify(policy)).not.toContain('source: Zenodo')
    }
  })

  it('renders nothing rather than throwing when handed no outcomes', () => {
    const wrapper = mountGrounding({ outcomes: [] })
    expect(wrapper.findAll('tbody tr').length).toBe(0)
  })
})

describe('DetectionsTable', () => {
  it('renders a row per detection', () => {
    const wrapper = mountDetections({ items: [detection(), detection({ canonical_name: 'Second' })] })
    expect(wrapper.text()).toContain('RNA-seq atlas')
    expect(wrapper.text()).toContain('Second')
  })

  it('SAYS it found nothing, instead of rendering a blank area', () => {
    // The whole fix: the empty state lived inside an element that only existed
    // when there were items.
    const wrapper = mountDetections({ items: [] })
    expect(wrapper.text().trim()).not.toBe('')
    expect(wrapper.text().toLowerCase()).toMatch(/no |none|nothing/)
  })

  it('quotes the evidence with the section it came from', () => {
    const wrapper = mountDetections({
      items: [detection({
        evidence: { quote: 'Deposited in GEO under GSE12345.', section: 'Data Availability' }
      })]
    })
    expect(wrapper.text()).toContain('Deposited in GEO under GSE12345.')
    expect(wrapper.text()).toContain('Data Availability')
  })

  it('flags evidence that is weaker than it looks', () => {
    const wrapper = mountDetections({
      items: [detection({ evidence: { quote: 'roughly as described', match: 'partial' } })]
    })
    // Amber is the app's warning colour, and the only badge allowed to use it.
    expect(wrapper.html()).toContain('rbadge-warning')
  })

  it('does not show engine badges for a detector that has only one engine', () => {
    // Only software unions two engines; elsewhere the column is noise.
    const datasets = mountDetections({
      jobType: 'datasets_detection',
      items: [detection({ origin: 'lm' })]
    })
    expect(datasets.text()).not.toContain('Softcite')
  })

  it('renders an item missing every optional field', () => {
    const wrapper = mountDetections({ items: [{ canonical_name: 'Bare' }] })
    expect(wrapper.text()).toContain('Bare')
  })
})
