/**
 * Composable for confirmation dialogs before executing actions
 * Uses browser's native confirm() for simplicity
 * @returns {Object} - { confirm, confirmDelete }
 */
export function useConfirmation() {
  /**
   * Show a confirmation dialog and execute action if confirmed
   * @param {string} message - Confirmation message
   * @param {Function} action - Action to execute if confirmed
   * @returns {Promise<boolean>} - Whether the action was executed
   */
  async function confirmAction(message, action) {
    if (!window.confirm(message)) {
      return false
    }

    await action()
    return true
  }

  /**
   * Confirm deletion of an item
   * @param {string} itemName - Name of the item to delete
   * @param {Function} action - Delete action to execute
   * @returns {Promise<boolean>} - Whether the action was executed
   */
  async function confirmDelete(itemName, action) {
    return confirmAction(
      `Are you sure you want to delete "${itemName}"? This action cannot be undone.`,
      action
    )
  }

  return {
    confirm: confirmAction,
    confirmDelete
  }
}
