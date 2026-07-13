<script setup>
/**
 * TeamEmailsView — manage the (team, email) roster that drives automatic team
 * assignment. Available to admin, ds_annotator and asap_pm. Users whose email
 * is listed here are granted the mapped team(s) on their next sign-in.
 *
 * Initial data can be loaded from the ASAP roster CSV: pick the file and the
 * Team/Email columns are extracted into the import box for review.
 */
import { ref, computed, watch, onMounted } from 'vue'
import { useTeamsStore } from '@/stores/teams.store'
import { useNotificationStore } from '@/stores/notification.store'
import SearchInput from '@/components/common/SearchInput.vue'

const teamsStore = useTeamsStore()
const notificationStore = useNotificationStore()

const loading = ref(true)
const showImportModal = ref(false)
const importText = ref('')
const importing = ref(false)
const search = ref('')

// Single-mapping add form. The email does NOT need an existing account —
// the mapping is stored and applied when that person registers or next signs in.
const newMapping = ref({ team: '', email: '' })
const addingSingle = ref(false)
const exporting = ref(false)

// The roster can exceed the 100-row page cap, so search is server-side.
async function reload() {
  await teamsStore.fetchEmailMappings({ limit: 100, search: search.value.trim() || undefined })
}

onMounted(async () => {
  loading.value = true
  try {
    await Promise.all([reload(), teamsStore.fetchTeamCodes()])
  } catch (error) {
    notificationStore.error('Failed to load email mappings')
  } finally {
    loading.value = false
  }
})

let searchDebounce = null
watch(search, () => {
  clearTimeout(searchDebounce)
  searchDebounce = setTimeout(reload, 300)
})

async function handleAddSingle() {
  const team = newMapping.value.team
  const email = newMapping.value.email.trim().toLowerCase()
  if (!team || !email) return
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    notificationStore.error('Enter a valid email address')
    return
  }

  addingSingle.value = true
  try {
    const result = await teamsStore.createEmailMappings([{ team, email }])
    if (result.created === 0) {
      notificationStore.info('That mapping already exists')
    } else if (result.appliedToExistingUsers > 0) {
      notificationStore.success(`Added — ${email} already has an account and was assigned to ${team} now`)
    } else {
      notificationStore.success(`Added — ${email} will be assigned to ${team} when they sign in`)
    }
    newMapping.value = { team: '', email: '' }
    await reload()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to add mapping')
  } finally {
    addingSingle.value = false
  }
}

function formatDate(date) {
  return new Date(date).toLocaleDateString()
}

/**
 * Split a single CSV line, honouring double-quoted fields (which may contain
 * commas). Good enough for the ASAP roster export.
 */
function splitCsvLine(line) {
  const out = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = !inQuotes }
    } else if (ch === ',' && !inQuotes) {
      out.push(cur); cur = ''
    } else {
      cur += ch
    }
  }
  out.push(cur)
  return out.map(s => s.trim())
}

/**
 * Read a roster CSV and fill the import box with TEAM,EMAIL lines. Locates the
 * Team and Email columns by header name; falls back to the first two columns.
 */
function handleCsvFile(event) {
  const file = event.target.files?.[0]
  if (!file) return
  const reader = new FileReader()
  reader.onload = () => {
    const lines = String(reader.result).split(/\r?\n/).filter(l => l.trim())
    if (lines.length === 0) {
      notificationStore.error('The CSV file is empty')
      return
    }
    const header = splitCsvLine(lines[0]).map(h => h.toLowerCase())
    let teamIdx = header.findIndex(h => h === 'team' || h === 'team code')
    let emailIdx = header.findIndex(h => h.includes('email'))
    let dataStart = 1
    if (teamIdx === -1 || emailIdx === -1) {
      // No recognizable header — assume "TEAM,EMAIL" with no header row.
      teamIdx = 0
      emailIdx = 1
      dataStart = 0
    }

    const pairs = []
    for (const line of lines.slice(dataStart)) {
      const cols = splitCsvLine(line)
      const team = (cols[teamIdx] || '').trim()
      const email = (cols[emailIdx] || '').trim()
      if (team && email && email.includes('@')) {
        pairs.push(`${team},${email}`)
      }
    }

    if (pairs.length === 0) {
      notificationStore.error('No TEAM,EMAIL rows found in the CSV')
      return
    }
    importText.value = pairs.join('\n')
    showImportModal.value = true
    notificationStore.success(`Loaded ${pairs.length} row(s) from ${file.name} — review then import`)
  }
  reader.onerror = () => notificationStore.error('Failed to read the CSV file')
  reader.readAsText(file)
  event.target.value = '' // allow re-selecting the same file
}

