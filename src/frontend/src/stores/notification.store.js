import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useNotificationStore = defineStore('notification', () => {
  // State
  const notifications = ref([])
  let nextId = 1

  // How many toasts may stack. They sit over the bottom-right corner, where
  // the Continue / Download buttons live: an unbounded pile of stale errors
  // hid exactly the buttons users were trying to reach (ASAP feedback,
  // 2026-09). Oldest goes first when the cap is hit.
  const MAX_VISIBLE = 3

  // Errors used to be sticky (duration 0) and outlived even a logout. They
  // now fade like the others, only slower — long enough to read, not long
  // enough to become furniture. Pass duration 0 explicitly for the rare
  // failure that must stay until dismissed.
  const ERROR_DURATION = 8000

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
    while (notifications.value.length > MAX_VISIBLE) {
      notifications.value.shift()
    }

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

  function error(message, duration = ERROR_DURATION) {
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
