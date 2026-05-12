import { ref } from 'vue'

/**
 * Composable for managing multi-select arrays (toggle items in a list)
 * @param {Array} initial - Initial array of selected values
 * @returns {Object} - { selected, toggle, clear, isSelected }
 */
export function useToggleSelection(initial = []) {
  const selected = ref([...initial])

  function toggle(value) {
    const idx = selected.value.indexOf(value)
    if (idx === -1) {
      selected.value.push(value)
    } else {
      selected.value.splice(idx, 1)
    }
  }

  function clear() {
    selected.value = []
  }

  function isSelected(value) {
    return selected.value.includes(value)
  }

  function set(values) {
    selected.value = [...values]
  }

  return {
    selected,
    toggle,
    clear,
    isSelected,
    set
  }
}