/**
 * Parse the import box into mappings. One "TEAM,EMAIL" per line (comma,
 * semicolon or tab separated, "EMAIL,TEAM" order tolerated); blank lines,
 * "#" comments and a header line are skipped.
 */
const parsedImport = computed(() => {
  const mappings = []
  const invalid = []
  const seen = new Set()

  for (const rawLine of importText.value.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const parts = line.split(/[,;\t]/).map(p => p.trim()).filter(Boolean)
    const looksLikeHeader = parts.length === 2 &&
      ((/team/i.test(parts[0]) && /e-?mail/i.test(parts[1])) ||
       (/e-?mail/i.test(parts[0]) && /team/i.test(parts[1])))
    if (looksLikeHeader) continue

    let [team, email] = parts
    if (parts.length === 2 && team.includes('@') && !email.includes('@')) {
      [team, email] = [email, team]
    }

    if (parts.length !== 2 || !email.includes('@')) {
      invalid.push(line)
      continue
    }

    // Team is a name (e.g. "Reck-Peterson") — keep its case as entered.
    email = email.toLowerCase()
    const key = `${team}|${email}`
    if (seen.has(key)) continue
    seen.add(key)
    mappings.push({ team, email })
  }

  return { mappings, invalid }
})

async function handleImportMappings() {
  const { mappings, invalid } = parsedImport.value
  if (invalid.length > 0) {
    notificationStore.error(`${invalid.length} line(s) are not valid TEAM,EMAIL pairs — fix or remove them first`)
    return
  }
  if (mappings.length === 0) return

  importing.value = true
  try {
    const result = await teamsStore.createEmailMappings(mappings)
    notificationStore.success(
      `${result.created} mapping(s) added (${result.skipped} already existed, ` +
      `${result.appliedToExistingUsers} applied to existing users)`
    )
    showImportModal.value = false
    importText.value = ''
    await reload()
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to import email mappings')
  } finally {
    importing.value = false
  }
}

async function handleExport() {
  exporting.value = true
  try {
    const csv = await teamsStore.exportEmailMappings()
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'team-emails.csv'
    a.click()
    URL.revokeObjectURL(url)
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to export roster')
  } finally {
    exporting.value = false
  }
}

