// ---------- Page scripts library (Page scripts & styles flag) ----------
// Presets live in chrome.storage.local `pageScripts`: { id, name, description,
// match (URL glob, * wildcard; several separated by spaces or commas), js, css,
// autoRun, enabled, source }.
export async function listScripts() {
  return (await chrome.storage.local.get('pageScripts')).pageScripts || [];
}

export function scriptMatches(preset, url) {
  const globs = String(preset.match || '*').split(/[\s,]+/).filter(Boolean);
  return globs.some((g) => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(url || '') || (!g.includes('/') && new RegExp(`^https?://([^/]*\\.)?${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}(:\\d+)?(/|$)`).test(url || '')));
}

export async function saveScript(p) {
  const all = await listScripts();
  const name = String(p.name || '').trim().slice(0, 60) || 'script';
  const preset = { id: p.id || crypto.randomUUID(), name, description: String(p.description || '').slice(0, 300), match: String(p.match || '*').trim() || '*', js: String(p.js || ''), css: String(p.css || ''), autoRun: p.source === 'agent' ? false : Boolean(p.autoRun), enabled: p.enabled !== false, source: p.source || 'user', updated: new Date().toISOString() };
  const i = all.findIndex((x) => x.id === preset.id || x.name === name);
  if (i >= 0) all[i] = { ...all[i], ...preset, id: all[i].id, autoRun: p.source === 'agent' ? all[i].autoRun : preset.autoRun };
  else all.push(preset);
  await chrome.storage.local.set({ pageScripts: all });
  return all[i >= 0 ? i : all.length - 1];
}
