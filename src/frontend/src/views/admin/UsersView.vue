<script setup>
import { ref, computed, onMounted } from 'vue'
import api from '@/services/api'
import { useAuthStore } from '@/stores/auth.store'
import { useNotificationStore } from '@/stores/notification.store'
import { useTeamsStore } from '@/stores/teams.store'

const authStore = useAuthStore()
const notificationStore = useNotificationStore()
const teamsStore = useTeamsStore()

const users = ref([])
const loading = ref(true)
const showEditModal = ref(false)
const showCreateModal = ref(false)
const editingUser = ref(null)
const saving = ref(false)

// Form fields for editing
const editForm = ref({
  name: '',
  role: '',
  teams: [],
  password: ''
})

// Form fields for creating
const createForm = ref({
  email: '',
  name: '',
  role: 'author',
  teams: [],
  password: ''
})

// Available teams from database
const availableTeams = computed(() => teamsStore.teamCodes)

const availableRoles = ['author', 'asap_pm', 'ds_annotator', 'admin']

const canManageUsers = computed(() => authStore.canManageUsers)
const isAdmin = computed(() => authStore.isAdmin)

onMounted(async () => {
  await Promise.all([
    fetchUsers(),
    teamsStore.fetchTeamCodes()
  ])
})

async function fetchUsers() {
  loading.value = true
  try {
    const response = await api.get('/users')
    users.value = response.data.users
  } catch (error) {
    notificationStore.error('Failed to load users')
  } finally {
    loading.value = false
  }
}

function formatDate(date) {
  return new Date(date).toLocaleDateString()
}

function openEditModal(user) {
  editingUser.value = user
  editForm.value = {
    name: user.name,
    role: user.role,
    teams: [...(user.teams || [])],
    password: ''
  }
  showEditModal.value = true
}

function closeEditModal() {
  showEditModal.value = false
  editingUser.value = null
  editForm.value = { name: '', role: '', teams: [], password: '' }
}

async function handleSaveUser() {
  if (!editingUser.value) return

  saving.value = true
  try {
    const data = {
      name: editForm.value.name,
      role: editForm.value.role,
      teams: editForm.value.teams
    }

    if (editForm.value.password) {
      data.password = editForm.value.password
    }

    await api.patch(`/users/${editingUser.value.id}`, data)
    notificationStore.success('User updated successfully')
    closeEditModal()
    await fetchUsers()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to update user')
  } finally {
    saving.value = false
  }
}

async function handleDeleteUser(user) {
  if (!confirm(`Are you sure you want to delete ${user.name}?`)) {
    return
  }

  try {
    await api.delete(`/users/${user.id}`)
    notificationStore.success('User deleted successfully')
    await fetchUsers()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to delete user')
  }
}

function toggleTeam(team) {
  const index = editForm.value.teams.indexOf(team)
  if (index === -1) {
    editForm.value.teams.push(team)
  } else {
    editForm.value.teams.splice(index, 1)
  }
}

function toggleCreateTeam(team) {
  const index = createForm.value.teams.indexOf(team)
  if (index === -1) {
    createForm.value.teams.push(team)
  } else {
    createForm.value.teams.splice(index, 1)
  }
}

function openCreateModal() {
  createForm.value = {
    email: '',
    name: '',
    role: 'author',
    teams: [],
    password: ''
  }
  showCreateModal.value = true
}

function closeCreateModal() {
  showCreateModal.value = false
  createForm.value = { email: '', name: '', role: 'author', teams: [], password: '' }
}

