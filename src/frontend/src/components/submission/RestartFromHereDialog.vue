<script setup>
/**
 * "Restart from here" — what it takes with it, before it takes it.
 *
 * The button used to say "Restart" and do more than that: restarting a step
 * also resets everything downstream, because those results were built from what
 * this step produced. A click on Markdown Convert threw away eight modules'
 * work, and nothing on screen said so.
 *
 * It also decides what the pipeline re-reads. An input is re-taken only when
 * every step that reads it is being re-run — so restarting the conversion picks
 * up a manuscript replaced since the round began, and restarting one detector
 * deliberately does not. Someone restarting a single module to pick up their new
 * PDF should find that out here rather than after the run.
 *
 * Never a native confirm(): this app has none, and a native dialog cannot show
 * a list.
 */
import { ref, watch } from 'vue'

const props = defineProps({
  /** The plan from `restartPlan()`, or null when nothing is pending. */
  plan: { type: Object, default: null },
  /** True while the restart request is in flight. */
  busy: { type: Boolean, default: false }
})

const emit = defineEmits(['confirm', 'cancel'])

/**
 * Which parameters the re-run uses.
 *
 * A restart already re-reads the round's frozen INPUTS. It has always used
 * today's prompts and model, which means a re-run that disagrees with the
 * original cannot be told apart from a prompt somebody edited in between —
 * exactly the question a re-run is usually asked to settle.
 *
 * Defaults to `live` every time the dialog opens, and deliberately: the common
 * restart is "I changed the prompt, run it again", and a sticky `frozen` would
 * make that button quietly do nothing.
 */
const paramsSource = ref('live')
watch(() => props.plan, (plan) => { if (plan) paramsSource.value = 'live' })
</script>

