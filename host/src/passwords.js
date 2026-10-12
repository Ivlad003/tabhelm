// Password-manager hand-off. Credentials never go to the model: the host
// fetches them (1Password CLI) and the extension types them into the fields.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export async function onePasswordAvailable() {
  try {
    await run('op', ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

// Logins for a site from 1Password. Needs `op signin` done once (or the
// desktop-app integration). Returns [{ id, title, username }] — no passwords.
export async function onePasswordItems(url) {
  const host = hostOf(url);
  const { stdout } = await run('op', ['item', 'list', '--categories', 'Login', '--format', 'json'], { timeout: 20_000, maxBuffer: 10e6 });
  const items = JSON.parse(stdout);
  const matching = items.filter((it) => (it.urls || []).some((u) => hostOf(u.href).endsWith(host) || host.endsWith(hostOf(u.href))));
  return matching.slice(0, 10).map((it) => ({ id: it.id, title: it.title, username: it.additional_information || '' }));
}

export async function onePasswordCredential(id) {
  const { stdout } = await run('op', ['item', 'get', id, '--fields', 'label=username,label=password', '--format', 'json'], { timeout: 20_000 });
  const fields = JSON.parse(stdout);
  const get = (label) => fields.find((f) => f.label === label || f.id === label)?.value || '';
  return { username: get('username'), password: get('password') };
}
