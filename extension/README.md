# Reference Archive — browser extension

Captures images and text from the web straight into the existing archive,
keeping a record of where each thing came from.

The extension is a **capture client only**. It downloads the bytes and reads
the page's metadata; the Python app does all the rest — storage, tagging,
embedding, duplicate detection and project membership. There is no second
database, and the extension never writes to the archive's own.

## Installing

1. Start the archive:

```bash
python app.py
```

2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, choose
   **Load unpacked**, and select this `extension/` folder.

No build step — it's plain ES modules, which MV3 runs natively.

If your archive isn't on `http://127.0.0.1:5050`, set the address in the
extension's Options page. `Test connection` there tells you whether it can
reach it.

## Using it

**Images.** Click the extension on any page. It lists the images worth saving,
ranked, with the best one already selected. Pick one or several, optionally add
a note, choose a project, and save.

**Text.** Highlight a passage, then click the extension — it opens on the
quotation. The selected text is stored exactly as highlighted.

**Page.** Saves the page itself as a reference: title, description, URL and
representative image. It does not copy the page body.

**Right-click** also works, for an image or a selection, without opening the
popup. Those go to whichever project you last saved into.

Saving returns immediately. The archive queues the capture and runs tagging and
embedding in the background, so the reference appears in your library a few
seconds later — this is why the popup can be dismissed straight away.

## What gets stored

Alongside the reference itself, each capture records:

- the page URL, its canonical URL, and the direct image URL
- the domain and page title, and when it was captured
- every metadata field found, **with where it came from** — JSON-LD, OpenGraph,
  Dublin Core, `citation_*`, a figure caption, or nearby text — and a
  confidence for each
- your note, preserved exactly as typed

Nothing is guessed. No field is ever marked "AI inferred" in this version,
because nothing here infers anything.

On Pinterest, the pin URL *and* the source it credits are both kept. The
credited link is recorded as a claim, not a fact — those links are often wrong
— and it never replaces the URL you actually captured from.

## Privacy

- No always-on content script. The collector is injected only when you open
  the popup or use the right-click menu, under `activeTab` — that part never
  needed broad permissions and still doesn't.
- `host_permissions` does include `http://*/*` and `https://*/*`, which looks
  broad, so it's worth explaining exactly what it's for. Reading an image's
  bytes with `fetch()` — as opposed to just displaying it — requires either
  the image's own server to send a CORS header (almost none do; browsers have
  never required it just to show an `<img>`), or the request to come from a
  privileged extension context the browser trusts instead. That's what this
  permission grants: the background service worker can download the one image
  you selected, from whatever host it happens to live on. It does not enable
  always-on script injection on other tabs — that's still gated by
  `activeTab`, unrelated to this permission, and unchanged by it.
- The only outbound requests are to your configured archive (all through
  `src/services/api.js`) and to the one image URL you're actively saving (all
  through `src/services/download.js`). Nothing else is fetched, and no
  browsing history is collected.

If you expose the archive beyond localhost, set `ARCHIVE_API_TOKEN` in the
app's `.env` and paste the same value into the extension's Options page. The
token is stored in your browser profile and is never hardcoded.

## Layout

```
manifest.json
src/
  background/service-worker.js   right-click menus, injection, downloading, badge feedback
  content/collect.js             runs in the page: describes it, builds envelopes
  extraction/
    metadata.js                  JSON-LD -> OpenGraph -> Dublin Core -> meta
    images.js                    candidate detection and ranking
    selection.js                 selected text, context, nearest heading
    provenance.js                {field, value, source, confidence}
    capture.js                   builds the envelope the archive accepts
    extractors/                  generic, plus per-site adapters
  services/
    api.js                       the only thing that talks to the archive
    download.js                  the only thing that downloads image bytes
    inject.js                    gets collect.js into a tab
    settings.js                  chrome.storage wrapper
  popup/, options/, styles/
tests/
  extraction.test.html           open in a browser to run
  popup.preview.html             the real popup against a mocked runtime
```

**Where each piece runs, and why.** `collect.js` runs inside the page (an
isolated-world content script) because that's the only place with DOM access —
it reads images, metadata and any selection, and builds the capture envelope.
It does *not* download image bytes: a content script's `fetch()` is bound by
the page's own CORS policy, and almost no image host sends the header a
cross-origin fetch needs, so that call would fail on nearly every real site.
Downloading instead happens in the background service worker, a privileged
extension context that's exempt from that check for any origin the manifest's
`host_permissions` covers (see Privacy, above). The popup asks the background
to do it rather than doing it itself, because Chrome destroys the popup
document the instant it loses focus — a single stray click would abort a
download it just started.

Because `collect.js` is an ES module (it imports the whole extraction
pipeline) but `chrome.scripting.executeScript`'s `files` option always runs an
injected file as a classic script, it can't be injected directly — a top-level
`import` there is a silent syntax error, and the popup would report "Could not
establish connection" with no clue why. `services/inject.js` works around this
the standard way: it injects a one-line function that dynamically
`import()`s the real module by its extension URL, which works from a classic
script even though a static `import` statement doesn't.

## Tests

The extraction logic has no DOM-free dependencies, so its tests run in a
browser rather than needing Node:

```bash
python -m http.server 5099 --directory extension
```

then open `http://127.0.0.1:5099/tests/extraction.test.html`. It prints a
pass/fail count. `popup.preview.html` in the same folder renders the real popup
against a stubbed `chrome` API and a fake archive, which is useful for working
on the UI without reloading the extension.

Backend tests are pytest, from the project root:

```bash
python -m pytest tests/
```

## Adding a site adapter

Only worth it when the generic extractor genuinely fails — anything that could
help more than one site belongs in `extraction/` instead. An adapter exports
`id`, `matches(host)`, `extract(doc, win)`, and optionally `mergeForImage`;
register it ahead of `generic` in `extractors/index.js`.
