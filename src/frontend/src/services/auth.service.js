import api from './api'

// All endpoints rely on the cookies set by the backend (Phase 6.2). The
// frontend never sees the access or refresh tokens, so logout/refresh
// take no token argument.
export default {
  async login(email, password) {
    const response = await api.post('/auth/login', { email, password })
    return response.data
  },

  async register(userData) {
    const response = await api.post('/auth/register', userData)
    return response.data
  },

  async logout() {
    const response = await api.post('/auth/logout')
    return response.data
  },

  async refreshToken() {
    const response = await api.post('/auth/refresh')
    return response.data
  },

  async getCurrentUser() {
    const response = await api.get('/auth/me')
    return response.data
  },

  async auth0PasswordLogin(email, password) {
    const response = await api.post('/auth/auth0/login-password', { email, password })
    return response.data
  }
}
