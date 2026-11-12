'use strict';
// Runs before CSS to avoid flashing a light page when dark mode is selected.
(() => {
  let saved;
  try { saved = localStorage.getItem('textdrop-theme'); } catch {}
  const system = matchMedia('(prefers-color-scheme: dark)');
  const apply = theme => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#17131d' : '#f5f3f8';
  };
  apply(saved === 'light' || saved === 'dark' ? saved : system.matches ? 'dark' : 'light');
  system.addEventListener('change', event => { if (!saved) apply(event.matches ? 'dark' : 'light'); });
  window.setTextdropTheme = theme => {
    saved = theme;
    apply(theme);
    try { localStorage.setItem('textdrop-theme', theme); } catch {}
  };
})();
