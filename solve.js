// Candidate A: tight re-implementation of makefun-site 1.0.0.
// Same pipeline, same outputs, faster primitives: bulk-escape inline renderer,
// single-pass Markdown (no token objects), front matter without splitting the body,
// ASCII fast-path slugify, word counting without regex match.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
export function escapeHtml(s) {
  if (!ESC_TEST.test(s)) return s;
  return s.replace(ESC_RE, (c) => ESCAPES[c]);
}

export const SLUG_MAX = 64;

// Per-build memo for slugify (titles/tags repeat a lot); reset in build().
let slugCache = new Map();
export function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 127) { ascii = false; break; }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  // NOTE: non-ASCII path iterates code units, not code points; combining marks were
  // removed by the regex, and the remaining chars are all in the BMP ranges the
  // reference iterates as code points. Surrogate pairs (astral chars) are not
  // a-z/A-Z/0-9, so they only set gap -- identical outcome either way.
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const res = out === '' ? 'untitled' : out;
  slugCache.set(text, res);
  return res;
}

export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
let dateCache = new Map();
export function longDate(date) {
  let hit = dateCache.get(date);
  if (hit === undefined) {
    const y = date.slice(0, 4), m = date.slice(5, 7), d = date.slice(8, 10);
    hit = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
    dateCache.set(date, hit);
  }
  return hit;
}

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** Count runs of non-whitespace, exactly /\S+/g's count, without allocating. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279]) WS_TABLE[c] = 1;
/** Count runs of non-whitespace, exactly /\S+/g's count, without allocating. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)]) { inWord = false; continue; }
    if (!inWord) { n++; inWord = true; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUGRE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAGRE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAGRE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUGRE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

export function parseFrontMatter(text) {
  // First line must be exactly '---'.
  if (text.length < 3 || text[0] !== '-' || text[1] !== '-' || text[2] !== '-' || (text.length > 3 && text[3] !== '\n')) {
    return { error: 'no front matter' };
  }
  if (text.length === 3) return { error: 'the front matter is not closed' };
  // Find the closing '---' line first (reference reports 'not closed' before line errors).
  let closeStart = -1; // index of the start of the closing line
  let closeEnd = -1;   // index just past its '\n' (or text.length)
  let p = 4;
  while (p <= text.length) {
    const nl = text.indexOf('\n', p);
    const lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd - p === 3 && text[p] === '-' && text[p + 1] === '-' && text[p + 2] === '-') {
      closeStart = p;
      closeEnd = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    p = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 1; // 1-based, counting from the opening '---' as line 1
  p = 4;
  while (p < closeStart) {
    lineNo++;
    const nl = text.indexOf('\n', p);
    const lineEnd = nl === -1 ? closeStart : nl;
    const line = text.slice(p, lineEnd);
    // blank (spaces/tabs) or comment
    let blank = true;
    for (let i = 0; i < line.length; i++) { const c = line.charCodeAt(i); if (c !== 32 && c !== 9) { blank = false; break; } }
    if (!blank && line.charCodeAt(0) !== 35) {
      const m = LINE.exec(line);
      if (!m) return { error: `line ${lineNo} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    p = nl === -1 ? closeStart : nl + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- Markdown
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const BLANKRE = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}
function isBlank(line) {
  for (let k = 0; k < line.length; k++) { const c = line.charCodeAt(k); if (c !== 32 && c !== 9) return false; }
  return true;
}
function endsParagraph(line) {
  if (line === '') return true;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return FENCE_OPEN.test(line);
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return HR.test(line);
  return false;
}
const trimLine = (line) => {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
};

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

/**
 * Inline rendering. Plain runs are flushed verbatim (the scanner only stops at
 * constructs or at one of &<>"', so a flushed run can hold none of those).
 */
