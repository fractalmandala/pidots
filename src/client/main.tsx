import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/index.sass';
import './editor.css';
import { watchSystemTheme } from './theme';
watchSystemTheme();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
