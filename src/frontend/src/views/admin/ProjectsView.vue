<script setup>
/**
 * ProjectsView — manage ASAP projects (2-letter grant codes). Staff only.
 * The code is the manuscript-ID prefix stored on submissions; this page holds
 * its PI/title and active flag, and drives the dashboard's project filter.
 */
import { ref, computed, onMounted } from 'vue'
import { useProjectsStore } from '@/stores/projects.store'
import { useNotificationStore } from '@/stores/notification.store'
import SearchInput from '@/components/common/SearchInput.vue'

const projectsStore = useProjectsStore()
const notificationStore = useNotificationStore()

const loading = ref(true)
const search = ref('')

const filteredProjects = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return projectsStore.projects
  return projectsStore.projects.filter(p =>
    (p.code || '').toLowerCase().includes(q) ||
    (p.piName || '').toLowerCase().includes(q) ||
    (p.title || '').toLowerCase().includes(q)
  )
})
const saving = ref(false)
const showCreateModal = ref(false)
const showEditModal = ref(false)
const editingCode = ref(null)

const createForm = ref({ code: '', piName: '', title: '' })
const editForm = ref({ piName: '', title: '', active: true })

onMounted(async () => {
  await fetchProjects()
})

async function fetchProjects() {
  loading.value = true
  try {
    await projectsStore.fetchProjects({ limit: 200 })
  } catch (error) {
    notificationStore.error('Failed to load projects')
  } finally {
    loading.value = false
  }
}

function openCreateModal() {
  createForm.value = { code: '', piName: '', title: '' }
  showCreateModal.value = true
}

async function handleCreate() {
  saving.value = true
  try {
    await projectsStore.createProject({
      code: createForm.value.code,
      piName: createForm.value.piName || null,
      title: createForm.value.title || null
    })
    notificationStore.success('Project created')
    showCreateModal.value = false
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to create project')
  } finally {
    saving.value = false
  }
}

function openEditModal(project) {
  editingCode.value = project.code
  editForm.value = {
    piName: project.piName || '',
    title: project.title || '',
    active: project.active
  }
  showEditModal.value = true
}

async function handleSave() {
  if (!editingCode.value) return
  saving.value = true
  try {
    await projectsStore.updateProject(editingCode.value, {
      piName: editForm.value.piName || null,
      title: editForm.value.title || null,
      active: editForm.value.active
    })
    notificationStore.success('Project updated')
    showEditModal.value = false
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to update project')
  } finally {
    saving.value = false
  }
}

async function handleDelete(project) {
  if (!confirm(`Delete project "${project.code}"? This only removes the reference entry.`)) return
  try {
    await projectsStore.deleteProject(project.code)
    notificationStore.success('Project deleted')
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to delete project')
  }
}
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="flex items-center justify-between mb-2 flex-shrink-0">
      <h1 class="text-2xl font-bold text-gray-900">Projects</h1>
      <button class="btn-primary" @click="openCreateModal">Create Project</button>
    </div>
    <p class="text-sm text-gray-500 mb-6 flex-shrink-0">
      A project is a 2-letter grant code (the manuscript-ID prefix). It labels submissions and powers the
      dashboard's project filter. It does not affect who can see a submission — teams do.
    </p>

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
              <SearchInput v-model="search" full-width placeholder="Search projects…" />
            </th>
          </tr>
          <tr>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Code</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Principal Investigator</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Title</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
            <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
          </tr>
        </thead>
        <tbody class="bg-white divide-y divide-gray-200">
          <tr v-for="project in filteredProjects" :key="project.code" :class="{ 'bg-gray-50 opacity-60': !project.active }">
            <td class="px-6 py-4 whitespace-nowrap">
              <div class="font-mono font-medium text-gray-900">{{ project.code }}</div>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-gray-700">{{ project.piName || '-' }}</td>
            <td class="px-6 py-4 text-gray-500 max-w-md truncate" :title="project.title">{{ project.title || '-' }}</td>
            <td class="px-6 py-4 whitespace-nowrap">
              <span :class="project.active ? 'badge-success' : 'badge-gray'">
                {{ project.active ? 'Active' : 'Inactive' }}
              </span>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-right">
              <button class="text-primary-600 hover:text-primary-800 mr-3" @click="openEditModal(project)">Edit</button>
              <button class="text-red-600 hover:text-red-800" @click="handleDelete(project)">Delete</button>
            </td>
          </tr>
          <tr v-if="filteredProjects.length === 0">
            <td colspan="5" class="px-6 py-8 text-center text-gray-500">
              {{ search ? 'No projects match your search.' : 'No projects found. Create one to get started.' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Create Modal -->
    <div v-if="showCreateModal" class="fixed inset-0 z-50 overflow-y-auto">
      <div class="flex items-center justify-center min-h-screen px-4">
        <div class="fixed inset-0 bg-black bg-opacity-50" @click="showCreateModal = false"></div>
        <div class="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
          <h2 class="text-lg font-medium text-gray-900 mb-4">Create Project</h2>
          <form class="space-y-4" @submit.prevent="handleCreate">
            <div>
              <label class="label">Code</label>
              <input v-model="createForm.code" type="text" class="input uppercase" required maxlength="2" placeholder="e.g., WH" />
              <p class="mt-1 text-xs text-gray-500">Exactly 2 letters/digits — the manuscript-ID prefix</p>
            </div>
            <div>
              <label class="label">Principal Investigator</label>
              <input v-model="createForm.piName" type="text" class="input" maxlength="255" placeholder="e.g., J. Wade Harper" />
            </div>
            <div>
              <label class="label">Title (optional)</label>
              <textarea v-model="createForm.title" rows="3" class="input" maxlength="2000" placeholder="Grant title"></textarea>
            </div>
            <div class="flex justify-end space-x-3 pt-4">
              <button type="button" class="btn-secondary" @click="showCreateModal = false">Cancel</button>
              <button type="submit" :disabled="saving || !createForm.code" class="btn-primary">
                {{ saving ? 'Creating...' : 'Create' }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>

    <!-- Edit Modal -->
    <div v-if="showEditModal" class="fixed inset-0 z-50 overflow-y-auto">
      <div class="flex items-center justify-center min-h-screen px-4">
        <div class="fixed inset-0 bg-black bg-opacity-50" @click="showEditModal = false"></div>
        <div class="relative bg-white rounded-lg shadow-xl max-w-md w-full p-6">
          <h2 class="text-lg font-medium text-gray-900 mb-4">Edit Project {{ editingCode }}</h2>
          <form class="space-y-4" @submit.prevent="handleSave">
            <div>
              <label class="label">Principal Investigator</label>
              <input v-model="editForm.piName" type="text" class="input" maxlength="255" placeholder="e.g., J. Wade Harper" />
            </div>
            <div>
              <label class="label">Title (optional)</label>
              <textarea v-model="editForm.title" rows="3" class="input" maxlength="2000" placeholder="Grant title"></textarea>
            </div>
            <div>
              <label class="flex items-center">
                <input v-model="editForm.active" type="checkbox" class="h-4 w-4 text-primary-600 border-gray-300 rounded focus:ring-primary-500" />
                <span class="ml-2 text-sm text-gray-700">Active</span>
              </label>
              <p class="mt-1 text-xs text-gray-500">Inactive projects won't appear in selection lists</p>
            </div>
            <div class="flex justify-end space-x-3 pt-4">
              <button type="button" class="btn-secondary" @click="showEditModal = false">Cancel</button>
              <button type="submit" :disabled="saving" class="btn-primary">{{ saving ? 'Saving...' : 'Save' }}</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  </div>
</template>
