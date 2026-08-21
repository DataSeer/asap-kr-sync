import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './assets/styles/main.css'
import { tooltip } from './directives/tooltip'

const app = createApp(App)

app.use(createPinia())
app.use(router)
// Registered globally: it replaces the native `title` attribute across the app,
// so it has to be available everywhere without an import per component.
app.directive('tooltip', tooltip)

app.mount('#app')