export function inline(s, env) {
  const RE = /[\\`*\[&<>"']/g;
  let out = '';
  let start = 0;
  let m;
  while ((m = RE.exec(s)) !== null) {
    const i = m.index;
    const c = m[0];
    if (c === '\\') {
      if (i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
        if (i > start) out += s.slice(start, i);
        out += s[i + 1];
        RE.lastIndex = i + 2;
        start = i + 2;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > start) out += s.slice(start, i);
        out += '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>';
        RE.lastIndex = j + 1;
        start = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > start) out += s.slice(start, i);
          out += '<strong>' + inline(s.slice(i + 2, j), env) + '</strong>';
          RE.lastIndex = j + 2;
          start = j + 2;
        } else RE.lastIndex = i + 2;
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > start) out += s.slice(start, i);
        out += '<em>' + inline(s.slice(i + 1, j), env) + '</em>';
        RE.lastIndex = j + 1;
        start = j + 1;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        if (i > start) out += s.slice(start, i);
        out += '<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(i + 1, k), env) + '</a>';
        RE.lastIndex = mm + 1;
        start = mm + 1;
      }
      continue;
    }
    if (i > start) out += s.slice(start, i);
    out += ESCAPES[c];
    RE.lastIndex = i + 1;
    start = i + 1;
  }
  if (out === '') return s;
  if (s.length > start) out += s.slice(start);
  return out;
}

/** Single-pass Markdown render: lines in, HTML/toc/excerpt out. */
export function renderMarkdown(src, env, ids) {
  const lines = src.split('\n');
  ids = ids ?? new Set();
  ids.clear();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const N = lines.length;
  while (i < N) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    if (line === '') { i++; continue; }
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) { i++; continue; }
      // indented non-blank line: paragraph (fall through)
    } else if (c0 === 96) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const lang = fence[1];
        const cls = lang === '' ? '' : ' class="language-' + escapeHtml(lang) + '"';
        let bodyText = '';
        i++;
        while (i < N && !FENCE_CLOSE.test(lines[i])) { bodyText += lines[i] + '\n'; i++; }
        i++;
        blocks.push('<pre><code' + cls + '>' + escapeHtml(bodyText) + '</code></pre>');
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        const html = inline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (HR.test(line)) { blocks.push('<hr>'); i++; continue; }
    } else if (c0 === 62) {
      const body = [];
      while (i < N && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        body.push(l.startsWith('> ') ? l.slice(2) : l.slice(1));
        i++;
      }
      const kept = [];
      for (const l of body) { const t = trimLine(l); if (t !== '') kept.push(t); }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : '<blockquote>\n<p>' + inline(kept.join('\n'), env) + '</p>\n</blockquote>');
      continue;
    }
    if (c0 === 45 || c0 === 42 || (c0 >= 48 && c0 <= 57)) {
      const bullet = BULLET.exec(line);
      const ordered = bullet === null ? ORDERED.exec(line) : null;
      if (bullet !== null || ordered !== null) {
        const isOrdered = ordered !== null;
        const marker = isOrdered ? ORDERED : BULLET;
        const items = [];
        while (i < N) {
          const m = marker.exec(lines[i]);
          if (m !== null) {
            items.push(trimLine(isOrdered ? m[2] : m[1]));
            i++;
          } else if (CONTINUED.test(lines[i])) {
            items[items.length - 1] += '\n' + trimLine(lines[i]);
            i++;
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && Number(ordered[1]) !== 1 ? `<ol start="${Number(ordered[1])}">` : `<${tag}>`;
        let chunk = open + '\n';
        for (const item of items) chunk += '<li>' + inline(item, env) + '</li>\n';
        chunk += `</${tag}>`;
        blocks.push(chunk);
        continue;
      }
    }
    const body = [trimLine(line)];
    i++;
    while (i < N && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const html = inline(text, env);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  return { html: blocks.length === 0 ? '' : blocks.join('\n') + '\n', toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates
export class TemplateError extends Error {}

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;
export const INCLUDE_DEPTH = 8;

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

// Template code generation: each parsed template compiles once per build into a
// function (V, L, d, H, FNS). V is the top-level vars object (null-prototype),
// L the current loop bindings (null-prototype, mutated by for-loops via copy-on-write
// of the object itself), d the include depth. Lookup semantics mirror the reference:
// first name from the innermost scope holding it, then own properties only.
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let i = 0; i < v.length; i++) { if (i > 0) s += ', '; s += textOf(v[i]); }
    return s;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

export const H = {
  E: escapeHtml,
  T: textOf,
  V: (v) => (typeof v === 'string' ? escapeHtml(v) : escapeHtml(textOf(v))),
  F: truthy,
  R: (L, V, k) => (Object.hasOwn(L, k) ? L[k] : V[k]),
  G1: (v, k1) => (v === null || typeof v !== 'object' || !Object.hasOwn(v, k1) ? undefined : v[k1]),
  G2: (v, k1, k2) => {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, k1)) return undefined;
    v = v[k1];
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, k2)) return undefined;
    return v[k2];
  },
  G3: (v, k1, k2, k3) => {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, k1)) return undefined;
    v = v[k1];
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, k2)) return undefined;
    v = v[k2];
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, k3)) return undefined;
    return v[k3];
  },
};

function pathExpr(path, bound) {
  const first = path[0];
  let expr = bound.has(first) ? `L.${first}` : `R(L,V,${JSON.stringify(first)})`;
  const rest = path.slice(1);
  for (let k = 0; k < rest.length;) {
    if (rest.length - k >= 3) { expr = `G3(${expr},${JSON.stringify(rest[k])},${JSON.stringify(rest[k + 1])},${JSON.stringify(rest[k + 2])})`; k += 3; }
    else if (rest.length - k === 2) { expr = `G2(${expr},${JSON.stringify(rest[k])},${JSON.stringify(rest[k + 1])})`; k += 2; }
    else { expr = `G1(${expr},${JSON.stringify(rest[k])})`; k += 1; }
  }
  return expr;
}

function genNodes(nodes, bound, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(`_o+=${JSON.stringify(n.text)};`);
        break;
      case 'var':
        out.push(`_o+=VV(${pathExpr(n.path, bound)});`);
        break;
      case 'raw':
        out.push(`_o+=T(${pathExpr(n.path, bound)});`);
        break;
      case 'if': {
        const cond = `F(${pathExpr(n.path, bound)})`;
        out.push(n.not ? `if(!${cond}){` : `if(${cond}){`);
        genNodes(n.then, bound, out);
        if (n.else !== null) { out.push('}else{'); genNodes(n.else, bound, out); }
        out.push('}');
        break;
      }
      case 'for': {
        out.push(`{const _xs=${pathExpr(n.path, bound)};if(Array.isArray(_xs)){const _pL=L;L=Object.assign(Object.create(null),L);for(let _i=0,_n=_xs.length;_i<_n;_i++){L.${n.name}=_xs[_i];L.loop={index:_i+1,first:_i===0,last:_i===_n-1,length:_n};`);
        const inner = new Set(bound);
        inner.add(n.name);
        inner.add('loop');
        genNodes(n.body, inner, out);
        out.push('}L=_pL;}}');
        break;
      }
      case 'include':
        out.push(`if(d<8){const _f=FNS.get(${JSON.stringify(n.name)});if(_f!==undefined)_o+=_f(V,L,d+1,H,FNS);}`);
        break;
    }
  }
}

export function compileTemplate(nodes) {
  const code = ['"use strict";const E=H.E,T=H.T,VV=H.V,F=H.F,R=H.R,G1=H.G1,G2=H.G2,G3=H.G3;let _o="";'];
  genNodes(nodes, new Set(), code);
  code.push('return _o;');
  return new Function('V', 'L', 'd', 'H', 'FNS', code.join('\n'));
}

// ---------------------------------------------------------------- build
export const REPORT_FILE = 'build-report.txt';
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

export function build(input) {
  slugCache = new Map();
  dateCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. sources
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. front matter
  {
    const kept = [];
    for (const s of b.sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) { b.report.push(`refused ${s.path}: ${fm.error}`); continue; }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
      if (own !== undefined) { b.report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
      if (s.post && !Object.hasOwn(s.data, 'date')) { b.report.push(`refused ${s.path}: a post needs a date`); continue; }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!b.templates.has(layout)) { b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
      s.layout = layout;
      if (s.data.draft === true) { b.report.push(`draft ${s.path}`); continue; }
      kept.push(s);
    }
    b.sources = kept;
  }

  // 3. permalinks
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of b.sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${b.base}/${s.outDir}/`;
      b.bySource.set(s.path, s);
    }
  }

  // 4. markdown
  {
    const staticPaths = new Set(b.statics.map((f) => f.path));
    const resolveCache = new Map();
    const ids = new Set();
    let curDir = '';
    let curSrc = '';
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(curDir, rel);
      if (path !== null) {
        const pg = b.bySource.get(path);
        if (pg !== undefined) return `${pg.url}${frag}`;
      }
      if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
      b.broken.add(`broken-link ${curSrc} -> ${target}`);
      return target;
    };
    const env = { link };
    for (const s of b.sources) {
      curDir = dirOf(s.path);
      curSrc = s.path;
      const md = renderMarkdown(s.body, env, ids);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. collections
  {
    const posts = b.sources.filter((s) => s.post);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    b.posts = posts;
    posts.forEach((p, k) => {
      p.newer = k === 0 ? null : posts[k - 1];
      p.older = k === posts.length - 1 ? null : posts[k + 1];
    });
  }

  // 6. tags
  {
    const bySlug = new Map();
    const ownTags = (s) => {
      const seen = new Set();
      const out = [];
      for (const name of (s.data.tags ?? [])) {
        const sl = slugify(name);
        if (!seen.has(sl)) { seen.add(sl); out.push(name); }
      }
      return out;
    };
    for (const p of b.posts) {
      p.tagRefs = [];
      for (const name of ownTags(p)) {
        const slug = slugify(name);
        if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [], card: { name, slug, url: `${b.base}/tags/${slug}/` } });
        const tag = bySlug.get(slug);
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    const noPostTag = new Map();
    for (const s of b.sources) if (!s.post) s.tagRefs = ownTags(s).map((name) => {
      const t = bySlug.get(slugify(name));
      if (t !== undefined) return t;
      let f = noPostTag.get(name);
      if (f === undefined) {
        const slug = slugify(name);
        f = { name, slug, url: '', posts: [], card: { name, slug, url: '' } };
        noPostTag.set(name, f);
      }
      return f;
    });
    b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  const linkCache = new Map();
  const linkOf = (s) => {
    if (s === null) return null;
    let l = linkCache.get(s);
    if (l === undefined) {
      l = { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
      linkCache.set(s, l);
    }
    return l;
  };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => t.card),
  });
  const pageOf = (s) => {
    const card = s.post ? b.cards.get(s) : cardOf(s);
    return {
      ...card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };

  // 7. layouts
  {
    b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
    const site = { title: b.input.site.title, base_url: b.base };
    const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
    const compiled = new Map();
    for (const [name, nodes] of b.templates) compiled.set(name, compileTemplate(nodes));
    // One vars object per render shape, mutated in place: a page render only ever
    // sets .page, an index render .posts/.pager, a tag render .tag. No stale keys:
    // each shape's keys are fixed, and compiled templates never write V.
    const Vpage = Object.assign(Object.create(null), { site, tags: allTags, recent });
    const Vindex = Object.assign(Object.create(null), { site, tags: allTags, recent });
    const Vtag = Object.assign(Object.create(null), { site, tags: allTags, recent });
    const Vtags = Object.assign(Object.create(null), { site, tags: allTags, recent });
    const L0 = Object.create(null); // empty loop scope; for-loops copy it, never mutate it
    const renderV = (name, V) => {
      const fn = compiled.get(name);
      if (fn === undefined) return null;
      return fn(V, L0, 0, H, compiled);
    };
    for (const s of b.sources) { Vpage.page = pageOf(s); b.output[`${s.outDir}/index.html`] = renderV(s.layout, Vpage); }
    const per = b.input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      Vindex.posts = b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p));
      Vindex.pager = { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) };
      const html = renderV('index', Vindex);
      if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
    for (const t of b.tags) {
      Vtag.tag = tagOf(t);
      const html = renderV('tag', Vtag);
      if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = renderV('tags', Vtags);
    if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
    for (const f of b.statics) {
      if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
      else b.output[f.path] = f.content;
    }
  }

  // 8. report
  {
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    const pages = b.sources.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
    b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  }
  return b.output;
}

export function run(input) {
  return build(input);
}
