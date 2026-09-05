// NOT USED BY THE WEEK VIEW ANY MORE. The schedule surface is drawn in the
// drafting language (see static/drafting.css), where colour is scarce by
// rule -- one red and one cool wash, and nothing else -- so a deliverable is
// keyed by NUMBER instead: calendar.js builds a stable 1..n index per
// deliverable in the visible range, marks each block with it, and draws the
// key under the calendar. Kept because it is still a correct implementation
// of a stable per-deliverable hue if a surface outside the drafting scope
// ever wants one; do not wire it back into the calendar without deciding
// what happens to the colour rule.
//
// A stable colour per deliverable, for the week/day/month calendars to key
// task blocks by (see CLAUDE.md's neumorphic rule 6: "do not introduce new
// colours"). deliverables carry no colour of their own in the data model
// (see SCHEDULE_SCOPE.md), and the app has no existing named palette to draw
// several distinguishable hues from -- only the single accent red. Rather
// than invent a set of brand colours, this rotates hue at the fixed
// lightness/saturation --accent already sits at, so every deliverable colour
// reads as "a member of the same family" rather than an arbitrary new tone.
// It is used the same way --accent already is: a small dot or inset stripe
// on a block, never a fill (see .task-chip.generated::after for the existing
// idiom this follows).
const HUES = [6, 34, 62, 130, 170, 200, 235, 275, 305, 335];

export function deliverableColour(deliverableId) {
  if (!deliverableId) return null;
  let hash = 0;
  for (let i = 0; i < deliverableId.length; i++) {
    hash = (hash * 31 + deliverableId.charCodeAt(i)) >>> 0;
  }
  const hue = HUES[hash % HUES.length];
  return `hsl(${hue}deg 55% 45%)`;
}
