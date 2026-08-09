import { getSettings, setSettings } from "../services/settings.js";
import { health } from "../services/api.js";

const el = (id) => document.getElementById(id);

load();

async function load() {
  const settings = await getSettings();
  el("endpoint").value = settings.endpoint;
  el("token").value = settings.token;

  el("save-btn").addEventListener("click", async () => {
    await setSettings({
      endpoint: el("endpoint").value,
      token: el("token").value.trim(),
    });
    el("status").textContent = "Saved.";
  });

  el("test-btn").addEventListener("click", async () => {
    // Test what's currently typed, not what was last saved -- otherwise the
    // button reports on stale settings and is actively misleading.
    await setSettings({
      endpoint: el("endpoint").value,
      token: el("token").value.trim(),
    });
    el("status").textContent = "Checking…";
    const result = await health();
    el("status").textContent = result.ok
      ? `Connected. ${result.reference_count} references in the archive.`
      : `Could not connect: ${result.error}`;
  });
}
