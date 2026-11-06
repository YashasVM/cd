// Builds public/design/docs.json from the root design.md.
// Runs before `vite build` so the manifest ships inside dist/design/.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(root, 'public', 'design', 'docs.json');

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderInline(text) {
  // Assumes `text` is already HTML-escaped by the caller.
  return (
    text
      // inline code first so its contents are not link/bold-processed
      .replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`)
      // images
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, src) => `<img alt="${alt}" src="${src}" loading="lazy" />`)
      // links
      .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, href) => {
        const safe = /^https?:\/\/|^mailto:|^#|^\//.test(href) ? href : '#';
        const external = /^https?:\/\//.test(href) ? ' target="_blank" rel="noreferrer"' : '';
        return `<a href="${safe}"${external}>${label}</a>`;
      })
      // bold + italic
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')
  );
}

function isTableDelimiter(line) {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|');
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{1,}:?\s*$/.test(cell));
}

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map((cell) => cell.trim());
}

function renderTable(header, delimiter, bodyRows) {
  // Showcase tables: the palette and typography spec tables render as
  // visual cards (swatches / type specimens) instead of plain grids.
  // The markdown tables stay the source of truth, so GitHub and the
  // site never drift apart.
  const headCells = splitRow(header).map((cell) => cell.toLowerCase().replace(/`+/g, ''));
  if (headCells.includes('token') && headCells.some((cell) => cell.includes('hex'))) {
    return renderPalette(bodyRows);
  }
  if (headCells.includes('role') && headCells.some((cell) => cell.includes('stack'))) {
    return renderTypeSpecimens(bodyRows);
  }
  const aligns = splitRow(delimiter).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });
  const head = splitRow(header)
    .map((cell, i) => `<th${aligns[i] && aligns[i] !== 'left' ? ` style="text-align:${aligns[i]}"` : ''}>${renderInline(escapeHtml(cell))}</th>`)
    .join('');
  const body = bodyRows
    .map((row) => `<tr>${splitRow(row).map((cell, i) => `<td${aligns[i] && aligns[i] !== 'left' ? ` style="text-align:${aligns[i]}"` : ''}>${renderInline(escapeHtml(cell))}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function sanitizePreview(html) {
  // design.md is our own file, but previews render as live HTML, so keep
  // a tight allowlist: drop executable tags, event handlers, and
  // javascript: URLs before embedding.
  return html
    .replace(/<\s*\/?\s*(script|iframe|object|embed|link|meta|style|form|base)\b[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript\s*:/gi, '');
}

function firstColor(value) {
  const hex = value.match(/#[0-9a-fA-F]{3,8}\b/);
  if (hex) return hex[0];
  const rgb = value.match(/rgba?\([^)]*\)/);
  return rgb ? rgb[0] : null;
}

function renderPalette(bodyRows) {
  const cards = bodyRows.map((row) => {
    const cells = splitRow(row);
    const token = (cells[0] ?? '').replace(/`+/g, '').trim();
    const hexRaw = (cells[1] ?? '').replace(/`+/g, '').trim();
    const usage = cells.slice(2).join(' | ').trim();
    const hexes = [...hexRaw.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0]);
    const rgb = hexRaw.match(/rgba?\([^)]*\)/);
    let chip = 'background:#000';
    let copy = hexRaw;
    if (hexes.length >= 2) {
      chip = `background:linear-gradient(135deg, ${hexes[0]} 50%, ${hexes[1]} 50%)`;
      copy = hexes.join(' / ');
    } else if (hexes.length === 1) {
      chip = `background:${hexes[0]}`;
      copy = hexes[0];
    } else if (rgb) {
      // Translucent tokens (e.g. line) need a mid-tone underlay, otherwise
      // the chip reads as empty on the dark card.
      chip = `background:linear-gradient(${rgb[0]}, ${rgb[0]}), linear-gradient(#3a2a22, #3a2a22)`;
      copy = rgb[0];
    }
    return `<button class="swatch" type="button" data-copy="${escapeHtml(copy)}">`
      + `<span class="swatch-chip" style="${escapeHtml(chip)}"></span>`
      + `<span class="swatch-token">${escapeHtml(token)}</span>`
      + `<span class="swatch-hex">${escapeHtml(hexRaw)}</span>`
      + `<span class="swatch-use">${renderInline(escapeHtml(usage))}</span>`
      + `</button>`;
  });
  return `<div class="swatch-grid">${cards.join('')}</div>`
    + `<p class="showcase-hint">Click any swatch to copy its value.</p>`;
}

