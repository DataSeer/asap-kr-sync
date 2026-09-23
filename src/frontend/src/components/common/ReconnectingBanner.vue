<script setup>
/**
 * A thin strip saying the app is retrying — shown only while a session
 * refresh or a request is being retried after a transient failure. The user
 * keeps working; nothing here asks them to do anything.
 */
import { reconnecting } from '@/services/session-reconnect'
</script>

<template>
  <Transition name="reconnecting">
    <div v-if="reconnecting" class="reconnecting-banner" role="status" aria-live="polite">
      <span class="reconnecting-dot"></span>
      Reconnecting… your changes will be applied as soon as the connection is back.
    </div>
  </Transition>
</template>

<style scoped>
.reconnecting-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.375rem 1rem;
  font-size: 0.8125rem;
  color: #92400e;
  background: #fef3c7;
  border-bottom: 1px solid #fcd34d;
}
.reconnecting-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 9999px;
  background: #d97706;
  animation: reconnecting-pulse 1.2s ease-in-out infinite;
}
@keyframes reconnecting-pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}
.reconnecting-enter-active,
.reconnecting-leave-active {
  transition: opacity 0.2s ease;
}
.reconnecting-enter-from,
.reconnecting-leave-to {
  opacity: 0;
}
</style>
