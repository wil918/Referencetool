// Triggers the bulk zip download (POST /api/export) shared by the Archive
// and project grids' selection toolbars.
//
// Submitted as a real <form> targeting a hidden iframe, not fetched with JS
// and turned into a Blob: a form submission lets the browser's own download
// flow handle the response exactly like a plain GET download would (the
// same mechanism /media/<id>/download relies on, proven to work in
// WKWebView), and never holds the whole zip in memory on the client either.

let frame = null;

function ensureFrame() {
  if (frame) return frame;
  frame = document.createElement("iframe");
  frame.name = "export-download-frame";
  frame.hidden = true;
  document.body.appendChild(frame);
  return frame;
}

/** ids: reference ids in the order they should appear in the zip (on-screen
 *  order -- see cards.js callers, which derive this from the rendered list,
 *  not selection-click order). */
export function downloadZip(url, ids) {
  ensureFrame();
  const form = document.createElement("form");
  form.method = "POST";
  form.action = url;
  form.target = "export-download-frame";
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "ids";
  input.value = JSON.stringify(ids);
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
  form.remove();
}
