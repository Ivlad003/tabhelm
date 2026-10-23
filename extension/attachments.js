// Chat attachments: images and text files (txt, md, csv, …) added with the
// Attach button, drag and drop, or pasting. Images are downscaled before sending.

const MAX_FILES = 10;
const MAX_TEXT_BYTES = 300_000;
const MAX_IMAGE_BYTES = 20_000_000;
const MAX_IMAGE_SIDE = 1600;
const TEXT_FILE = /\.(txt|md|markdown|csv|tsv|json|log)$/i;
const TEXT_MIME = { csv: 'text/csv', tsv: 'text/tab-separated-values', md: 'text/markdown', markdown: 'text/markdown', json: 'application/json' };

let pending = []; // { id, kind: 'image'|'text'|'quote', name, mimeType, data?, text?, size, url?, source? }
let els;
let report = () => {};

export function initAttachments({ list, button, input, dropTarget, pasteTarget, onError }) {
  els = { list, button, input };
  report = onError;
  button.onclick = () => input.click();
  input.onchange = () => {
    addFiles([...input.files]);
    input.value = '';
  };
  pasteTarget.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });
  dropTarget.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      dropTarget.classList.add('dropping');
    }
  });
  dropTarget.addEventListener('dragleave', (e) => {
    if (!dropTarget.contains(e.relatedTarget)) dropTarget.classList.remove('dropping');
  });
  dropTarget.addEventListener('drop', (e) => {
    e.preventDefault();
    dropTarget.classList.remove('dropping');
    addFiles([...e.dataTransfer.files]);
  });
}

export function hasAttachments() {
  return pending.length > 0;
}

// Removes the attachments from the composer and returns them for sending.
export function takeAttachments() {
  const taken = pending;
  pending = [];
  render();
  return taken;
}

// Drops pending text attachments with this name (one generated file replaces its older copy).
export function removeTextAttachment(name) {
  pending = pending.filter((a) => !(a.kind === 'text' && a.name === name));
  render();
}

export async function addFiles(files) {
  for (const file of files) {
    if (pending.length >= MAX_FILES) {
      report(`Up to ${MAX_FILES} files per message.`);
      break;
    }
    try {
      if (file.type.startsWith('image/')) pending.push(await readImage(file));
      else if (TEXT_FILE.test(file.name) || file.type.startsWith('text/')) pending.push(await readText(file));
      else report(`"${file.name}" is not supported. Attach images or text files (txt, md, csv, tsv, json, log).`);
    } catch (err) {
      report(`Could not attach "${file.name}": ${err.message}`);
    }
  }
  render();
}

async function readText(file) {
  if (file.size > MAX_TEXT_BYTES) throw new Error(`text files are limited to ${MAX_TEXT_BYTES / 1000} KB`);
  const ext = file.name.split('.').pop().toLowerCase();
  return { id: crypto.randomUUID(), kind: 'text', name: file.name, mimeType: TEXT_MIME[ext] || file.type || 'text/plain', text: await file.text(), size: file.size };
}

async function readImage(file) {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('images are limited to 20 MB');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  let blob = file;
  // Keep small PNG/JPEG/WebP/GIF as they are; downscale or re-encode the rest.
  if (scale < 1 || file.size > 1_500_000 || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  }
  bitmap.close();
  const name = file.name || `pasted-image.${blob.type.split('/')[1]}`;
  return { id: crypto.randomUUID(), kind: 'image', name, mimeType: blob.type, data: await toBase64(blob), size: blob.size, url: URL.createObjectURL(blob) };
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Text selected on a page → a quote chip; sent as part of the message with its source.
export function addQuote({ text, pageUrl, pageTitle }) {
  const clean = String(text || '').trim();
  if (!clean) return report('Nothing is selected on the page.');
  if (pending.length >= MAX_FILES) return report(`Up to ${MAX_FILES} items per message.`);
  pending.push({ id: crypto.randomUUID(), kind: 'quote', name: `❝ ${clean.slice(0, 40)}${clean.length > 40 ? '…' : ''}`, text: clean.slice(0, MAX_TEXT_BYTES), size: clean.length, source: { url: pageUrl, title: pageTitle } });
  render();
}

// Elements picked on the page (＋ → Pick element / Select area): one chip whose
// text tells the agent each element's ref, selector, text and HTML.
export function addElements({ items, url, title }) {
  if (!items?.length) return report('Nothing was picked.');
  if (pending.length >= MAX_FILES) return report(`Up to ${MAX_FILES} items per message.`);
  const lines = items.map((it) => `- [${it.ref}] <${it.tag}> ${it.text ? `"${it.text}"` : '(no text)'}\n  selector: ${it.selector}${it.href ? `\n  link: ${it.href}` : ''}\n  html: ${it.html}`);
  const label = items.length === 1 ? `⌖ ${items[0].tag}${items[0].text ? ` “${items[0].text.slice(0, 30)}”` : ''}` : `⬚ ${items.length} elements`;
  pending.push({ id: crypto.randomUUID(), kind: 'quote', header: `Element${items.length > 1 ? 's' : ''} picked on the page${url ? ` ${url}` : ''} (refs work with the browser tools until the page changes)`, name: label, text: lines.join('\n').slice(0, MAX_TEXT_BYTES), size: lines.join('').length, source: { url, title }, raw: true });
  render();
}

// An image on a page (context menu) → fetched here and attached like a file.
export async function addImageUrl(srcUrl, pageUrl) {
  try {
    const res = await fetch(srcUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) throw new Error('not an image');
    const name = decodeURIComponent(new URL(srcUrl).pathname.split('/').pop() || 'image') || 'image';
    const file = new File([blob], /\.[a-z0-9]+$/i.test(name) ? name : `${name}.${blob.type.split('/')[1] || 'png'}`, { type: blob.type });
    await addFiles([file]);
    const added = pending.at(-1);
    if (added?.kind === 'image') added.source = { url: pageUrl };
  } catch (err) {
    report(`Could not add the image: ${err.message}`);
  }
}

export function formatSize(bytes) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

// A chip (thumbnail or file name) — used in the composer and in sent messages.
export function chip(a, onRemove) {
  const el = document.createElement('div');
  el.className = `attachment ${a.kind}`;
  el.title = `${a.name} · ${formatSize(a.size)}`;
  if (a.kind === 'image' && a.url) el.append(Object.assign(document.createElement('img'), { src: a.url, alt: a.name }));
  else if (a.kind === 'quote') {
    el.append(Object.assign(document.createElement('span'), { className: 'file-icon', textContent: '❝' }));
    el.title = `${a.text.slice(0, 300)}\n— ${a.source?.title || a.source?.url || 'page'}`;
  } else el.append(Object.assign(document.createElement('span'), { className: 'file-icon', textContent: (a.name.split('.').pop() || 'txt').slice(0, 4).toUpperCase() }));
  el.append(Object.assign(document.createElement('span'), { className: 'name', textContent: a.name }));
  if (onRemove) {
    const x = Object.assign(document.createElement('button'), { className: 'remove', textContent: '×', title: `Remove ${a.name}` });
    x.setAttribute('aria-label', `Remove ${a.name}`);
    x.onclick = onRemove;
    el.append(x);
  }
  return el;
}

function render() {
  els.list.hidden = pending.length === 0;
  els.list.replaceChildren(
    ...pending.map((a) =>
      chip(a, () => {
        pending = pending.filter((p) => p.id !== a.id);
        render();
      }),
    ),
  );
}
