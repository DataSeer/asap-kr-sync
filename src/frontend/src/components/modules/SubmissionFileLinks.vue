<script setup>
/**
 * The two source files a module result is read against.
 *
 * Only the KRT and the PDF. A module page is a place to check a claim about the
 * manuscript, and those are the two documents that settle it; anything else
 * here would be navigation, which the step strip above already does.
 */
import fileService from '@/services/file.service'

const props = defineProps({
  submissionId: { type: String, required: true },
  /** `{ krt: File, pdf: File }` as the submission endpoint returns them. */
  files: { type: Object, default: () => ({}) }
})

/**
 * Presigned URLs expire, so one is fetched at click time rather than held on
 * the page — a link minted at load would be dead by the time a curator reading
 * a long table gets to it.
 */
async function open(type) {
  const file = props.files?.[type]
  if (!file) return
  try {
    if (file.s3Url) {
      window.open(file.s3Url, '_blank', 'noopener,noreferrer')
      return
    }
    const result = await fileService.download(props.submissionId, file.id)
    if (result.url) window.open(result.url, '_blank', 'noopener,noreferrer')
  } catch {
    // Nothing actionable to show here; the submission page offers the same
    // files with full error handling.
  }
}
</script>

<template>
  <div class="sfl">
    <button
      v-if="files?.krt"
      type="button"
      class="sfl-link sfl-krt"
      title="Open the author's KRT file"
      @click="open('krt')"
    >
      <svg class="sfl-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
      KRT
    </button>
    <span v-else class="sfl-link sfl-off" title="No KRT file was uploaded">KRT</span>

    <button
      v-if="files?.pdf"
      type="button"
      class="sfl-link sfl-pdf"
      title="Open the manuscript PDF"
      @click="open('pdf')"
    >
      <svg class="sfl-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
      </svg>
      PDF
    </button>
    <span v-else class="sfl-link sfl-off" title="No PDF file was uploaded">PDF</span>
  </div>
</template>

<style scoped>
.sfl { display: inline-flex; align-items: center; gap: 0.4rem; }
.sfl-link {
  display: inline-flex; align-items: center; gap: 0.25rem;
  height: 1.7rem; padding: 0 0.5rem;
  border: 1px solid #e5e7eb; border-radius: 0.375rem; background: #fff;
  font-size: 0.75rem; font-weight: 600; cursor: pointer;
}
.sfl-icon { width: 0.85rem; height: 0.85rem; }
.sfl-krt { color: #047857; }
.sfl-krt:hover { border-color: #a7f3d0; background: #ecfdf5; }
.sfl-pdf { color: #b91c1c; }
.sfl-pdf:hover { border-color: #fecaca; background: #fef2f2; }
.sfl-off { color: #d1d5db; background: #fafafa; cursor: default; }
</style>
