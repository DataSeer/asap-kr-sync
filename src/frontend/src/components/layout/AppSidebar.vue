<script setup>
import { ref, computed, onMounted } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth.store'
import api from '@/services/api'

const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()

// KRT Template URL
const krtTemplateUrl = ref('')

// Sidebar collapsed state - persisted in localStorage
const isCollapsed = ref(false)

onMounted(async () => {
  const saved = localStorage.getItem('sidebar-collapsed')
  if (saved !== null) {
    isCollapsed.value = saved === 'true'
  }

  try {
    const response = await api.get('/config/krt-template')
    krtTemplateUrl.value = response.data.url
  } catch (e) {
    // Template URL is optional
  }
})

async function handleLogout() {
  await authStore.logout()
  router.push({ name: 'login' })
}

function toggleSidebar() {
  isCollapsed.value = !isCollapsed.value
  localStorage.setItem('sidebar-collapsed', isCollapsed.value.toString())
}

const canCreate = computed(() => authStore.canCreateSubmission)
const canViewUsers = computed(() => authStore.canViewUsers)
const canManageTeams = computed(() => authStore.canManageTeams)
const canManageTeamEmails = computed(() => authStore.canManageTeamEmails)
const canManageResourceTypes = computed(() => authStore.canManageResourceTypes)
const canManageConfig = computed(() => authStore.canManageValidationRules)

const isActive = (path) => route.path.startsWith(path)
</script>

<template>
  <aside :class="['sidebar', { collapsed: isCollapsed }]">
    <!-- Toggle Button — stays outside .sidebar-scroll so it's never clipped
         when the nav overflows. Positioned absolute against .sidebar. -->
    <button
      class="toggle-btn"
      :title="isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'"
      @click="toggleSidebar"
    >
      <svg
        :class="['toggle-icon', { rotated: isCollapsed }]"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
      </svg>
    </button>

    <!-- Scroll container — owns overflow-y:auto so the toggle button (which
         sticks out at right: -0.75rem) isn't clipped by the X-axis side-effect
         of overflow-y. -->
    <div class="sidebar-scroll">
      <nav class="nav">
        <RouterLink
          to="/dashboard"
          class="nav-item"
          :class="{ active: isActive('/dashboard') }"
          :title="isCollapsed ? 'Dashboard' : ''"
        >
          <svg class="nav-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
          </svg>
          <span class="nav-label">Dashboard</span>
        </RouterLink>

        <RouterLink
          v-if="canCreate"
          to="/submissions/create"
          class="nav-item"
          :class="{ active: isActive('/submissions/create') }"
          :title="isCollapsed ? 'New Submission' : ''"
        >
          <svg class="nav-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
          </svg>
          <span class="nav-label">New Submission</span>
        </RouterLink>

        <RouterLink
          v-if="canCreate"
          to="/tools/validate-krt"
          class="nav-item"
          :class="{ active: isActive('/tools/validate-krt') }"
          :title="isCollapsed ? 'Validate a KRT' : ''"
        >
          <svg class="nav-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span class="nav-label">Validate a KRT</span>
        </RouterLink>

        <div v-if="canViewUsers" class="nav-section">
          <p v-if="!isCollapsed" class="nav-section-title">
            Management
          </p>
          <div v-else class="nav-section-divider"></div>

          <RouterLink
            to="/admin/users"
            class="nav-item"
            :class="{ active: isActive('/admin/users') }"
            :title="isCollapsed ? 'Users' : ''"
          >
            <svg class="nav-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
            <span class="nav-label">Users</span>
          </RouterLink>

          <RouterLink
            v-if="canManageTeams"
            to="/admin/teams"
            class="nav-item"
            :class="{ active: isActive('/admin/teams') }"
            :title="isCollapsed ? 'Teams' : ''"
          >
            <svg class="nav-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            <span class="nav-label">Teams</span>
          </RouterLink>

          <RouterLink
            v-if="canManageTeams"
            to="/admin/projects"
            class="nav-item"
            :class="{ active: isActive('/admin/projects') }"
            :title="isCollapsed ? 'Projects' : ''"
          >
            <svg class="nav-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            <span class="nav-label">Projects</span>
          </RouterLink>

          <RouterLink
            v-if="canManageTeamEmails"
            to="/admin/team-emails"
            class="nav-item"
            :class="{ active: isActive('/admin/team-emails') }"
            :title="isCollapsed ? 'Team Email Assignment' : ''"
          >
            <svg class="nav-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            <span class="nav-label">Team Emails</span>
          </RouterLink>
        </div>

        <!-- KRT Editor Section -->
        <div v-if="canManageResourceTypes" class="nav-section">
          <p v-if="!isCollapsed" class="nav-section-title">
            Key Resources Table Editor
          </p>
          <div v-else class="nav-section-divider"></div>

          <RouterLink
            to="/admin/krt-editor/resource-types"
            class="nav-item"
            :class="{ active: isActive('/admin/krt-editor/resource-types') }"
            :title="isCollapsed ? 'Resource Types' : ''"
          >
            <svg class="nav-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            <span class="nav-label">Resource Types</span>
          </RouterLink>

          <RouterLink
            v-if="canManageConfig"
            to="/admin/krt-editor/validation-rules"
            class="nav-item"
            :class="{ active: isActive('/admin/krt-editor/validation-rules') }"
            :title="isCollapsed ? 'Validation Rules' : ''"
          >
            <svg class="nav-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span class="nav-label">Validation Rules</span>
          </RouterLink>
        </div>

        <!-- Enrichments Section -->
        <div v-if="canManageResourceTypes" class="nav-section">
          <RouterLink
            to="/admin/enrichments"
            class="nav-item"
            :class="{ active: isActive('/admin/enrichments') }"
            :title="isCollapsed ? 'Enrichments' : ''"
          >
            <svg class="nav-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            <span class="nav-label">Enrichments</span>
          </RouterLink>
        </div>

        <!-- Resources Section -->
        <div v-if="krtTemplateUrl" class="nav-section">
          <p v-if="!isCollapsed" class="nav-section-title">
            Resources
          </p>
          <div v-else class="nav-section-divider"></div>

          <a
            :href="krtTemplateUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="nav-item"
            :title="isCollapsed ? 'Key Resources Table Template' : ''"
          >
            <svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-1.99 6H13V7h4.01v2zm0 4H13v-2h4.01v2zm0 4H13v-2h4.01v2zM7 7h4v2H7V7zm0 4h4v2H7v-2zm0 4h4v2H7v-2z" />
            </svg>
            <span class="nav-label">Key Resources Table Template</span>
          </a>
        </div>

        <!-- Account Section -->
        <div class="nav-section">
          <p v-if="!isCollapsed" class="nav-section-title">
            Account
          </p>
          <div v-else class="nav-section-divider"></div>

          <RouterLink
            to="/profile"
            class="nav-item"
            :class="{ active: isActive('/profile') }"
            :title="isCollapsed ? 'My Profile' : ''"
          >
            <svg class="nav-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
            <span class="nav-label">My Profile</span>
          </RouterLink>

          <button
            class="nav-item nav-item-btn"
            :title="isCollapsed ? 'Logout' : ''"
            @click="handleLogout"
          >
            <svg class="nav-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            <span class="nav-label">Logout</span>
          </button>
        </div>
      </nav>
    </div><!-- /.sidebar-scroll -->
  </aside>
