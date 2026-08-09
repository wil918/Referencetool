/* Shared click-driven press animation for every "light" button: the tab bar,
 * checkbox-style selection buttons, and the 2D graph's view toggles.
 *
 * The state change itself (checked, .active, the light's colour) is handled
 * by each page's own code and by plain CSS :has()/:checked selectors -- this
 * only plays the outward -> pressed -> outward pulse, so it fires on every
 * click (including a keyboard activation) rather than only for however long
 * the mouse happens to stay down, which is what :active alone would give.
 */
(function () {
  const SELECTOR = ".tab-btn, .checkbox-label, #view-toggles label";
  const ANIMATION_NAME = "press-pulse";

  document.addEventListener("click", (e) => {
    const el = e.target.closest(SELECTOR);
    if (!el) return;
    el.classList.remove("pulsing");
    // Force reflow so re-adding the class restarts the animation even when
    // clicked again before the previous pulse finished.
    void el.offsetWidth;
    el.classList.add("pulsing");
  });

  document.addEventListener("animationend", (e) => {
    if (e.animationName === ANIMATION_NAME) e.target.classList.remove("pulsing");
  });
})();
