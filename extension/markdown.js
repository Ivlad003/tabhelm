// Small Markdown → HTML renderer for agent messages: headings, lists (nested,
// ordered, task), block quotes, tables, rules, fenced code and inline styles.
// Everything is escaped first, so the agent's text can never inject markup.

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function renderMarkdown(src) {
  return renderBlocks(String(src || '').replace(/\r\n?/g, '\n').split('\n'));
}

function renderBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    // Fenced code
    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)/);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1].slice(0, 3))) code.push(lines[i++]);
      i++;
      out.push(`<pre><code${fence[2] ? ` class="lang-${escapeHtml(fence[2])}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
      i++;
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) quote.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push(`<blockquote>${renderBlocks(quote)}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      out.push(renderTable(rows));
      continue;
    }
    if (listItem(line)) {
      const block = [];
      // A list runs until a blank line followed by non-indented, non-list text.
      while (i < lines.length) {
        if (!lines[i].trim()) {
          if (i + 1 < lines.length && (listItem(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1]))) {
            block.push(lines[i++]);
            continue;
          }
          break;
        }
        block.push(lines[i++]);
      }
      out.push(renderList(block));
      continue;
    }
    // Paragraph: consecutive non-blank lines that start no other block.
    const para = [];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(`<p>${para.map((l) => inline(l.trim())).join('<br>')}</p>`);
  }
  return out.join('');
}

function startsBlock(line) {
  return /^\s*(`{3,}|~{3,})/.test(line) || /^\s{0,3}#{1,6}\s/.test(line) || /^\s{0,3}>/.test(line) || Boolean(listItem(line)) || /^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line);
}

function listItem(line) {
  const m = line.match(/^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/);
  if (!m) return null;
  return { indent: m[1].length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10) || 1, text: m[3] };
}

function renderList(lines) {
  // Group lines into items at the top indent; deeper lines belong to the item above.
  const first = listItem(lines[0]);
  const base = first.indent;
  const items = [];
  for (const line of lines) {
    const item = listItem(line);
    if (item && item.indent <= base + 1 && item.ordered !== first.ordered) {
      // The list type changed: render what we have and start a new list.
      return renderList(lines.slice(0, lines.indexOf(line))) + renderList(lines.slice(lines.indexOf(line)));
    }
    if (item && item.indent <= base + 1) items.push({ ...item, body: [] });
    else if (items.length) items[items.length - 1].body.push(line.slice(Math.min(base + 2, line.length - line.trimStart().length)));
  }
  const tag = first.ordered ? 'ol' : 'ul';
  const startAttr = first.ordered && first.start !== 1 ? ` start="${first.start}"` : '';
  const html = items
    .map((item) => {
      const task = item.text.match(/^\[([ xX])\]\s+(.*)$/);
      const text = task ? `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ${inline(task[2])}` : inline(item.text);
      return `<li${task ? ' class="task"' : ''}>${text}${item.body.length ? renderBlocks(item.body) : ''}</li>`;
    })
    .join('');
  return `<${tag}${startAttr}>${html}</${tag}>`;
}

function renderTable(rows) {
  const cells = (row) =>
    row
      .trim()
      .replace(/^\||\|$/g, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, '|'));
  const aligns = cells(rows[1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : ''));
  const tr = (row, tag) =>
    `<tr>${cells(row)
      .map((c, k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(c)}</${tag}>`)
      .join('')}</tr>`;
  return `<table><thead>${tr(rows[0], 'th')}</thead><tbody>${rows.slice(2).map((r) => tr(r, 'td')).join('')}</tbody></table>`;
}

// Inline: code spans and links are protected first so their contents stay literal.
function inline(text) {
  const keep = [];
  const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
  let s = escapeHtml(text)
    .replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${c}</code>`))
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_, alt, url) => hold(`<img alt="${alt}" src="${url}">`))
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => hold(`<a href="${url}" target="_blank" rel="noopener">${label}</a>`))
    .replace(/(^|[^\w/])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g, (_, pre, url) => pre + hold(`<a href="${url}" target="_blank" rel="noopener">${url}</a>`));
  s = s
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<b><i>$1</i></b>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_\n]+)__/g, '<b>$1</b>')
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => keep[n]);
}
