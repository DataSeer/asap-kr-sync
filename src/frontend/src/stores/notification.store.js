import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useNotificationStore = defineStore('notification', () => {
  // State
  const notifications = ref([])
  let nextId = 1

  // Actions
  function show(message, type = 'info', duration = 5000) {
    const id = nextId++
    const notification = {
      id,
      message,
      type, // 'success', 'error', 'warning', 'info'
      visible: true
    }

    notifications.value.push(notification)

    if (duration > 0) {
      setTimeout(() => {
        remove(id)
      }, duration)
    }

    return id
  }

  function success(message, duration = 5000) {
    return show(message, 'success', duration)
  }

  function error(message, duration = 0) {
    return show(message, 'error', duration)
  }

  function warning(message, duration = 5000) {
    return show(message, 'warning', duration)
  }

  function info(message, duration = 5000) {
    return show(message, 'info', duration)
  }

  function remove(id) {
    const index = notifications.value.findIndex(n => n.id === id)
    if (index !== -1) {
      notifications.value.splice(index, 1)
    }
  }

  function clear() {
    notifications.value = []
  }

  return {
    notifications,
    show,
    success,
    error,
    warning,
    info,
    remove,
    clear
  }
})
