import '@fontsource-variable/inter';
import '../ui/styles.css';
import './widget.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initScrollbars } from '../ui/scrollbars';
import { initTheme } from '../ui/theme';
import { Widget } from './Widget';

initScrollbars();
initTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Widget />
  </StrictMode>,
);
