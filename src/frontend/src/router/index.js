import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth.store'

// Lazy load views
const LoginView = () => import('@/views/auth/LoginView.vue')
const RegisterView = () => import('@/views/auth/RegisterView.vue')
const DashboardView = () => import('@/views/dashboard/DashboardView.vue')
const CreateSubmissionView = () => import('@/views/submissions/CreateSubmissionView.vue')
const ValidateKRTView = () => import('@/views/tools/ValidateKRTView.vue')
const SubmissionDetailView = () => import('@/views/submissions/SubmissionDetailView.vue')
const KRTView = () => import('@/views/submissions/KRTView.vue')
const PDFView = () => import('@/views/submissions/PDFView.vue')
const ReviewView = () => import('@/views/submissions/ReviewView.vue')
const AvailabilityView = () => import('@/views/submissions/AvailabilityView.vue')
const ReportView = () => import('@/views/submissions/ReportView.vue')
const UsersView = () => import('@/views/admin/UsersView.vue')
const TeamsView = () => import('@/views/admin/TeamsView.vue')
const TeamEmailsView = () => import('@/views/admin/TeamEmailsView.vue')
const ProjectsView = () => import('@/views/admin/ProjectsView.vue')
const ResourceTypesView = () => import('@/views/admin/ResourceTypesView.vue')
const AppConfigView = () => import('@/views/admin/AppConfigView.vue')
const EnrichmentListView = () => import('@/views/admin/EnrichmentListView.vue')
const ProfileView = () => import('@/views/profile/ProfileView.vue')
const AppLayout = () => import('@/components/layout/AppLayout.vue')

const routes = [
  {
    path: '/login',
    name: 'login',
    component: LoginView,
    meta: { requiresGuest: true, title: 'Login' }
  },
  {
    path: '/register',
    name: 'register',
    component: RegisterView,
    meta: { requiresGuest: true, title: 'Register' }
  },
  {
    path: '/',
    component: AppLayout,
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        redirect: '/dashboard'
      },
      {
        path: 'dashboard',
        name: 'dashboard',
        component: DashboardView,
        meta: { roles: ['author', 'asap_pm', 'ds_annotator', 'admin'], title: 'Dashboard' }
      },
      {
        path: 'submissions/create',
        name: 'create-submission',
        component: CreateSubmissionView,
        meta: { roles: ['author', 'asap_pm', 'ds_annotator', 'admin'], title: 'New Submission' }
      },
      {
        path: 'tools/validate-krt',
        name: 'validate-krt',
        component: ValidateKRTView,
        meta: { roles: ['author', 'asap_pm', 'ds_annotator', 'admin'], title: 'Validate a KRT' }
      },
      {
        path: 'submissions/:id',
        name: 'submission-detail',
        component: SubmissionDetailView,
        meta: { title: 'Submission', isSubmissionPage: true }
      },
      {
        path: 'submissions/:id/krt',
        name: 'submission-krt',
        component: KRTView,
        meta: { title: 'Step 1: Validate KRT', isSubmissionPage: true }
      },
      {
        path: 'submissions/:id/pdf',
        name: 'submission-pdf',
        component: PDFView,
        meta: { title: 'Step 2: Parse manuscript', isSubmissionPage: true }
      },
      {
        path: 'submissions/:id/review',
        name: 'submission-review',
        component: ReviewView,
        meta: { title: 'Step 3: Approve KRT', isSubmissionPage: true }
      },
      {
        path: 'submissions/:id/availability',
        name: 'submission-availability',
        component: AvailabilityView,
        meta: { title: 'Step 4: Edit manuscript', isSubmissionPage: true }
      },
      {
        path: 'submissions/:id/report',
        name: 'submission-report',
        component: ReportView,
        meta: { title: 'Step 5: Report', isSubmissionPage: true }
      },
      {
        path: 'admin/users',
        name: 'admin-users',
        component: UsersView,
        meta: { roles: ['admin', 'ds_annotator', 'asap_pm'], title: 'Users' }
      },
      {
        path: 'admin/teams',
        name: 'admin-teams',
        component: TeamsView,
        meta: { roles: ['admin', 'ds_annotator'], title: 'Teams' }
      },
      {
        path: 'admin/team-emails',
        name: 'admin-team-emails',
        component: TeamEmailsView,
        meta: { roles: ['admin', 'ds_annotator', 'asap_pm'], title: 'Team Email Assignment' }
      },
      {
        path: 'admin/projects',
        name: 'admin-projects',
        component: ProjectsView,
        meta: { roles: ['admin', 'ds_annotator'], title: 'Projects' }
      },
      {
        path: 'admin/krt-editor/resource-types',
        name: 'admin-resource-types',
        component: ResourceTypesView,
        meta: { roles: ['admin', 'ds_annotator'], title: 'Resource Types' }
      },
      {
        path: 'admin/enrichments',
        name: 'enrichment-list',
        component: EnrichmentListView,
        meta: { roles: ['admin', 'ds_annotator'], title: 'Enrichments' }
      },
      {
        path: 'admin/krt-editor/validation-rules',
        name: 'admin-validation-rules',
        component: AppConfigView,
        meta: { roles: ['admin'], title: 'Validation Rules' }
      },
      {
        path: 'profile',
        name: 'profile',
        component: ProfileView,
        meta: { roles: ['author', 'asap_pm', 'ds_annotator', 'admin'], title: 'My Profile' }
      }
    ]
  },
  {
    path: '/:pathMatch(.*)*',
    redirect: '/dashboard'
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

// Track if auth has been initialized
let authInitialized = false

// Navigation guard
router.beforeEach(async (to, from, next) => {
  const authStore = useAuthStore()

  // Initialize auth state on first navigation: ask the server for the
  // current user. The session cookie travels automatically — if it's
  // valid we get a user object, if not we get 401 and stay logged out.
  // The previous URL-hash callback handler is gone: since Phase 6.2 the
  // backend's /api/auth/callback sets cookies on the redirect response
  // and redirects to /dashboard with no token in the URL.
  if (!authInitialized) {
    authInitialized = true
    try {
      await authStore.fetchCurrentUser()
    } catch (err) {
      // No valid session — will redirect to login below if route is gated.
    }
  }

  // Check if route requires authentication
  if (to.meta.requiresAuth) {
    if (!authStore.isAuthenticated) {
      return next({ name: 'login', query: { redirect: to.fullPath } })
    }

    // Check role-based access (uses effectiveRole for admin "view as" feature)
    if (to.meta.roles && !to.meta.roles.includes(authStore.effectiveRole)) {
      return next({ name: 'dashboard' })
    }
  }

  // Redirect authenticated users away from guest routes
  if (to.meta.requiresGuest && authStore.isAuthenticated) {
    return next({ name: 'dashboard' })
  }

  next()
})

// Update page title after navigation
router.afterEach((to) => {
  const baseTitle = 'KRT Assist'
  const pageTitle = to.meta.title

  if (pageTitle) {
    document.title = `${pageTitle} | ${baseTitle}`
  } else {
    document.title = baseTitle
  }
})

// Helper function to update the browser tab/page title with submission info.
// We lead with the human-readable submission title (falling back to the
// manuscript id, then the workflow step) so curators can tell submissions
// apart across tabs instead of every step reading "Step X".
export function setSubmissionTitle(submissionTitle, stepTitle) {
  const baseTitle = 'KRT Assist'
  const label = submissionTitle || stepTitle
  document.title = label ? `${label} | ${baseTitle}` : baseTitle
}

export default router
