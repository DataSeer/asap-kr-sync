<script setup>
import { ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth.store'
import { useNotificationStore } from '@/stores/notification.store'
import profileService from '@/services/profile.service'

const authStore = useAuthStore()
const notificationStore = useNotificationStore()

const loading = ref(true)
const saving = ref(false)
const profile = ref(null)

// Form data
const name = ref('')
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')

onMounted(async () => {
  try {
    const response = await profileService.getProfile()
    profile.value = response.user
    name.value = profile.value.name
  } catch (error) {
    notificationStore.error('Failed to load profile')
  } finally {
    loading.value = false
  }
})

async function handleUpdateProfile() {
  saving.value = true

  try {
    const data = {}

    // Update name if changed
    if (name.value !== profile.value.name) {
      data.name = name.value
    }

    // Update password if provided
    if (newPassword.value) {
      if (newPassword.value !== confirmPassword.value) {
        notificationStore.error('Passwords do not match')
        saving.value = false
        return
      }
      if (newPassword.value.length < 6) {
        notificationStore.error('Password must be at least 6 characters')
        saving.value = false
        return
      }
      if (!currentPassword.value) {
        notificationStore.error('Current password is required')
        saving.value = false
        return
      }
      data.currentPassword = currentPassword.value
      data.newPassword = newPassword.value
    }

    if (Object.keys(data).length === 0) {
      notificationStore.info('No changes to save')
      saving.value = false
      return
    }

    const response = await profileService.updateProfile(data)
    profile.value = response.user
    authStore.user.name = response.user.name

    // Clear password fields
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''

    notificationStore.success('Profile updated successfully')
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to update profile')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="max-w-2xl mx-auto">
    <h1 class="text-2xl font-bold text-gray-900 mb-6">My Profile</h1>

    <div v-if="loading" class="flex items-center justify-center py-12">
      <svg class="animate-spin h-8 w-8 text-primary-600" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
    </div>

    <form v-else class="space-y-6" @submit.prevent="handleUpdateProfile">
      <!-- Account Information -->
      <div class="card">
        <h2 class="text-lg font-medium text-gray-900 mb-4">Account Information</h2>

        <div class="space-y-4">
          <div>
            <label class="label">Email</label>
            <input
              type="email"
              :value="profile.email"
              disabled
              class="input bg-gray-50 text-gray-500 cursor-not-allowed"
            />
            <p class="mt-1 text-xs text-gray-500">Email cannot be changed</p>
          </div>

          <div>
            <label class="label">Name</label>
            <input
              v-model="name"
              type="text"
              class="input"
              required
              minlength="2"
              maxlength="100"
            />
          </div>

          <div>
            <label class="label">Role</label>
            <div class="mt-1">
              <span class="badge-primary">{{ profile.role }}</span>
            </div>
          </div>

          <div>
            <label class="label">Teams</label>
            <div class="mt-1 flex flex-wrap gap-2">
              <span v-for="team in profile.teams" v-if="profile.teams && profile.teams.length > 0" :key="team" class="badge-gray">
                {{ team }}
              </span>
              <span v-else class="text-sm text-gray-500">No teams assigned</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Change Password (hidden for Auth0 users) -->
      <div v-if="authStore.isAuth0User" class="card">
        <h2 class="text-lg font-medium text-gray-900 mb-4">Password</h2>
        <p class="text-sm text-gray-500">Your password is managed by your identity provider.</p>
      </div>

      <div v-else class="card">
        <h2 class="text-lg font-medium text-gray-900 mb-4">Change Password</h2>
        <p class="text-sm text-gray-500 mb-4">Leave blank to keep your current password</p>

        <div class="space-y-4">
          <div>
            <label class="label">Current Password</label>
            <input
              v-model="currentPassword"
              type="password"
              class="input"
              autocomplete="current-password"
            />
          </div>

          <div>
            <label class="label">New Password</label>
            <input
              v-model="newPassword"
              type="password"
              class="input"
              autocomplete="new-password"
              minlength="6"
            />
          </div>

          <div>
            <label class="label">Confirm New Password</label>
            <input
              v-model="confirmPassword"
              type="password"
              class="input"
              autocomplete="new-password"
            />
          </div>
        </div>
      </div>

      <!-- Submit Button -->
      <div class="flex justify-end">
        <button
          type="submit"
          :disabled="saving"
          class="btn-primary"
        >
          <span v-if="saving">Saving...</span>
          <span v-else>Save Changes</span>
        </button>
      </div>
    </form>
  </div>
</template>
