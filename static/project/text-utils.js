/* Shared by every contentEditable widget (text.js, title.js, notepad.js): HTML
 * is never allowed in, so paste and Enter both go through here instead of the
 * deprecated execCommand or letting the browser split the element into <div>s.
 */

/** Replace the current selection with a plain text node. */
export function insertPlainText(text) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.setEndAfter(node);
  selection.removeAllRanges();
  selection.addRange(range);
}
