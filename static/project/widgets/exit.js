/* The way out of the project space, back to the archive's Projects tab.
 *
 * Permanent: a homepage with no exit would be a dead end, so this one can be
 * moved anywhere on the grid but never deleted (the API refuses it too).
 */

export default {
  type: "exit",
  label: "Exit Project",
  container: false,
  permanent: true,
  defaultSize: { w: 2, h: 1 },
  minSize: { w: 1, h: 1 },

  create(host) {
    const wrap = document.createElement("div");
    wrap.className = "widget-exit";

    // An anchor rather than a button: this leaves the project page entirely,
    // so it should behave like the navigation it is -- open in a new tab,
    // copy link, and land in the back history.
    const link = document.createElement("a");
    link.className = "btn";
    link.href = "/index.html#projects";
    link.title = "Exit project";
    link.textContent = "← Exit";
    wrap.appendChild(link);

    host.el.appendChild(wrap);

    return {
      destroy() {
        wrap.remove();
      },
    };
  },
};
