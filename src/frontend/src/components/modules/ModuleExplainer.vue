<script setup>
/**
 * What a module is, in plain language, on the page that shows its results.
 *
 * Users do not read the repository documentation, and they should not have to:
 * a table of verdicts is unreadable without knowing what produced it, where the
 * values came from, and what the app did and did not check. Every complaint so
 * far about "I don't understand this result" has been a missing explanation
 * rather than a wrong number.
 *
 * Collapsed by default. The explanation has to be one click away, not in the
 * way — someone who already knows how a module works should not scroll past the
 * same paragraph every visit, and the results are what they came for.
 */
import { computed, onMounted, ref } from 'vue'
import configService from '@/services/config.service'

const props = defineProps({
  title: { type: String, required: true },
  /** One sentence: what the module produces. */
  summary: { type: String, required: true },
  /** [{ q, a }] — the questions a reader actually has, answered. */
  points: { type: Array, default: () => [] },
  /**
   * Anchor of this module's section in docs/background-modules.md, e.g.
   * "32-das_extraction--data-availability-statement". Just the fragment: the
   * repository and branch belong to the deployment, not to this component.
   */
  doc: { type: String, default: '' }
})

const open = ref(false)

/**
 * Where the documentation lives, for the branch this deployment runs. Fetched
 * rather than hard-coded for the same reason the prompt links are: which branch
 * is deployed is a property of the deployment.
 */
const source = ref(null)
onMounted(async () => {
  try { source.value = await configService.getSource() } catch { /* link omitted */ }
})

const docUrl = computed(() => (props.doc && source.value
  ? `${source.value.repoUrl}/blob/${source.value.branch}/docs/background-modules.md#${props.doc}`
  : null))
</script>

<template>
  <section class="explainer">
    <button type="button" class="explainer-toggle" @click="open = !open">
      <span class="explainer-caret" :class="{ 'explainer-caret-open': open }">▸</span>
      How “{{ title }}” works
    </button>
    <div v-if="open" class="explainer-body">
      <p class="explainer-summary">{{ summary }}</p>
      <dl class="explainer-points">
        <template v-for="(p, i) in points" :key="i">
          <dt>{{ p.q }}</dt>
          <dd>{{ p.a }}</dd>
        </template>
      </dl>
      <!-- The full technical account, for whoever wants the rest of it. -->
      <p v-if="docUrl" class="explainer-doc">
        <a :href="docUrl" target="_blank" rel="noopener">Full documentation for this module ↗</a>
      </p>
    </div>
  </section>
</template>

<style scoped>
.explainer {
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
  background: #f9fafb;
  margin-bottom: 1.25rem;
}
.explainer-toggle {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.6rem 0.9rem;
  font-size: 0.85rem;
  font-weight: 600;
  color: #374151;
  background: none;
  border: 0;
  cursor: pointer;
  text-align: left;
}
.explainer-caret {
  display: inline-block;
  transition: transform 0.12s ease;
  color: #9ca3af;
}
.explainer-caret-open { transform: rotate(90deg); }
.explainer-body {
  padding: 0 0.9rem 0.9rem 2rem;
}
.explainer-summary {
  margin: 0 0 0.75rem;
  font-size: 0.85rem;
  color: #374151;
  line-height: 1.5;
  max-width: 62rem;
}
.explainer-points {
  display: grid;
  grid-template-columns: minmax(11rem, 15rem) 1fr;
  gap: 0.4rem 1rem;
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.5;
  max-width: 70rem;
}
.explainer-points dt {
  color: #6b7280;
  font-weight: 600;
}
.explainer-points dd {
  margin: 0;
  color: #374151;
}
.explainer-doc {
  margin: 0.85rem 0 0;
  font-size: 0.78rem;
}
.explainer-doc a { color: #2563eb; text-decoration: none; }
.explainer-doc a:hover { text-decoration: underline; }
@media (max-width: 700px) {
  .explainer-points { grid-template-columns: 1fr; gap: 0.15rem; }
  .explainer-points dd { margin-bottom: 0.5rem; }
}
</style>