function renderTypeSpecimens(bodyRows) {
  const samples = { brand: 'cd', ui: 'Send files', mono: 'amber-river-42' };
  const cards = bodyRows.map((row) => {
    const cells = splitRow(row);
    const role = (cells[0] ?? '').replace(/`+/g, '').trim();
    const stack = (cells[1] ?? '').replace(/`+/g, '').trim();
    const usage = cells.slice(2).join(' | ').trim();
    const key = role.toLowerCase().includes('brand')
      ? 'brand'
      : role.toLowerCase().includes('mono') ? 'mono' : 'ui';
    return `<div class="specimen specimen-${key}">`
      + `<span class="specimen-role">${escapeHtml(role)}</span>`
      + `<span class="specimen-sample">${escapeHtml(samples[key])}</span>`
      + `<code class="specimen-stack">${escapeHtml(stack)}</code>`
      + `<span class="specimen-use">${renderInline(escapeHtml(usage))}</span>`
      + `</div>`;
  });
  return `<div class="type-grid">${cards.join('')}</div>`;
}

function renderMarkdown(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let i = 0;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${renderInline(escapeHtml(paragraph.join(' ')))}</p>`);
    paragraph = [];
  };

  const flushList = (list) => {
    if (!list) return;
    const tag = list.ordered ? 'ol' : 'ul';
    html.push(`<${tag}>${list.items.map((item) => `<li>${renderInline(escapeHtml(item))}</li>`).join('')}</${tag}>`);
  };

  let openList = null;
  const pushListItem = (ordered, text) => {
    if (!openList || openList.ordered !== ordered) {
      flushList(openList);
      openList = { ordered, items: [] };
    }
    openList.items.push(text);
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block (or live preview for ```preview fences)
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      flushList(openList);
      openList = null;
      const lang = fence[1] ?? '';
      const code = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      i += 1; // consume closing fence
      if (lang === 'preview') {
        html.push(`<div class="preview"><div class="preview-stage">${sanitizePreview(code.join('\n'))}</div>`
          + `<p class="preview-note">Live preview — rendered with the same tokens as the app.</p></div>`);
        continue;
      }
      const langClass = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      html.push(`<pre><code${langClass}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushParagraph();
      flushList(openList);
      openList = null;
      i += 1;
      continue;
    }

    // Table (header + delimiter + rows)
    if (line.includes('|') && i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      flushParagraph();
      flushList(openList);
      openList = null;
      const delimiter = lines[i + 1];
      const bodyRows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        bodyRows.push(lines[i]);
        i += 1;
      }
      html.push(renderTable(line, delimiter, bodyRows));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList(openList);
      openList = null;
      html.push(`<h${heading[1].length}>${renderInline(escapeHtml(heading[2].trim()))}</h${heading[1].length}>`);
      i += 1;
      continue;
    }

    if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) {
      flushParagraph();
      flushList(openList);
      openList = null;
      html.push('<hr />');
      i += 1;
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      flushList(openList);
      openList = null;
      const quoted = [quote[1]];
      i += 1;
      while (i < lines.length && /^>\s?(.*)$/.test(lines[i])) {
        quoted.push(/^>\s?(.*)$/.exec(lines[i])[1]);
        i += 1;
      }
      html.push(`<blockquote><p>${renderInline(escapeHtml(quoted.join(' ')))}</p></blockquote>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      pushListItem(false, bullet[1].trim());
      i += 1;
      continue;
    }

    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      pushListItem(true, ordered[1].trim());
      i += 1;
      continue;
    }

    if (openList && /^\s+\S/.test(line)) {
      openList.items[openList.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList(openList);
      openList = null;
      paragraph.push(line.trim());
    }
    i += 1;
  }

  flushParagraph();
  flushList(openList);
  return html.join('\n');
}

function plainTextTitle(markdown, fallback) {
  const match = /^#\s+(.+)$/m.exec(markdown);
  const raw = (match ? match[1] : fallback).trim();
  // Strip inline markdown so list titles read as plain text.
  return raw
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1$2');
}

function description(markdown) {
  const lines = markdown.split('\n');
  let pastTitle = false;
  const text = [];
  for (const line of lines) {
    if (!pastTitle) {
      if (/^#\s+/.test(line)) pastTitle = true;
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) break;
    if (/^\s*$/.test(line) || /^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line) || line.includes('|') || /^```/.test(line) || /^>/.test(line)) {
      if (text.length > 0) break;
      continue;
    }
    text.push(line.trim());
    if (text.join(' ').length > 200) break;
  }
  const sentence = text
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence;
}

const markdown = readFileSync(join(root, 'design.md'), 'utf8');
const docs = [
  {
    slug: 'cd-design',
    title: plainTextTitle(markdown, 'CD design'),
    description: description(markdown),
    html: renderMarkdown(markdown),
  },
];

mkdirSync(join(root, 'public', 'design'), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(docs, null, 2)}\n`);
console.log(`design: wrote ${docs.length} docs -> public/design/docs.json`);
