import '@fontsource-variable/inter';
import '@fontsource-variable/newsreader/opsz.css';
import '../ui/styles.css';
import './app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initScrollbars } from '../ui/scrollbars';
import { initTheme } from '../ui/theme';
import { App } from './App';

initScrollbars();
initTheme({ main: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