async function handleCreateUser() {
  saving.value = true
  try {
    await api.post('/users', {
      email: createForm.value.email,
      name: createForm.value.name,
      role: createForm.value.role,
      teams: createForm.value.teams,
      password: createForm.value.password
    })
    notificationStore.success('User created successfully')
    closeCreateModal()
    await fetchUsers()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to create user')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <h1 class="text-2xl font-bold text-gray-900">Users</h1>
      <button v-if="canManageUsers" class="btn-primary" @click="openCreateModal">
        Create User
      </button>
    </div>

    <div v-if="loading" class="flex items-center justify-center py-12">
      <svg class="animate-spin h-8 w-8 text-primary-600" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
    </div>

    <div v-else class="card overflow-hidden">
      <table class="min-w-full divide-y divide-gray-200">
        <thead class="bg-gray-50">
          <tr>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Email</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Role</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Teams</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
            <th v-if="canManageUsers" class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
          </tr>
        </thead>
        <tbody class="bg-white divide-y divide-gray-200">
          <tr v-for="user in users" :key="user.id">
            <td class="px-6 py-4 whitespace-nowrap">
              <div class="font-medium text-gray-900">{{ user.name }}</div>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-gray-500">
              {{ user.email }}
            </td>
            <td class="px-6 py-4 whitespace-nowrap">
              <span class="badge-primary">{{ user.role }}</span>
            </td>
            <td class="px-6 py-4 whitespace-nowrap">
              <div class="flex flex-wrap gap-1">
                <span v-for="team in user.teams" v-if="user.teams && user.teams.length > 0" :key="team" class="badge-gray text-xs">
                  {{ team }}
                </span>
                <span v-else class="text-gray-400">-</span>
              </div>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-gray-500">
              {{ formatDate(user.createdAt) }}
            </td>
            <td v-if="canManageUsers" class="px-6 py-4 whitespace-nowrap text-right">
              <button
                class="text-primary-600 hover:text-primary-800 mr-3"
                @click="openEditModal(user)"
              >
                Edit
              </button>
              <button
                v-if="isAdmin && user.id !== authStore.user?.id"
                class="text-red-600 hover:text-red-800"
                @click="handleDeleteUser(user)"
              >
                Delete
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Edit Modal -->
    <div v-if="showEditModal" class="fixed inset-0 z-50 overflow-y-auto">
      <div class="flex items-center justify-center min-h-screen px-4">
        <div class="fixed inset-0 bg-black bg-opacity-50" @click="closeEditModal"></div>

        <div class="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
          <h2 class="text-lg font-medium text-gray-900 mb-4">Edit User</h2>

          <form class="space-y-4" @submit.prevent="handleSaveUser">
            <div>
              <label class="label">Name</label>
              <input v-model="editForm.name" type="text" class="input" required />
            </div>

            <div>
              <label class="label">Role</label>
              <select v-model="editForm.role" class="input">
                <option v-for="role in availableRoles" :key="role" :value="role">
                  {{ role }}
                </option>
              </select>
            </div>

            <div>
              <label class="label">Teams</label>
              <div class="flex flex-wrap gap-2 mt-2 max-h-32 overflow-y-auto p-2 border rounded">
                <button
                  v-for="team in availableTeams"
                  :key="team"
                  type="button"
                  :class="[
                    'px-2 py-1 text-xs rounded transition-colors',
                    editForm.teams.includes(team)
                      ? 'bg-primary-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  ]"
                  @click="toggleTeam(team)"
                >
                  {{ team }}
                </button>
              </div>
              <p class="mt-1 text-xs text-gray-500">Click to toggle team assignment</p>
            </div>

            <div>
              <label class="label">New Password</label>
              <input v-model="editForm.password" type="password" class="input" placeholder="Leave blank to keep current" />
            </div>

            <div class="flex justify-end space-x-3 pt-4">
              <button type="button" class="btn-secondary" @click="closeEditModal">
                Cancel
              </button>
              <button type="submit" :disabled="saving" class="btn-primary">
                {{ saving ? 'Saving...' : 'Save' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>

    <!-- Create Modal -->
    <div v-if="showCreateModal" class="fixed inset-0 z-50 overflow-y-auto">
      <div class="flex items-center justify-center min-h-screen px-4">
        <div class="fixed inset-0 bg-black bg-opacity-50" @click="closeCreateModal"></div>

        <div class="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
          <h2 class="text-lg font-medium text-gray-900 mb-4">Create User</h2>

          <form class="space-y-4" @submit.prevent="handleCreateUser">
            <div>
              <label class="label">Email</label>
              <input v-model="createForm.email" type="email" class="input" required />
            </div>

            <div>
              <label class="label">Name</label>
              <input v-model="createForm.name" type="text" class="input" required />
            </div>

            <div>
              <label class="label">Password</label>
              <input v-model="createForm.password" type="password" class="input" required minlength="8" />
            </div>

            <div>
              <label class="label">Role</label>
              <select v-model="createForm.role" class="input">
                <option v-for="role in availableRoles" :key="role" :value="role">
                  {{ role }}
                </option>
              </select>
            </div>

            <div>
              <label class="label">Teams</label>
              <div class="flex flex-wrap gap-2 mt-2 max-h-32 overflow-y-auto p-2 border rounded">
                <button
                  v-for="team in availableTeams"
                  :key="team"
                  type="button"
                  :class="[
                    'px-2 py-1 text-xs rounded transition-colors',
                    createForm.teams.includes(team)
                      ? 'bg-primary-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  ]"
                  @click="toggleCreateTeam(team)"
                >
                  {{ team }}
                </button>
              </div>
              <p class="mt-1 text-xs text-gray-500">Click to toggle team assignment</p>
            </div>

            <div class="flex justify-end space-x-3 pt-4">
              <button type="button" class="btn-secondary" @click="closeCreateModal">
                Cancel
              </button>
              <button type="submit" :disabled="saving" class="btn-primary">
                {{ saving ? 'Creating...' : 'Create' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  </div>
</template>