<template>
  <Transition name="fade">
    <div v-if="plan" class="restart-overlay" @click.self="$emit('cancel')">
      <div class="restart-dialog" role="dialog" aria-modal="true" aria-labelledby="restart-title">
        <h3 id="restart-title" class="restart-title">
          Restart from {{ plan.stepName }}?
        </h3>

        <!-- A selection is named, not counted. "Restart 3 steps?" leaves the
             reader to remember which three they ticked, on the one screen where
             being sure matters. -->
        <template v-if="plan.selectedNames.length > 1">
          <p class="restart-line">These steps run again:</p>
          <ul class="restart-list">
            <li v-for="name in plan.selectedNames" :key="name">{{ name }}</li>
          </ul>
        </template>

        <p v-if="!plan.alsoReruns.length" class="restart-line">
          <template v-if="plan.selectedNames.length > 1">Nothing else is affected.</template>
          <template v-else>
            This runs <strong>{{ plan.stepName }}</strong> again. Nothing else is affected.
          </template>
        </p>
        <template v-else>
          <p class="restart-line">
            <template v-if="plan.selectedNames.length > 1">
              They share
              <strong>{{ plan.alsoReruns.length }}</strong>
              {{ plan.alsoReruns.length === 1 ? 'later step' : 'later steps' }}, which
              {{ plan.alsoReruns.length === 1 ? 'runs' : 'run' }}
              <strong>once</strong> after all of them finish. Current results replaced:
            </template>
            <template v-else>
              This runs <strong>{{ plan.stepName }}</strong> again, and
              <strong>{{ plan.alsoReruns.length }}</strong>
              {{ plan.alsoReruns.length === 1 ? 'step that depends on it' : 'steps that depend on it' }}.
              Their current results are replaced:
            </template>
          </p>
          <ul class="restart-list">
            <li v-for="name in plan.alsoReruns" :key="name">{{ name }}</li>
          </ul>
        </template>

        <p class="restart-line restart-muted">
          Everything else is kept, including its results.
        </p>

        <p v-if="plan.refreshedInputs.length" class="restart-line">
          Re-read from your current files:
          <strong>{{ plan.refreshedInputs.join(', ') }}</strong>.
        </p>
        <p v-if="plan.keptInputs.length" class="restart-line restart-muted">
          Still using the version this round started from:
          {{ plan.keptInputs.join(', ') }} — the steps that are not re-running were built from it.
        </p>

        <p v-if="plan.jobTypes.includes('das_extraction')" class="restart-warn">
          Your Availability Statement will be cleared and read again from the manuscript.
          Anything typed there by hand is lost.
        </p>

        <!-- Which prompts and model to run with. Above the buttons, not beside
             them: it changes what the run means, and a control that changes the
             meaning of a button belongs before it is pressed. -->
        <fieldset class="restart-params">
          <legend class="restart-params-legend">Run with</legend>
          <label class="restart-param">
            <input v-model="paramsSource" type="radio" value="live" :disabled="busy">
            <span>
              <strong>Today's prompts and settings</strong>
              <em>What you want after changing a prompt or switching model.</em>
            </span>
          </label>
          <label class="restart-param">
            <input v-model="paramsSource" type="radio" value="frozen" :disabled="busy">
            <span>
              <strong>The prompts and settings these steps last used</strong>
              <em>
                For telling a flaky answer from a changed one — the only thing
                that differs is the run itself. A step with nothing recorded
                runs with today's, and its page says so.
              </em>
            </span>
          </label>
        </fieldset>

        <div class="restart-actions">
          <button type="button" class="restart-cancel" :disabled="busy" @click="$emit('cancel')">
            Cancel
          </button>
          <button
            type="button"
            class="restart-go"
            :disabled="busy"
            @click="emit('confirm', { paramsSource })"
          >
            {{ busy ? 'Starting…' : 'Restart from here' }}
          </button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.restart-params {
  margin: 0.9rem 0 0;
  padding: 0.6rem 0.75rem;
  border: 1px solid #e5e7eb;
  border-radius: 0.5rem;
}
.restart-params-legend {
  padding: 0 0.35rem;
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: #6b7280;
}
.restart-param {
  display: flex;
  gap: 0.55rem;
  align-items: flex-start;
  padding: 0.3rem 0;
  cursor: pointer;
}
.restart-param input { margin-top: 0.2rem; flex-shrink: 0; }
.restart-param strong { display: block; font-size: 0.85rem; font-weight: 600; color: #111827; }
.restart-param em { display: block; font-style: normal; font-size: 0.78rem; color: #6b7280; }

.restart-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(17, 24, 39, 0.45);
}
.restart-dialog {
  width: 100%;
  max-width: 30rem;
  max-height: 90vh;
  overflow-y: auto;
  padding: 1.25rem;
  border-radius: 0.75rem;
  background: #fff;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.2);
}
.restart-title { font-size: 1.05rem; font-weight: 600; color: #111827; margin-bottom: 0.6rem; }
.restart-line { font-size: 0.875rem; color: #374151; margin-bottom: 0.5rem; }
.restart-muted { color: #6b7280; }
.restart-list {
  margin: 0 0 0.6rem 0.25rem;
  padding-left: 1rem;
  list-style: disc;
  font-size: 0.85rem;
  color: #374151;
}
.restart-warn {
  margin: 0.6rem 0 0;
  padding: 0.5rem 0.65rem;
  border-radius: 0.375rem;
  background: #fef2f2;
  border: 1px solid #fecaca;
  font-size: 0.83rem;
  color: #991b1b;
}
.restart-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; }
.restart-cancel {
  padding: 0.45rem 0.9rem; border-radius: 0.375rem;
  border: 1px solid #d1d5db; background: #fff; color: #374151;
  font-size: 0.875rem; font-weight: 500;
}
.restart-cancel:hover:not(:disabled) { background: #f9fafb; }
.restart-go {
  padding: 0.45rem 0.9rem; border-radius: 0.375rem;
  background: #2563eb; color: #fff; font-size: 0.875rem; font-weight: 600;
}
.restart-go:hover:not(:disabled) { background: #1d4ed8; }
.restart-cancel:disabled, .restart-go:disabled { opacity: 0.6; cursor: not-allowed; }

.fade-enter-active, .fade-leave-active { transition: opacity 0.15s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
