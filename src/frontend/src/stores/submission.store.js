import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import submissionService from '@/services/submission.service'

export const useSubmissionStore = defineStore('submission', () => {
  // State
  const submissions = ref([])
  const hiddenSubmissions = ref([])
  const currentSubmission = ref(null)
  const latestFiles = ref({}) // { krt: File, pdf: File, report: File }
  const pagination = ref({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0
  })
  const loading = ref(false)
  const error = ref(null)

  // Getters
  const submissionById = computed(() => (id) =>
    submissions.value.find(s => s.id === id)
  )

  const submissionsByStatus = computed(() => (status) =>
    submissions.value.filter(s => s.status === status)
  )

  const submissionsByProject = computed(() => (project) =>
    submissions.value.filter(s => s.project === project)
  )

  // Actions
  async function fetchSubmissions(params = {}) {
    loading.value = true
    error.value = null

    try {
      const response = await submissionService.list(params)
      submissions.value = response.submissions
      pagination.value = response.pagination
      return response
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to fetch submissions'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function fetchSubmission(id) {
    loading.value = true
    error.value = null

    try {
      const response = await submissionService.getById(id)
      currentSubmission.value = response.submission
      latestFiles.value = response.latestFiles || {}

      // Update in list if exists
      const index = submissions.value.findIndex(s => s.id === id)
      if (index !== -1) {
        submissions.value[index] = response.submission
      }

      return response.submission
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to fetch submission'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function createSubmission(data, krtFile) {
    loading.value = true
    error.value = null

    try {
      const response = await submissionService.create(data, krtFile)
      submissions.value.unshift(response.submission)
      currentSubmission.value = response.submission
      return response.submission
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to create submission'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function updateSubmission(id, data) {
    loading.value = true
    error.value = null

    try {
      const response = await submissionService.update(id, data)

      // Update current submission
      if (currentSubmission.value?.id === id) {
        currentSubmission.value = response.submission
      }

      // Update in list
      const index = submissions.value.findIndex(s => s.id === id)
      if (index !== -1) {
        submissions.value[index] = response.submission
      }

      return response.submission
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to update submission'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function reassignOwner(id, userId) {
    loading.value = true
    error.value = null

    try {
      const response = await submissionService.reassignOwner(id, userId)
      const updated = { ...response.submission, user: response.user }

      if (currentSubmission.value?.id === id) {
        currentSubmission.value = updated
      }
      const index = submissions.value.findIndex(s => s.id === id)
      if (index !== -1) {
        submissions.value[index] = updated
      }

      return updated
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to reassign owner'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function deleteSubmission(id) {
    loading.value = true
    error.value = null

    try {
      await submissionService.delete(id)

      // Remove from list
      const index = submissions.value.findIndex(s => s.id === id)
      if (index !== -1) {
        submissions.value.splice(index, 1)
      }

      // Clear current if it was deleted
      if (currentSubmission.value?.id === id) {
        currentSubmission.value = null
      }
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to delete submission'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function processNewVersion(id, data) {
    loading.value = true
    error.value = null

    try {
      const response = await submissionService.processNewVersion(id, data)

      // Update current submission
      if (currentSubmission.value?.id === id) {
        currentSubmission.value = response.submission
      }

      // Update in list
      const index = submissions.value.findIndex(s => s.id === id)
      if (index !== -1) {
        submissions.value[index] = response.submission
      }

      return response.submission
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to process new version'
      throw err
    } finally {
      loading.value = false
    }
  }

  function clearCurrent() {
    currentSubmission.value = null
    latestFiles.value = {}
  }

  async function hideSubmission(id) {
    try {
      await submissionService.hide(id)

      // Remove from submissions list
      const index = submissions.value.findIndex(s => s.id === id)
      if (index !== -1) {
        const [hidden] = submissions.value.splice(index, 1)
        hiddenSubmissions.value.push(hidden)
      }

      // Clear current if it was hidden
      if (currentSubmission.value?.id === id) {
        currentSubmission.value = null
      }
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to hide submission'
      throw err
    }
  }

  async function unhideSubmission(id) {
    try {
      await submissionService.unhide(id)

      // Remove from hidden list
      const index = hiddenSubmissions.value.findIndex(s => s.id === id)
      if (index !== -1) {
        const [unhidden] = hiddenSubmissions.value.splice(index, 1)
        submissions.value.unshift(unhidden)
      }
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to unhide submission'
      throw err
    }
  }

  async function fetchHiddenSubmissions(params = {}) {
    loading.value = true
    error.value = null

    try {
      const response = await submissionService.listHidden(params)
      hiddenSubmissions.value = response.submissions
      return response
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to fetch hidden submissions'
      throw err
    } finally {
      loading.value = false
    }
  }

  return {
    // State
    submissions,
    hiddenSubmissions,
    currentSubmission,
    latestFiles,
    pagination,
    loading,
    error,
    // Getters
    submissionById,
    submissionsByStatus,
    submissionsByProject,
    // Actions
    fetchSubmissions,
    fetchSubmission,
    createSubmission,
    updateSubmission,
    reassignOwner,
    deleteSubmission,
    hideSubmission,
    unhideSubmission,
    fetchHiddenSubmissions,
    processNewVersion,
    clearCurrent
  }
})
