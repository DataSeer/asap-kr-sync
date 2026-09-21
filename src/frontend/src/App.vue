<script setup>
import { RouterView } from 'vue-router'
import NotificationContainer from '@/components/common/NotificationContainer.vue'
import ReconnectingBanner from '@/components/common/ReconnectingBanner.vue'
</script>

<template>
  <ReconnectingBanner />
  <NotificationContainer />
  <RouterView />
</template>