async function handleDeleteMapping(mapping) {
  if (!confirm(`Remove mapping ${mapping.team} ← ${mapping.email}? Teams already assigned to the user are kept.`)) {
    return
  }
  try {
    await teamsStore.deleteEmailMapping(mapping.id)
    notificationStore.success('Email mapping deleted')
  } catch (error) {
    notificationStore.error(error.response?.data?.error || 'Failed to delete email mapping')
  }
}
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="flex-shrink-0">
    <div class="flex items-center justify-between mb-2">
      <h1 class="text-2xl font-bold text-gray-900">Team Email Assignment</h1>
      <div class="flex items-center space-x-3">
        <button class="btn-secondary" :disabled="exporting" @click="handleExport">
          {{ exporting ? 'Exporting…' : 'Export CSV' }}
        </button>
        <label class="btn-secondary cursor-pointer mb-0">
          Load CSV
          <input type="file" accept=".csv,text/csv" class="hidden" @change="handleCsvFile" />
        </label>
        <button class="btn-primary" @click="showImportModal = true">
          Add Mappings
        </button>
      </div>
    </div>
    <p class="text-sm text-gray-500 mb-6">
      Users whose email is listed here are assigned the mapped team(s) automatically when they sign in.
      This is how an ASAP PM gets their teams without having to upload a document first.
      The email does not need an existing account — the assignment applies as soon as that person registers.
    </p>

    <!-- Single add: email need not exist in the system yet -->
    <div class="card p-4 mb-4">
      <form class="flex flex-wrap items-end gap-3" @submit.prevent="handleAddSingle">
        <div>
          <label class="label">Team</label>
          <select v-model="newMapping.team" class="input" :disabled="addingSingle">
            <option value="" disabled>Select…</option>
            <option v-for="code in teamsStore.teamCodes" :key="code" :value="code">{{ code }}</option>
          </select>
        </div>
        <div class="flex-1 min-w-[16rem]">
          <label class="label">Email</label>
          <input
            v-model="newMapping.email"
            type="email"
            class="input"
            placeholder="future.user@example.org"
            :disabled="addingSingle"
          />
        </div>
        <button
          type="submit"
          class="btn-primary"
          :disabled="addingSingle || !newMapping.team || !newMapping.email"
        >
          {{ addingSingle ? 'Adding…' : 'Add' }}
        </button>
      </form>
    </div>

    <!-- Filters section: server-side search (the roster exceeds one page) -->
    <div class="mb-2">
      <SearchInput v-model="search" placeholder="Search team or email…" />
    </div>
    <p class="text-xs text-gray-400 mb-4">
      Showing {{ teamsStore.emailMappings.length }} of {{ teamsStore.emailMappingsPagination.total }} mapping(s).
      Type to search the whole roster.
    </p>
    </div><!-- /flex-shrink-0 header block -->

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
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Team</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Email</th>
            <th class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Added</th>
            <th class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
          </tr>
        </thead>
        <tbody class="bg-white divide-y divide-gray-200">
          <tr v-for="mapping in teamsStore.emailMappings" :key="mapping.id">
            <td class="px-6 py-4 whitespace-nowrap">
              <div class="font-medium text-gray-900">{{ mapping.team }}</div>
            </td>
            <td class="px-6 py-4 whitespace-nowrap text-gray-500">{{ mapping.email }}</td>
            <td class="px-6 py-4 whitespace-nowrap text-gray-500">{{ formatDate(mapping.created_at) }}</td>
            <td class="px-6 py-4 whitespace-nowrap text-right">
              <button class="text-red-600 hover:text-red-800" @click="handleDeleteMapping(mapping)">
                Delete
              </button>
            </td>
          </tr>
          <tr v-if="teamsStore.emailMappings.length === 0">
            <td colspan="4" class="px-6 py-8 text-center text-gray-500">
              {{ search ? 'No mappings match your search.' : 'No email mappings yet. Load your ASAP roster CSV or add mappings to assign teams automatically.' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Import Modal -->
    <div v-if="showImportModal" class="fixed inset-0 z-50 overflow-y-auto">
      <div class="flex items-center justify-center min-h-screen px-4">
        <div class="fixed inset-0 bg-black bg-opacity-50" @click="showImportModal = false"></div>

        <div class="relative bg-white rounded-lg shadow-xl max-w-lg w-full p-6">
          <h2 class="text-lg font-medium text-gray-900 mb-4">Add Email Mappings</h2>

          <form class="space-y-4" @submit.prevent="handleImportMappings">
            <div>
              <label class="label">Roster (one TEAM,EMAIL per line)</label>
              <textarea
                v-model="importText"
                class="input font-mono"
                rows="10"
                placeholder="Harper,jane.doe@example.org&#10;Harper,john.smith@example.org&#10;Alessi,jane.doe@example.org"
              ></textarea>
              <p class="mt-1 text-xs text-gray-500">
                Comma, semicolon or tab separated. Blank lines, a header line and lines starting with # are ignored.
                Mappings for users who already have an account are applied immediately; others apply at their next sign-in.
              </p>
            </div>

            <div class="text-sm">
              <span class="text-gray-700">{{ parsedImport.mappings.length }} mapping(s) ready</span>
              <span v-if="parsedImport.invalid.length > 0" class="text-red-600">
                — {{ parsedImport.invalid.length }} invalid line(s): {{ parsedImport.invalid.slice(0, 3).join(' | ') }}
              </span>
            </div>

            <div class="flex justify-end space-x-3 pt-4">
              <button type="button" class="btn-secondary" @click="showImportModal = false">
                Cancel
              </button>
              <button
                type="submit"
                :disabled="importing || parsedImport.mappings.length === 0 || parsedImport.invalid.length > 0"
                class="btn-primary"
              >
                {{ importing ? 'Importing...' : `Import ${parsedImport.mappings.length} mapping(s)` }}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  </div>
</template>
