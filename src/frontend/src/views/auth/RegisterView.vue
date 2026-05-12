<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth.store'
import { useNotificationStore } from '@/stores/notification.store'
import configService from '@/services/config.service'

const router = useRouter()
const authStore = useAuthStore()
const notificationStore = useNotificationStore()

const name = ref('')
const email = ref('')
const password = ref('')
const confirmPassword = ref('')
const loading = ref(false)

// Redirect to /login when self-signup is disabled — covers users who deep-link
// to /register directly. The backend independently rejects the POST so this
// is purely UX, not a security control.
onMounted(async () => {
  try {
    const env = await configService.getEnvironment()
    if (!env.signupEnabled) {
      notificationStore.error('Self-service account creation is disabled. Please contact an administrator.')
      router.replace({ name: 'login' })
    }
  } catch {
    // If we can't reach the API, fall through and let the form attempt — the
    // backend will reject if signup is actually disabled.
  }
})

async function handleSubmit() {
  if (password.value !== confirmPassword.value) {
    notificationStore.error('Passwords do not match')
    return
  }

  loading.value = true

  try {
    await authStore.register({
      name: name.value,
      email: email.value,
      password: password.value
    })
    notificationStore.success('Registration successful')
    router.push('/dashboard')
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Registration failed')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
    <div class="max-w-md w-full space-y-8">
      <div>
        <h1 class="text-center text-3xl font-bold text-primary-600">KRT Assist</h1>
        <h2 class="mt-6 text-center text-2xl font-bold text-gray-900">
          Create your account
        </h2>
      </div>

      <form class="mt-8 space-y-6" @submit.prevent="handleSubmit">
        <div class="space-y-4">
          <div>
            <label for="name" class="label">Full name</label>
            <input
              id="name"
              v-model="name"
              name="name"
              type="text"
              required
              class="input"
              placeholder="Enter your full name"
            />
          </div>

          <div>
            <label for="email" class="label">Email address</label>
            <input
              id="email"
              v-model="email"
              name="email"
              type="email"
              autocomplete="email"
              required
              class="input"
              placeholder="Enter your email"
            />
          </div>

          <div>
            <label for="password" class="label">Password</label>
            <input
              id="password"
              v-model="password"
              name="password"
              type="password"
              required
              class="input"
              placeholder="Create a password"
            />
          </div>

          <div>
            <label for="confirmPassword" class="label">Confirm password</label>
            <input
              id="confirmPassword"
              v-model="confirmPassword"
              name="confirmPassword"
              type="password"
              required
              class="input"
              placeholder="Confirm your password"
            />
          </div>
        </div>

        <div>
          <button
            type="submit"
            :disabled="loading"
            class="w-full btn-primary"
          >
            <span v-if="loading">Creating account...</span>
            <span v-else>Create account</span>
          </button>
        </div>

        <div class="text-center">
          <RouterLink to="/login" class="text-sm text-primary-600 hover:text-primary-500">
            Already have an account? Sign in
          </RouterLink>
        </div>
      </form>
    </div>
  </div>
</template>
