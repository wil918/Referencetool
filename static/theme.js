/* Shared dark-mode control for every page in the app.
 *
 * This script must be loaded synchronously, as early as possible in <head>
 * -- before the page's own <style> or stylesheet link -- so the theme
 * attribute is on <html> before the browser's first paint. A version that
 * ran after paint (e.g. at the bottom of <body>) would show a flash of the
 * wrong theme on every load.
 *
 * The toggle itself only lives in the Settings tab (see app.js), but every
 * page -- including the standalone graph.html and connections.html, which
 * don't share the SPA -- reads the stored preference here so the whole app
 * agrees on which theme is active.
 */
(function () {
  const STORAGE_KEY = "fashion-ref-theme";

  function getStoredTheme() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      return null;
    }
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
  }

  function setTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (err) {
      // Storage unavailable (private browsing, etc.) -- theme still applies
      // for this page load, it just won't persist to the next one.
    }
    applyTheme(theme);
  }

  applyTheme(getStoredTheme() || "light");

  window.themeControl = { get: getStoredTheme, set: setTheme, apply: applyTheme };
})();
