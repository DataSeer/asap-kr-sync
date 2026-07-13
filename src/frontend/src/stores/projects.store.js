import { defineStore } from 'pinia'
import { ref } from 'vue'
import projectsService from '@/services/projects.service'

export const useProjectsStore = defineStore('projects', () => {
  const projects = ref([])
  const pagination = ref({ page: 1, limit: 100, total: 0, totalPages: 0 })
  const loading = ref(false)
  const error = ref(null)

  async function fetchProjects(params = {}) {
    loading.value = true
    error.value = null
    try {
      const response = await projectsService.list(params)
      projects.value = response.projects
      pagination.value = response.pagination
      return response
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to fetch projects'
      throw err
    } finally {
      loading.value = false
    }
  }

  async function createProject(data) {
    try {
      const response = await projectsService.create(data)
      projects.value.push(response.project)
      projects.value.sort((a, b) => a.code.localeCompare(b.code))
      return response.project
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to create project'
      throw err
    }
  }

  async function updateProject(code, data) {
    try {
      const response = await projectsService.update(code, data)
      const index = projects.value.findIndex(p => p.code === code)
      if (index !== -1) projects.value[index] = response.project
      return response.project
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to update project'
      throw err
    }
  }

  async function deleteProject(code) {
    try {
      await projectsService.delete(code)
      const index = projects.value.findIndex(p => p.code === code)
      if (index !== -1) projects.value.splice(index, 1)
    } catch (err) {
      error.value = err.response?.data?.error || 'Failed to delete project'
      throw err
    }
  }

  return {
    projects,
    pagination,
    loading,
    error,
    fetchProjects,
    createProject,
    updateProject,
    deleteProject
  }
})
