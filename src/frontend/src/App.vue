<script setup>
import { onMounted, onUnmounted } from 'vue'
import { RouterView, useRouter } from 'vue-router'
import NotificationContainer from '@/components/common/NotificationContainer.vue'
import ReconnectingBanner from '@/components/common/ReconnectingBanner.vue'
import { onLogout } from '@/services/session-broadcast'
import { useAuthStore } from '@/stores/auth.store'

// Another tab signed out. The session is already revoked server-side, so this
// tab is showing stale content — drop it and go to the login page rather than
// waiting for its next request to fail (ASAP, 2026-09).
const router = useRouter()
const authStore = useAuthStore()
let stopListening = () => {}

onMounted(() => {
  stopListening = onLogout(() => {
    authStore.clearAuth()
    // Already on login: nothing to navigate to, and pushing would be a
    // redundant navigation.
    if (router.currentRoute.value.name !== 'login') {
      router.push({ name: 'login' })
    }
  })
})

onUnmounted(() => stopListening())
</script>

<template>
  <ReconnectingBanner />
  <NotificationContainer />
  <RouterView />
</template>
