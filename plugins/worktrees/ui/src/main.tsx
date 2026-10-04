import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { WorktreesApp } from './app'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WorktreesApp />
  </StrictMode>,
)
