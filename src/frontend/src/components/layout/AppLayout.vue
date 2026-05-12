<script setup>
import { computed } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import AppHeader from './AppHeader.vue'
import AppSidebar from './AppSidebar.vue'
import NotificationContainer from '@/components/common/NotificationContainer.vue'

/**
 * Submission step views (KRT, PDF, Availability, Review, Report) render a
 * sticky sub-header that needs to sit flush against the AppHeader's bottom.
 * Drop <main>'s pt-6 on those routes so the sticky bar's top edge can reach
 * the padding-box top — the SubmissionHeader takes over the responsibility
 * of providing breathing room above the metadata content.
 *
 * `submissions/create` and other non-step submission routes are NOT matched
 * here — they use the standard layout and need <main>'s normal pt-6.
 */
const STEP_VIEW_PATHS = ['krt', 'pdf', 'availability', 'review', 'report']
const SUBMISSION_STEP_RE = new RegExp(
  `^/submissions/[^/]+/(${STEP_VIEW_PATHS.join('|')})(?:/|$)`
)
const route = useRoute()
const dropMainTopPadding = computed(() => SUBMISSION_STEP_RE.test(route.path))
</script>

<template>
  <!--
    Layout grid:
      - Outer: full viewport height, no body scroll.
      - Header: fixed at top (intrinsic height).
      - Sidebar + main share the remaining height; each scrolls independently.
    `min-h-0` on the flex row is required so the children can actually shrink
    and let their `overflow-y-auto` take effect (otherwise flex children
    default to min-content height and the scroll surface never appears).
  -->
  <div class="h-screen flex flex-col bg-gray-50 overflow-hidden">
    <AppHeader class="flex-shrink-0" />
    <div class="flex flex-1 min-h-0">
      <AppSidebar class="flex-shrink-0" />
      <main
        class="flex-1 px-6 pb-6 min-w-0 overflow-y-auto overflow-x-hidden"
        :class="dropMainTopPadding ? 'pt-0' : 'pt-6'"
      >
        <RouterView />
      </main>
    </div>
    <NotificationContainer />
  </div>
</template>
