<script setup>
import { ref, onMounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth.store'
import { useNotificationStore } from '@/stores/notification.store'
import api from '@/services/api'
import configService from '@/services/config.service'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()
const notificationStore = useNotificationStore()

const activeTab = ref('asap') // 'asap' or 'local'
const loading = ref(false)
const auth0Enabled = ref(false)
const auth0StatusLoaded = ref(false)
const signupEnabled = ref(false)

// ASAP form fields
const asapEmail = ref('')
const asapPassword = ref('')

// Local form fields
const localEmail = ref('')
const localPassword = ref('')

// Map known Auth0/server error codes to user-friendly messages so we never
// render an attacker-controlled query parameter directly.
const KNOWN_AUTH_ERRORS = {
  access_denied: 'Access denied. Please try again.',
  unauthorized: 'Authentication failed.',
  invalid_state: 'Login session expired. Please try again.',
  invalid_nonce: 'Login session expired. Please try again.'
}
if (route.query.error) {
  notificationStore.error(KNOWN_AUTH_ERRORS[route.query.error] || 'Authentication error. Please try again.')
}

// Fetch Auth0 availability + public auth flags on mount
onMounted(async () => {
  try {
    const response = await api.get('/auth/auth0/status')
    auth0Enabled.value = response.data.enabled
  } catch {
    auth0Enabled.value = false
  } finally {
    auth0StatusLoaded.value = true
  }

  configService.getEnvironment()
    .then(env => { signupEnabled.value = !!env.signupEnabled })
    .catch(() => { signupEnabled.value = false })
})

function redirectAfterLogin() {
  // Only follow relative paths starting with a single "/" — rejects
  // protocol-relative ("//evil.com") and absolute external URLs
  // ("https://evil.com") used in open-redirect phishing.
  const requested = route.query.redirect
  const isSafeRelative = typeof requested === 'string'
    && requested.startsWith('/')
    && !requested.startsWith('//')
  router.push(isSafeRelative ? requested : '/dashboard')
}

async function handleAsapPasswordLogin() {
  loading.value = true
  try {
    await authStore.auth0PasswordLogin(asapEmail.value, asapPassword.value)
    notificationStore.success('Login successful')
    redirectAfterLogin()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Login failed')
  } finally {
    loading.value = false
  }
}

async function handleLocalLogin() {
  loading.value = true
  try {
    await authStore.login(localEmail.value, localPassword.value)
    notificationStore.success('Login successful')
    redirectAfterLogin()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Login failed')
  } finally {
    loading.value = false
  }
}

function loginWithGoogle() {
  window.location.href = '/api/auth/auth0/login?connection=google-oauth2'
}

function loginWithOrcid() {
  window.location.href = '/api/auth/auth0/login?connection=ORCID'
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
    <div class="max-w-md w-full space-y-8">
      <div>
        <h1 class="text-center text-3xl font-bold text-primary-600">KRT Assist</h1>
        <h2 class="mt-6 text-center text-2xl font-bold text-gray-900">
          Sign in to your account
        </h2>
      </div>

      <!-- Tab Selector -->
      <div class="flex rounded-lg border border-gray-300 overflow-hidden">
        <button
          type="button"
          class="flex-1 py-2.5 text-sm font-medium text-center transition-colors"
          :class="activeTab === 'asap'
            ? 'bg-primary-600 text-white'
            : 'bg-white text-gray-600 hover:bg-gray-50'"
          @click="activeTab = 'asap'"
        >
          ASAP Hub
        </button>
        <button
          type="button"
          class="flex-1 py-2.5 text-sm font-medium text-center transition-colors border-l border-gray-300"
          :class="activeTab === 'local'
            ? 'bg-primary-600 text-white'
            : 'bg-white text-gray-600 hover:bg-gray-50'"
          @click="activeTab = 'local'"
        >
          DataSeer
        </button>
      </div>

      <!-- ─── ASAP Tab ─── -->
      <div v-if="activeTab === 'asap'" class="space-y-6">
        <p class="text-sm text-gray-500 text-center">
          Sign in with your ASAP account
        </p>

        <!-- Unavailable banner -->
        <div
          v-if="auth0StatusLoaded && !auth0Enabled"
          class="rounded-lg border border-amber-200 bg-amber-50 p-4"
        >
          <p class="text-sm text-amber-800 text-center">
            This authentication method is not available at the moment. Please use the <button type="button" class="font-medium underline hover:text-amber-900" @click="activeTab = 'local'">DataSeer</button> login instead.
          </p>
        </div>

        <!-- ASAP Email/Password Form -->
        <form class="space-y-4" @submit.prevent="handleAsapPasswordLogin">
          <div>
            <label for="asap-email" class="label">Email address</label>
            <input
              id="asap-email"
              v-model="asapEmail"
              name="email"
              type="email"
              autocomplete="email"
              required
              :disabled="!auth0Enabled"
              class="input"
              :class="{ 'bg-gray-100 text-gray-400 cursor-not-allowed': !auth0Enabled }"
              placeholder="Enter your ASAP email"
            />
          </div>

          <div>
            <label for="asap-password" class="label">Password</label>
            <input
              id="asap-password"
              v-model="asapPassword"
              name="password"
              type="password"
              autocomplete="current-password"
              required
              :disabled="!auth0Enabled"
              class="input"
              :class="{ 'bg-gray-100 text-gray-400 cursor-not-allowed': !auth0Enabled }"
              placeholder="Enter your ASAP password"
            />
          </div>

          <button
            type="submit"
            :disabled="loading || !auth0Enabled"
            class="w-full btn-primary"
            :class="{ 'opacity-50 cursor-not-allowed': !auth0Enabled }"
          >
            <span v-if="loading" class="flex items-center justify-center">
              <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Signing in...
            </span>
            <span v-else>Sign in with ASAP</span>
          </button>
        </form>

        <!-- Divider -->
        <div class="relative">
          <div class="absolute inset-0 flex items-center">
            <div class="w-full border-t border-gray-300"></div>
          </div>
          <div class="relative flex justify-center text-sm">
            <span class="px-2 bg-gray-50 text-gray-500">Or continue with</span>
          </div>
        </div>

        <!-- Social Login Buttons -->
        <div class="space-y-3">
          <button
            type="button"
            :disabled="!auth0Enabled"
            class="w-full flex items-center justify-center gap-3 px-4 py-2.5 border border-gray-300 rounded-lg shadow-sm bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
            :class="{ 'opacity-50 cursor-not-allowed hover:bg-white': !auth0Enabled }"
            @click="loginWithGoogle"
          >
            <svg class="h-5 w-5" viewBox="0 0 24 24">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            Sign in with Google
          </button>

          <button
            type="button"
            :disabled="!auth0Enabled"
            class="w-full flex items-center justify-center gap-3 px-4 py-2.5 border border-gray-300 rounded-lg shadow-sm bg-white text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
            :class="{ 'opacity-50 cursor-not-allowed hover:bg-white': !auth0Enabled }"
            @click="loginWithOrcid"
          >
            <svg class="h-5 w-5" viewBox="0 0 24 24" fill="#A6CE39">
              <path d="M12 0C5.372 0 0 5.372 0 12s5.372 12 12 12 12-5.372 12-12S18.628 0 12 0zM7.369 4.378c.525 0 .947.431.947.947s-.422.947-.947.947a.95.95 0 01-.947-.947c0-.525.422-.947.947-.947zm-.722 3.038h1.444v10.041H6.647V7.416zm3.562 0h3.9c3.712 0 5.344 2.653 5.344 5.025 0 2.578-2.016 5.025-5.325 5.025h-3.919V7.416zm1.444 1.303v7.444h2.297c3.272 0 4.05-2.456 4.05-3.722 0-1.959-1.322-3.722-3.956-3.722h-2.391z" />
            </svg>
            Sign in with ORCID
          </button>
        </div>
      </div>

      <!-- ─── Local Tab ─── -->
      <div v-if="activeTab === 'local'" class="space-y-6">
        <p class="text-sm text-gray-500 text-center">
          Sign in with your KR-Sync account
        </p>

        <form class="space-y-4" @submit.prevent="handleLocalLogin">
          <div>
            <label for="local-email" class="label">Email address</label>
            <input
              id="local-email"
              v-model="localEmail"
              name="email"
              type="email"
              autocomplete="email"
              required
              class="input"
              placeholder="Enter your email"
            />
          </div>

          <div>
            <label for="local-password" class="label">Password</label>
            <input
              id="local-password"
              v-model="localPassword"
              name="password"
              type="password"
              autocomplete="current-password"
              required
              class="input"
              placeholder="Enter your password"
            />
          </div>

          <button
            type="submit"
            :disabled="loading"
            class="w-full btn-primary"
          >
            <span v-if="loading" class="flex items-center justify-center">
              <svg class="animate-spin -ml-1 mr-3 h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Signing in...
            </span>
            <span v-else>Sign in</span>
          </button>

          <div v-if="signupEnabled" class="text-center">
            <RouterLink to="/register" class="text-sm text-primary-600 hover:text-primary-500">
              Don't have an account? Register
            </RouterLink>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>
