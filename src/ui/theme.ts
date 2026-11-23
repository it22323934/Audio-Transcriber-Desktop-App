// Applies the colour theme. 'system' leaves html[data-theme] unset so the CSS
// follows prefers-color-scheme; 'light'/'dark' force it. The choice is mirrored
// to localStorage (read synchronously at startup, so there's no flash of the
// wrong theme). The main window also tells Electron, so the title-bar buttons
// match the page.
import { bridge } from '../lib/bridge';
import { subscribe } from '../lib/events';
import * as store from '../lib/store';
import type { ThemePreference } from '../lib/types';

const LOCAL_KEY = 'toru-theme';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
let current: ThemePreference = 'system';
let reportToMain = false;
/** Open dialogs; while any is open the window buttons take the backdrop's colour. */
let dialogs = 0;

function report(): void {
  if (!reportToMain) return;
  // Read the resolved colours back from the CSS tokens, so they always match.
  const css = getComputedStyle(document.documentElement);
  const dark = current === 'dark' || (current === 'system' && darkQuery.matches);
  bridge.app.setTheme({
    dark,
    background: css.getPropertyValue('--bg').trim() || (dark ? '#11110f' : '#fcfcfa'),
    text: css.getPropertyValue('--text-2').trim() || (dark ? '#b3b1a5' : '#5a584f'),
    ...(dialogs > 0 ? { titleBar: css.getPropertyValue('--titlebar-dimmed').trim() } : {}),
  });
}

/** Dialogs call this when they open (true) and close (false). */
export function dimTitleBar(on: boolean): void {
  dialogs = Math.max(0, dialogs + (on ? 1 : -1));
  report();
}

export function applyTheme(pref: ThemePreference): void {
  current = pref;
  const root = document.documentElement;
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
  try {
    localStorage.setItem(LOCAL_KEY, pref);
  } catch {
    // storage unavailable: the theme still applies for this page
  }
  report();
}

/** Call before the first render. `main` is true for the main window (it owns the title bar). */
export function initTheme(opts: { main?: boolean } = {}): void {
  reportToMain = !!opts.main;
  let cached: string | null = null;
  try {
    cached = localStorage.getItem(LOCAL_KEY);
  } catch {
    // ignore
  }
  applyTheme(cached === 'light' || cached === 'dark' ? cached : 'system');
  const sync = () => store.getSettings().then((s) => applyTheme(s.theme), () => {});
  void sync();
  subscribe((e) => {
    if (e.type === 'settings') void sync();
  });
  darkQuery.addEventListener('change', report);
}
