<script setup>
/**
 * Link to the KRT validation rules reference (docs/krt-validation-rules.md).
 *
 * The rules — which identifiers the app recognizes and which of them each
 * resource type accepts — live in the repository documentation, not in the UI:
 * they change with the code, and the doc is the one place that is verified
 * against it. The UI only has to make that page one click away, from the branch
 * this deployment actually runs (same source lookup as ModuleExplainer).
 *
 * Renders nothing until the source is known, so a deployment that tracks no
 * branch shows no dead link.
 */
import { computed, onMounted, ref } from 'vue'
import configService from '@/services/config.service'

const props = defineProps({
  /** Anchor in the doc, e.g. "4-which-identifiers-each-resource-type-accepts". Empty = top of page. */
  anchor: { type: String, default: '' },
  label: { type: String, default: 'Validation rules' }
})

const source = ref(null)
onMounted(async () => {
  try { source.value = await configService.getSource() } catch { /* link omitted */ }
})

const href = computed(() => (source.value
  ? `${source.value.repoUrl}/blob/${source.value.branch}/docs/krt-validation-rules.md${props.anchor ? '#' + props.anchor : ''}`
  : null))
</script>

<template>
  <a
    v-if="href"
    v-tooltip="'Opens the validation rules reference on GitHub'"
    :href="href"
    target="_blank"
    rel="noopener"
    class="validation-rules-link"
  >{{ label }} ↗</a>
</template>

<style scoped>
.validation-rules-link {
  font-size: 0.75rem;
  color: #4b5563;
  text-decoration: underline;
  text-underline-offset: 2px;
  white-space: nowrap;
}
.validation-rules-link:hover {
  color: #111827;
}
</style>
