// Auto-hiding scrollbars. Windows draws classic scrollbars that are always
// visible; TORU keeps their thumb transparent (styles.css) and marks whatever
// element is scrolling with .is-scrolling for a moment, which shows it.

const HIDE_AFTER_MS = 900;
const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();

/** Call once per page, before the first render. */
export function initScrollbars(): void {
  document.addEventListener(
    'scroll',
    (e) => {
      // Scrolling the page itself targets the document; its scrollbar belongs to <html>.
      const el = e.target instanceof Element ? e.target : document.documentElement;
      el.classList.add('is-scrolling');
      clearTimeout(timers.get(el));
      timers.set(
        el,
        setTimeout(() => el.classList.remove('is-scrolling'), HIDE_AFTER_MS),
      );
    },
    { capture: true, passive: true }, // scroll events don't bubble; capturing sees every scroller
  );
}
