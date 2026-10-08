"""The frontend half of the capability switches (no key, no schedule).

There is no DOM test tooling here (no npm, by rule), so this runs what can be
run for real under node -- the widget registry, which decides what the Add
Widget dock and the canvas palette offer -- and guards the rest with a tripwire:
the controls that *start* a Claude call are enumerated, and a new one fails
this file until somebody has decided what it does with no key.

The rendered behaviour (the Analyze button not being in the toolbar, the
concept button not being on the canvas, the Settings statement) was checked
in a browser against a keyless server; these tests keep the pieces that make
it true from drifting.
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / "static"
NODE = shutil.which("node")

needs_node = pytest.mark.skipif(NODE is None, reason="node is not on PATH")


def run_registry(script, caps):
    """Run `script` (module code) against the real registry with window-less
    `globalThis.capabilities` set to `caps`; the script's last console.log is
    returned as JSON."""
    source = (
        f"globalThis.capabilities = {json.dumps(caps)};\n"
        f"const registry = await import({json.dumps('file://' + str(STATIC / 'project' / 'registry.js'))});\n"
        + script
    )
    done = subprocess.run(
        [NODE, "--input-type=module", "-e", source], capture_output=True, text=True, timeout=60
    )
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout.strip().splitlines()[-1])


ALL_ON = {"schedule": True, "claude": True, "embeddings": True}


@needs_node
def test_every_widget_is_offered_when_everything_is_on():
    out = run_registry(
        "console.log(JSON.stringify({all: registry.all().map(d => d.type), offered: registry.offered().map(d => d.type)}))",
        ALL_ON,
    )
    assert out["offered"] == out["all"]
    assert {"analysis", "deliverables", "upcoming", "brief"} <= set(out["offered"])


@needs_node
def test_the_analysis_widget_is_not_offered_without_a_key_but_nothing_else_goes():
    everything = run_registry("console.log(JSON.stringify(registry.all().map(d => d.type)))", ALL_ON)
    offered = run_registry(
        "console.log(JSON.stringify(registry.offered().map(d => d.type)))",
        {**ALL_ON, "claude": False},
    )
    assert "analysis" not in offered
    assert set(everything) - set(offered) == {"analysis"}


@needs_node
def test_the_schedule_tiles_are_not_offered_with_the_schedule_off():
    everything = run_registry("console.log(JSON.stringify(registry.all().map(d => d.type)))", ALL_ON)
    offered = run_registry(
        "console.log(JSON.stringify(registry.offered().map(d => d.type)))",
        {**ALL_ON, "schedule": False},
    )
    assert set(everything) - set(offered) == {"deliverables", "upcoming", "brief"}


@needs_node
def test_a_stored_analysis_widget_still_renders_without_a_key():
    """Hiding what initiates a call must not hide what reads a stored result:
    an analysis widget already on a page keeps its real definition."""
    out = run_registry(
        """
        const stored = registry.definitionFor("analysis");
        console.log(JSON.stringify({
          isTheRealOne: stored === registry.get("analysis"),
          placeholder: stored.isPlaceholder,
        }));
        """,
        {**ALL_ON, "claude": False},
    )
    assert out == {"isTheRealOne": True, "placeholder": False}


@needs_node
def test_a_stored_schedule_widget_says_the_schedule_is_off_instead_of_fetching():
    out = run_registry(
        """
        const made = [];
        globalThis.document = { createElement: () => { const el = { className: "", textContent: "", remove() {} }; made.push(el); return el; } };
        const def = registry.definitionFor("deliverables");
        const host = { el: { appendChild() {} } };
        def.create(host);
        console.log(JSON.stringify({
          isTheRealOne: def === registry.get("deliverables"),
          label: def.label,
          text: made[0].textContent,
          keepsItsSize: JSON.stringify(def.defaultSize) === JSON.stringify(registry.get("deliverables").defaultSize),
        }));
        """,
        {**ALL_ON, "schedule": False},
    )
    assert out["isTheRealOne"] is False
    assert out["text"] == "Deliverables — the schedule is switched off"
    assert out["keepsItsSize"] is True


@needs_node
def test_with_the_schedule_on_a_schedule_widget_is_unchanged():
    out = run_registry(
        'console.log(JSON.stringify(registry.definitionFor("deliverables") === registry.get("deliverables")))',
        ALL_ON,
    )
    assert out is True


@needs_node
def test_capabilities_default_to_everything_on_when_the_script_did_not_load():
    source = (
        f"const m = await import({json.dumps('file://' + str(STATIC / 'shared' / 'capabilities.js'))});\n"
        "console.log(JSON.stringify(m.capabilities));"
    )
    done = subprocess.run([NODE, "--input-type=module", "-e", source], capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout) == ALL_ON


# --- the tripwire: what starts a Claude call ------------------------------------------------------

# The routes that call Claude. The brief and supporting-document ones are the
# project-scoped imports; /api/briefs/<id>/reset and /apply only write to the
# database, so a bare "/briefs" would flag them wrongly.
CLAUDE_ENDPOINTS = re.compile(
    r"/api/analyze|concept-analysis|/api/tasks/generate|/api/tagging/backfill"
    r"|/projects/.*/(?:briefs|supporting-documents)$"
)
FETCH_CALL = re.compile(r"fetch\(\s*([`\"'])(.*?)\1\s*,\s*\{([^}]*)\}", re.S)

# Every file that POSTs to something which calls Claude. A new entry in the real
# set fails the first test below until it is added here -- which is the moment
# to decide what that control does with no key.
INITIATORS = {
    "static/app.js": "Settings > Tags backfill; section is data-requires=claude and refreshTaggingStatus returns early",
    "static/project/pages/analysis-panel.js": "Analyze; overlays never put in the page, startAnalysis returns early",
    "static/project/pages/concept-panel.js": "Concept analysis; canvas-page.js never builds the panel",
    "static/tasks.js": "task generation; the fetch is skipped",
    "static/schedule/brief-import.js": "Import brief; #brief-import-btn is data-requires=claude",
    "static/schedule/supporting-docs.js": "Add supporting document; #supporting-doc-import-btn is data-requires=claude",
}

# And the guard each one is held behind.
GUARDS = {
    "static/app.js": "capabilities.claude",
    "static/project/pages/analysis-panel.js": "capabilities.claude",
    "static/project/pages/canvas-page.js": "capabilities.claude",
    "static/project/pages/grid-page.js": "capabilities.claude",
    "static/tasks.js": "capabilities.claude",
    "static/schedule.html": 'data-requires="claude"',
}


def _static_sources():
    for path in sorted(STATIC.rglob("*")):
        if "vendor" in path.parts or path.suffix not in (".js", ".html"):
            continue
        yield path, path.read_text(encoding="utf-8")


def test_the_files_that_start_a_claude_call_are_exactly_the_known_ones():
    found = set()
    for path, text in _static_sources():
        for _, url, options in FETCH_CALL.findall(text):
            if CLAUDE_ENDPOINTS.search(url) and re.search(r"method:\s*[\"']POST[\"']", options):
                found.add(str(path.relative_to(ROOT)))
    assert found == set(INITIATORS), (
        "A file now POSTs to a route that calls Claude (or one stopped). Decide what it does with no "
        f"key, gate it, and list it in INITIATORS and GUARDS: {sorted(found ^ set(INITIATORS))}"
    )


def test_each_guard_is_still_in_place():
    for relative, needle in GUARDS.items():
        assert needle in (ROOT / relative).read_text(encoding="utf-8"), f"{relative} lost its `{needle}` guard"


def test_the_import_buttons_carry_the_attribute_that_hides_them():
    html = (STATIC / "schedule.html").read_text(encoding="utf-8")
    for button in ("brief-import-btn", "supporting-doc-import-btn"):
        tag = re.search(rf'<button[^>]*id="{button}"[^>]*>', html).group(0)
        assert 'data-requires="claude"' in tag


def test_the_nav_entries_for_the_schedule_carry_the_attribute_that_hides_them():
    for page, link_class in (("index.html", "nav-link"), ("graph.html", "top-link")):
        html = (STATIC / page).read_text(encoding="utf-8")
        tag = re.search(rf'<a class="{link_class}" href="/schedule.html"[^>]*>', html).group(0)
        assert 'data-requires="schedule"' in tag, page


def test_the_gating_css_exists():
    css = (STATIC / "style.css").read_text(encoding="utf-8")
    for name in ("schedule", "claude", "embeddings"):
        assert f'html[data-{name}="off"] [data-requires~="{name}"]' in css


PAGES_THAT_NEED_THE_SCRIPT = (
    "index.html", "project.html", "graph.html", "connections.html", "colour-connections.html", "schedule.html",
)


@pytest.mark.parametrize("page", PAGES_THAT_NEED_THE_SCRIPT)
def test_each_page_loads_capabilities_before_its_modules(page):
    """A page that forgot the script defaults to everything on -- silently
    showing a control the copy cannot honour -- so it is checked, not trusted."""
    html = (STATIC / page).read_text(encoding="utf-8")
    script = html.find('<script src="/capabilities.js"></script>')
    assert script != -1, f"{page} does not load /capabilities.js"
    first_module = html.find('type="module"')
    assert first_module == -1 or script < first_module
    assert script < html.find("</head>")  # synchronous, in the head, like theme.js


def test_the_settings_statement_exists_once_and_only_in_settings():
    statements = [
        str(path.relative_to(ROOT))
        for path, text in _static_sources()
        if "Claude features are off" in text
    ]
    assert statements == ["static/index.html"]


# --- the escape hatch really is one -----------------------------------------------------------


def test_with_embeddings_skipped_neither_chroma_nor_the_model_is_even_imported():
    """The README says the vector libraries are not needed with SKIP_EMBEDDINGS.
    That is only true while nothing imports them at module level, so this runs
    the app with every one of them blocked and adds a reference."""
    script = r"""
