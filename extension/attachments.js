// Chat attachments: images and text files (txt, md, csv, …) added with the
// Attach button, drag and drop, or pasting. Images are downscaled before sending.

const MAX_FILES = 10;
const MAX_TEXT_BYTES = 300_000;
const MAX_IMAGE_BYTES = 20_000_000;
const MAX_IMAGE_SIDE = 1600;
const TEXT_FILE = /\.(txt|md|markdown|csv|tsv|json|log)$/i;
const TEXT_MIME = { csv: 'text/csv', tsv: 'text/tab-separated-values', md: 'text/markdown', markdown: 'text/markdown', json: 'application/json' };

let pending = []; // { id, kind: 'image'|'text', name, mimeType, data?, text?, size, url? }
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

export function formatSize(bytes) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

// A chip (thumbnail or file name) — used in the composer and in sent messages.
export function chip(a, onRemove) {
  const el = document.createElement('div');
  el.className = `attachment ${a.kind}`;
  el.title = `${a.name} · ${formatSize(a.size)}`;
  if (a.kind === 'image' && a.url) el.append(Object.assign(document.createElement('img'), { src: a.url, alt: a.name }));
  else el.append(Object.assign(document.createElement('span'), { className: 'file-icon', textContent: (a.name.split('.').pop() || 'txt').slice(0, 4).toUpperCase() }));
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