</template>

<style scoped>
.sidebar {
  width: 16rem;
  height: 100%;
  background: #fff;
  border-right: 1px solid #e5e7eb;
  transition: width 0.2s ease;
  position: relative;
  flex-shrink: 0;
  /* No overflow on the outer aside — that would clip the toggle button which
     sticks out at right: -0.75rem. Scroll happens on .sidebar-scroll inside. */
}

/* Inner scroll container — overflow lives here so the absolutely-positioned
   toggle button (a sibling, not a child) is unaffected. */
.sidebar-scroll {
  height: 100%;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}

/* Show the scrollbar ONLY when the sidebar is expanded AND the mouse is over it.
   When collapsed (icon-only), the scrollbar would just be visual noise. */
.sidebar:not(.collapsed):hover .sidebar-scroll {
  scrollbar-color: rgba(0, 0, 0, 0.2) transparent;
}
.sidebar-scroll::-webkit-scrollbar {
  width: 6px;
}
.sidebar-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.sidebar-scroll::-webkit-scrollbar-thumb {
  background: transparent;
  border-radius: 3px;
}
.sidebar:not(.collapsed):hover .sidebar-scroll::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.2);
}

.sidebar.collapsed {
  width: 4rem;
}

/* Toggle Button — z:50 keeps it above content-area stacking contexts
   (JobStatusPanel z:30, sticky sub-header z:40); modals teleport to body
   and sit above this. */
.toggle-btn {
  position: absolute;
  top: 0.75rem;
  right: -0.75rem;
  width: 1.5rem;
  height: 1.5rem;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 50;
  transition: background 0.15s;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}

.toggle-btn:hover {
  background: #f3f4f6;
}

.toggle-icon {
  width: 0.875rem;
  height: 0.875rem;
  color: #6b7280;
  transition: transform 0.2s ease;
}

.toggle-icon.rotated {
  transform: rotate(180deg);
}

/* Navigation */
.nav {
  padding: 1rem 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.nav-item {
  display: flex;
  align-items: center;
  padding: 0.5rem 0.75rem;
  border-radius: 0.375rem;
  color: #4b5563;
  text-decoration: none;
  transition: all 0.15s;
  white-space: nowrap;
  overflow: hidden;
}

.nav-item:hover {
  background: #f3f4f6;
}

.nav-item.active {
  background: #eff6ff;
  color: #1d4ed8;
}

.nav-icon {
  width: 1.25rem;
  height: 1.25rem;
  flex-shrink: 0;
}

.nav-label {
  margin-left: 0.75rem;
  font-size: 0.875rem;
  font-weight: 500;
  transition: opacity 0.2s ease;
}

.sidebar.collapsed .nav-label {
  opacity: 0;
  width: 0;
  margin-left: 0;
}

.sidebar.collapsed .nav-item {
  justify-content: center;
  padding: 0.625rem;
}

/* Section */
.nav-section {
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid #e5e7eb;
}

.nav-section-title {
  padding: 0 0.75rem;
  margin-bottom: 0.5rem;
  font-size: 0.675rem;
  font-weight: 600;
  color: #9ca3af;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.nav-section-divider {
  height: 0;
}

/* Button styled as nav item */
.nav-item-btn {
  width: 100%;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font-size: 0.875rem;
  font-weight: 500;
}
</style>
