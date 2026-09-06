/* The numbered key: how detail is shown on the drafting surface.
 *
 * A mechanism drawing keys its parts to a numbered list at the corner of the
 * sheet -- a number, a term, a dotted leader running the gap, and the value.
 * That is what a block's detail opens into here, rather than a tooltip: a
 * tooltip is gone the moment you look away from it, and a drawing's key is
 * part of the drawing.
 *
 * Shared by task-panel.js and commitment-panel.js because it is the same key
 * in both, not because the two panels are otherwise related -- they stay the
 * independent siblings task-panel.js's header comment describes.
 *
 * Numbering is positional and starts at 01: entries that resolve to nothing
 * are dropped BEFORE numbering, so a key never shows a gap in its own
 * sequence. That is why this takes the whole list rather than being called
 * once per row.
 */

/** entries: [term, value, { wide, note }] -- value null/undefined/"" drops the
 *  row. `wide` gives the value the full width under its term, for prose that
 *  would be unreadable right-aligned in a narrow column. `note` is a short
 *  provenance aside printed after the value ("from your group", "classified by
 *  Claude") -- for a field the deterministic parser didn't produce. */
export function makeKey(entries) {
  const key = document.createElement("div");
  key.className = "dr-key";

  entries
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .forEach(([term, value, opts], i) => {
      const row = document.createElement("div");
      row.className = "dr-key-row";

      const num = document.createElement("span");
      num.className = "dr-key-num";
      num.textContent = String(i + 1).padStart(2, "0");

      const termEl = document.createElement("span");
      termEl.className = "dr-key-term";
      termEl.textContent = term;

      const valueEl = document.createElement("span");
      valueEl.className = "dr-key-value";

      if (opts?.wide) {
        valueEl.classList.add("dr-key-value--wide");
        row.append(num, termEl, valueEl);
      } else {
        const leader = document.createElement("span");
        leader.className = "dr-key-leader";
        row.append(num, termEl, leader, valueEl);
      }

      // A value may be a node (a control keyed into the list, like the lock
      // button) rather than text -- the key is where a block's editable facts
      // live too, not only its readable ones.
      if (value instanceof Node) valueEl.appendChild(value);
      else valueEl.textContent = value;

      if (opts?.note) {
        const note = document.createElement("span");
        note.className = "dr-key-note";
        note.textContent = opts.note;
        valueEl.appendChild(note);
      }

      key.appendChild(row);
    });

  return key;
}
