import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// The design system loads before the app so each page's own stylesheet comes after it in the cascade.
import './styles.css';
import { App } from './App.js';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
