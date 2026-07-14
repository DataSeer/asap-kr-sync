<script setup>
import { ref, computed, onMounted } from 'vue'
import Papa from 'papaparse'
import { useTeamsStore } from '@/stores/teams.store'
import { useNotificationStore } from '@/stores/notification.store'
import SearchInput from '@/components/common/SearchInput.vue'

const teamsStore = useTeamsStore()
const notificationStore = useNotificationStore()

const loading = ref(true)
const search = ref('')
const exporting = ref(false)
const importing = ref(false)
const fileInput = ref(null)

const filteredTeams = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return teamsStore.teams
  return teamsStore.teams.filter(t =>
    (t.code || '').toLowerCase().includes(q) || (t.name || '').toLowerCase().includes(q)
  )
})
const showEditModal = ref(false)
const showCreateModal = ref(false)
const editingTeam = ref(null)
const saving = ref(false)

// Form fields for editing
const editForm = ref({
  code: '',
  name: '',
  active: true
})

// Form fields for creating
const createForm = ref({
  code: '',
  name: ''
})

onMounted(async () => {
  await fetchTeams()
})

async function fetchTeams() {
  loading.value = true
  try {
    await teamsStore.fetchTeams({ limit: 100 })
  } catch (error) {
    notificationStore.error('Failed to load teams')
  } finally {
    loading.value = false
  }
}

function formatDate(date) {
  return new Date(date).toLocaleDateString()
}

async function handleExport() {
  exporting.value = true
  try {
    const csv = await teamsStore.exportTeams()
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'teams.csv'
    a.click()
    URL.revokeObjectURL(url)
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to export teams')
  } finally {
    exporting.value = false
  }
}

async function handleImportFile(event) {
  const file = event.target.files?.[0]
  event.target.value = '' // allow re-selecting the same file
  if (!file) return

  const text = await file.text()
  const { data } = Papa.parse(text, { header: true, skipEmptyLines: true, transformHeader: h => h.trim().toLowerCase() })
  const rows = data
    .map(r => ({
      code: (r.code ?? r.team ?? '').toString().trim(),
      name: (r.name || '').toString().trim(),
      active: (r.active ?? '').toString().trim()
    }))
    .filter(r => r.code)

  if (rows.length === 0) {
    notificationStore.error('No team rows found — the CSV needs a "code" column')
    return
  }
  if (!confirm(`Import ${rows.length} team(s)? Existing codes will be updated.`)) return

  importing.value = true
  try {
    const res = await teamsStore.importTeams(rows)
    const parts = [`${res.created} created`, `${res.updated} updated`]
    if (res.invalid?.length) parts.push(`${res.invalid.length} skipped`)
    notificationStore.success(`Teams imported — ${parts.join(', ')}`)
    await fetchTeams()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to import teams')
  } finally {
    importing.value = false
  }
}

function openEditModal(team) {
  editingTeam.value = team
  editForm.value = {
    code: team.code,
    name: team.name || '',
    active: team.active
  }
  showEditModal.value = true
}

function closeEditModal() {
  showEditModal.value = false
  editingTeam.value = null
  editForm.value = { code: '', name: '', active: true }
}

async function handleSaveTeam() {
  if (!editingTeam.value) return

  saving.value = true
  try {
    await teamsStore.updateTeam(editingTeam.value.id, {
      code: editForm.value.code,
      name: editForm.value.name || null,
      active: editForm.value.active
    })
    notificationStore.success('Team updated successfully')
    closeEditModal()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to update team')
  } finally {
    saving.value = false
  }
}

async function handleDeleteTeam(team) {
  if (!confirm(`Are you sure you want to delete team "${team.code}"?`)) {
    return
  }

  try {
    await teamsStore.deleteTeam(team.id)
    notificationStore.success('Team deleted successfully')
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to delete team')
  }
}

function openCreateModal() {
  createForm.value = {
    code: '',
    name: ''
  }
  showCreateModal.value = true
}

function closeCreateModal() {
  showCreateModal.value = false
  createForm.value = { code: '', name: '' }
}

