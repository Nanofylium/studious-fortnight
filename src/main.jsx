import React from 'react'
import ReactDOM from 'react-dom/client'
import '@/index.css'

// The desktop builds (vite --mode desktop / desktop-public) skip the Base44
// auth shell.
const load = import.meta.env.MODE.startsWith('desktop') ? import('@/DesktopApp.jsx') : import('@/App.jsx')

load.then(({ default: App }) => {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <App />
  )
})
