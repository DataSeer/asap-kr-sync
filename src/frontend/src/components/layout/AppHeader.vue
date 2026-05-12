<script setup>
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth.store'
import api from '@/services/api'

const authStore = useAuthStore()
const isDev = ref(false)

onMounted(async () => {
  document.addEventListener('click', handleClickOutside)
  try {
    const { data } = await api.get('/config/environment')
    isDev.value = data.environment !== 'production'
  } catch {
    // ignore
  }
})

const user = computed(() => authStore.user)
const isRealAdmin = computed(() => authStore.isRealAdmin)
const effectiveRole = computed(() => authStore.effectiveRole)
const viewAsRole = computed(() => authStore.viewAsRole)

const showRoleSwitcher = ref(false)
const availableRoles = ['author', 'asap_pm', 'ds_annotator', 'admin']


onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})

function handleClickOutside(event) {
  const target = event.target
  if (!target.closest('.role-dropdown') && !target.closest('.role-button')) {
    showRoleSwitcher.value = false
  }
}

function handleRoleSwitch(role) {
  if (role === user.value?.role) {
    authStore.clearViewAsRole()
  } else {
    authStore.setViewAsRole(role)
  }
  showRoleSwitcher.value = false
}

function clearViewAs() {
  authStore.clearViewAsRole()
}
</script>

<template>
  <header class="bg-white shadow-sm border-b border-gray-200">
    <div class="px-6 py-4 flex items-center justify-between">
      <div class="flex items-center space-x-6">
        <RouterLink :to="{ name: 'dashboard' }" class="text-xl font-bold text-primary-600 hover:text-primary-700 transition-colors">
          KRT Assist
          <span v-if="isDev" class="dev-badge">(DEV)</span>
        </RouterLink>
      </div>

      <div class="flex items-center space-x-4">
        <!-- View As indicator (for admins viewing as another role) -->
        <div v-if="viewAsRole" class="flex items-center space-x-2 bg-yellow-100 border border-yellow-300 rounded-lg px-3 py-1">
          <span class="text-xs text-yellow-800">Viewing as:</span>
          <span class="badge-warning text-xs">{{ viewAsRole }}</span>
          <button class="text-yellow-600 hover:text-yellow-800 ml-1" title="Exit view mode" @click="clearViewAs">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <!-- Admin Role Switcher -->
        <div v-if="isRealAdmin" class="relative">
          <button
            class="role-button flex items-center space-x-1 text-sm text-gray-500 hover:text-gray-700 border border-gray-300 rounded px-2 py-1"
            title="View UI as different role (debug)"
            @click="showRoleSwitcher = !showRoleSwitcher"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
            <span>View as</span>
          </button>

          <!-- Dropdown -->
          <div
            v-if="showRoleSwitcher"
            class="role-dropdown absolute right-0 mt-1 w-40 bg-white border border-gray-200 rounded-lg shadow-lg z-50"
          >
            <button
              v-for="role in availableRoles"
              :key="role"
              :class="[
                'w-full text-left px-4 py-2 text-sm hover:bg-gray-100 first:rounded-t-lg last:rounded-b-lg',
                effectiveRole === role ? 'bg-primary-50 text-primary-700 font-medium' : 'text-gray-700'
              ]"
              @click="handleRoleSwitch(role)"
            >
              {{ role }}
              <span v-if="role === user?.role" class="text-xs text-gray-400 ml-1">(actual)</span>
            </button>
          </div>
        </div>

        <!-- User info -->
        <RouterLink v-if="user" :to="{ name: 'profile' }" class="flex items-center space-x-3 hover:bg-gray-100 rounded-lg px-2 py-1 transition-colors">
          <span class="text-sm text-gray-600">{{ user.name }}</span>
          <span class="badge-primary">{{ effectiveRole }}</span>
        </RouterLink>
      </div>
    </div>
  </header>
</template>

<style scoped>
.dev-badge {
  font-size: 0.7rem;
  font-weight: 700;
  color: #dc2626;
  vertical-align: super;
  margin-left: 0.25rem;
}
</style>