import sys, importlib.abc, tempfile, pathlib

BLOCKED = ("chromadb", "sentence_transformers", "torch", "transformers")

class Blocker(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name.split(".")[0] in BLOCKED:
            raise ImportError("BLOCKED: " + name)
        return None

sys.meta_path.insert(0, Blocker())

import config, db, ingest, app
from PIL import Image

tmp = pathlib.Path(tempfile.mkdtemp())
db.DB_PATH = tmp / "t.db"
config.REFERENCES_DIR = tmp / "references"
ingest.IMAGES_DIR = tmp / "references" / "images"
ingest.TEXTS_DIR = tmp / "references" / "texts"
ingest.IMAGES_DIR.mkdir(parents=True)
ingest.TEXTS_DIR.mkdir(parents=True)
db.init_db()

img = tmp / "look.png"
Image.new("RGB", (80, 60), (200, 100, 50)).save(img)
result = ingest.add_reference(img)
client = app.app.test_client()
statuses = [client.get(p).status_code for p in ("/", "/api/references", "/api/references?q=look", "/api/colour/map")]
loaded = [m for m in sys.modules if m.split(".")[0] in BLOCKED]
print(result["title"], statuses, loaded)
"""
    env = {
        "PATH": "/usr/bin:/bin",
        "SKIP_EMBEDDINGS": "1",
        "ANTHROPIC_API_KEY": "",
        "ARCHIVE_API_TOKEN": "",
        "ARCHIVE_HOST": "",
        "HOME": str(Path.home()),
    }
    done = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, timeout=120, cwd=ROOT, env=env
    )
    assert done.returncode == 0, done.stderr[-2000:]
    assert done.stdout.strip().splitlines()[-1] == "look [200, 200, 200, 200] []"
