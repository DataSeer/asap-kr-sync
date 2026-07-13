import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import teamsService from '@/services/teams.service'

export const useTeamsStore = defineStore('teams', () => {
  // State
  const teams = ref([])
  const teamCodes = ref([])
  const emailMappings = ref([])
  const emailMappingsPagination = ref({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0
  })
  const pagination = ref({
    page: 1,
    limit: 50,
    total: 0,
    totalPages: 0
  })
  const loading = ref(false)
  const error = ref(null)

  // Getters
  const activeTeams = computed(() =>
    teams.value.filter(t => t.active)
  )

  const teamByCode = computed(() => (code) =>
    teams.value.find(t => t.code === code)
  )

  // Actions
  async function fetchTeams(params = {}) {
    loading.value = true
    error.value = null

    try {
      const response = await teamsService.list(params)
      teams.value = response.teams
      pagination.value = response.pagination
      return response
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to fetch teams'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function fetchTeamCodes() {
    try {
      const response = await teamsService.getCodes()
      teamCodes.value = response.codes
      return response.codes
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to fetch team codes'
      throw err
    }
  }

  async function createTeam(data) {
    loading.value = true
    error.value = null

    try {
      const response = await teamsService.create(data)
      teams.value.push(response.team)
      // Sort by code
      teams.value.sort((a, b) => a.code.localeCompare(b.code))
      // Update codes list
      if (response.team.active) {
        teamCodes.value.push(response.team.code)
        teamCodes.value.sort()
      }
      return response.team
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to create team'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function updateTeam(id, data) {
    loading.value = true
    error.value = null

    try {
      const response = await teamsService.update(id, data)

      // Update in list
      const index = teams.value.findIndex(t => t.id === id)
      if (index !== -1) {
        const oldCode = teams.value[index].code
        teams.value[index] = response.team

        // Update codes list if code changed or active status changed
        const codeIndex = teamCodes.value.indexOf(oldCode)
        if (codeIndex !== -1) {
          teamCodes.value.splice(codeIndex, 1)
        }
        if (response.team.active) {
          teamCodes.value.push(response.team.code)
          teamCodes.value.sort()
        }
      }

      // Re-sort teams by code
      teams.value.sort((a, b) => a.code.localeCompare(b.code))

      return response.team
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to update team'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function deleteTeam(id) {
    loading.value = true
    error.value = null

    try {
      const team = teams.value.find(t => t.id === id)
      await teamsService.delete(id)

      // Remove from list
      const index = teams.value.findIndex(t => t.id === id)
      if (index !== -1) {
        teams.value.splice(index, 1)
      }

      // Remove from codes list
      if (team) {
        const codeIndex = teamCodes.value.indexOf(team.code)
        if (codeIndex !== -1) {
          teamCodes.value.splice(codeIndex, 1)
        }
      }
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to delete team'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function fetchEmailMappings(params = {}) {
    try {
      const response = await teamsService.listEmailMappings(params)
      emailMappings.value = response.mappings
      emailMappingsPagination.value = response.pagination
      return response
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to fetch email mappings'
      throw err
    }
  }

  async function createEmailMappings(mappings) {
    try {
      return await teamsService.createEmailMappings(mappings)
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to import email mappings'
      throw err
    }
  }

  async function deleteEmailMapping(id) {
    try {
      await teamsService.deleteEmailMapping(id)
      const index = emailMappings.value.findIndex(m => m.id === id)
      if (index !== -1) {
        emailMappings.value.splice(index, 1)
      }
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to delete email mapping'
      throw err
    }
  }

  async function exportEmailMappings() {
    try {
      return await teamsService.exportEmailMappings()
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to export email mappings'
      throw err
    }
  }

  return {
    // State
    teams,
    teamCodes,
    emailMappings,
    emailMappingsPagination,
    pagination,
    loading,
    error,
    // Getters
    activeTeams,
    teamByCode,
    // Actions
    fetchTeams,
    fetchTeamCodes,
    createTeam,
    updateTeam,
    deleteTeam,
    fetchEmailMappings,
    createEmailMappings,
    deleteEmailMapping,
    exportEmailMappings
  }
})