async function handleCreateTeam() {
  saving.value = true
  try {
    await teamsStore.createTeam({
      code: createForm.value.code,
      name: createForm.value.name || null
    })
    notificationStore.success('Team created successfully')
    closeCreateModal()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to create team')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="flex items-center justify-between mb-6 flex-shrink-0">
      <h1 class="text-2xl font-bold text-gray-900">Teams</h1>
      <div class="flex items-center gap-2">
        <input ref="fileInput" type="file" accept=".csv,text/csv" class="hidden" @change="handleImportFile" />
        <button class="btn-secondary" :disabled="exporting" @click="handleExport">
          {{ exporting ? 'Exporting…' : 'Export CSV' }}
        </button>
        <button class="btn-secondary" :disabled="importing" @click="fileInput?.click()">
          {{ importing ? 'Importing…' : 'Import CSV' }}
        </button>
        <button class="btn-primary" @click="openCreateModal">
          Create Team
        </button>
      </div>
    </div>

    <div v-if="loading" class="flex-1 flex items-center justify-center py-12">
      <svg class="animate-spin h-8 w-8 text-primary-600" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
    </div>

    <div v-else class="card !p-0 flex-1 min-h-0 overflow-y-auto">
      <table class="min-w-full divide-y divide-gray-200">
        <thead class="bg-gray-50 sticky top-0 z-10">
          <tr>
            <th colspan="5" class="px-4 py-3 bg-white border-b border-gray-200">
              <SearchInput v-model="search" full-width placeholder="Search teams…" />
            </th>
          </tr>
          <tr>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Team</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
            <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
          </tr>
        </thead>
        <tbody class="bg-white divide-y divide-gray-200">
          <tr v-for="team in filteredTeams" :key="team.id" :class="{ 'bg-gray-50 opacity-60': !team.active }">
            <td class="px-6 py-4 whitespace-nowrap">
              <div class="font-medium text-gray-900">{{ team.code }}</div>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-gray-500">
              {{ team.name || '-' }}
            </td>
            <td class="px-6 py-4 whitespace-nowrap">
              <span :class="team.active ? 'badge-success' : 'badge-gray'">
                {{ team.active ? 'Active' : 'Inactive' }}
              </span>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-gray-500">
              {{ formatDate(team.created_at) }}
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-right">
              <button
                class="text-primary-600 hover:text-primary-800 mr-3"
                @click="openEditModal(team)"
              >
                Edit
              </button>
              <button
                class="text-red-600 hover:text-red-800"
                @click="handleDeleteTeam(team)"
              >
                Delete
              </button>
            </td>
          </tr>
          <tr v-if="filteredTeams.length === 0">
            <td colspan="5" class="px-6 py-8 text-center text-gray-500">
              {{ search ? 'No teams match your search.' : 'No teams found. Create one to get started.' }}
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
          <h2 class="text-lg font-medium text-gray-900 mb-4">Edit Team</h2>

          <form class="space-y-4" @submit.prevent="handleSaveTeam">
            <div>
              <label class="label">Team name</label>
              <input
                v-model="editForm.code"
                type="text"
                class="input"
                required
                maxlength="100"
                placeholder="e.g., Alessi"
              />
              <p class="mt-1 text-xs text-gray-500">Team name — the lab leader (e.g. Alessi)</p>
            </div>

            <div>
              <label class="label">Name (optional)</label>
              <input
                v-model="editForm.name"
                type="text"
                class="input"
                maxlength="100"
                placeholder="e.g., Alessi Lab"
              />
              <p class="mt-1 text-xs text-gray-500">Descriptive name for the team</p>
            </div>

            <div>
              <label class="flex items-center">
                <input
                  v-model="editForm.active"
                  type="checkbox"
                  class="h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500"
                />
                <span class="ml-2 text-sm text-gray-700">Active</span>
              </label>
              <p class="mt-1 text-xs text-gray-500">Inactive teams won't appear in selection lists</p>
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
          <h2 class="text-lg font-medium text-gray-900 mb-4">Create Team</h2>

          <form class="space-y-4" @submit.prevent="handleCreateTeam">
            <div>
              <label class="label">Team name</label>
              <input
                v-model="createForm.code"
                type="text"
                class="input"
                required
                maxlength="100"
                placeholder="e.g., Alessi"
              />
              <p class="mt-1 text-xs text-gray-500">Team name — the lab leader (e.g. Alessi)</p>
            </div>

            <div>
              <label class="label">Name (optional)</label>
              <input
                v-model="createForm.name"
                type="text"
                class="input"
                maxlength="100"
                placeholder="e.g., Alessi Lab"
              />
              <p class="mt-1 text-xs text-gray-500">Descriptive name for the team</p>
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
