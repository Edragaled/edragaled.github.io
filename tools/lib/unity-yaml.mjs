// Minimal, dependency-free reader for the subset of YAML that Unity emits in
// .asset / .prefab files. A general YAML library would work too, but keeping this
// zero-dep means `node extract.mjs` runs on a clean checkout with no npm install.
//
// Handles: multi-document files (`--- !u!114 &id`), indentation-based maps and
// sequences, inline flow maps (`{fileID: 0, guid: abc, type: 3}`), flow lists,
// and Unity's double-quoted \xNN / \uNNNN escapes (used for every non-ASCII
// localization string).

import { readFileSync } from 'node:fs';

/** Unquote and unescape a scalar. Returns strings, numbers or null. */
function parseScalar(raw) {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;

  if (s.startsWith('"')) return unescapeDoubleQuoted(s);
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");

  // Unity writes plain floats/ints unquoted; keep leading-zero strings as strings.
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[-+]?\d+)?$/i.test(s)) {
    const n = Number(s);
    if (Number.isSafeInteger(n) || !Number.isInteger(n)) return n;
    return s; // 64-bit asset guids overflow double precision — keep exact digits
  }
  return s;
}

function unescapeDoubleQuoted(s) {
  const body = s.slice(1, s.endsWith('"') ? -1 : undefined);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { out += body[i]; continue; }
    const c = body[++i];
    if (c === 'x') { out += String.fromCharCode(parseInt(body.substr(i + 1, 2), 16)); i += 2; }
    else if (c === 'u') { out += String.fromCharCode(parseInt(body.substr(i + 1, 4), 16)); i += 4; }
    else if (c === 'U') { out += String.fromCodePoint(parseInt(body.substr(i + 1, 8), 16)); i += 8; }
    else if (c === 'n') out += '\n';
    else if (c === 't') out += '\t';
    else if (c === 'r') out += '\r';
    else if (c === '0') out += '\0';
    else out += c;
  }
  return out;
}

/** Split `a: 1, b: {c: 2}` respecting nesting and quotes. */
function splitFlow(body) {
  const parts = [];
  let depth = 0, quote = null, cur = '';
  for (const ch of body) {
    if (quote) {
      cur += ch;
      if (ch === quote && cur[cur.length - 2] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '{' || ch === '[') depth++;
    if (ch === '}' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts;
}

function parseFlow(text) {
  const s = text.trim();
  if (s.startsWith('{')) {
    const obj = {};
    for (const part of splitFlow(s.slice(1, -1))) {
      const i = part.indexOf(':');
      if (i === -1) continue;
      obj[part.slice(0, i).trim()] = parseFlow(part.slice(i + 1));
    }
    return obj;
  }
  if (s.startsWith('[')) return splitFlow(s.slice(1, -1)).map(parseFlow);
  return parseScalar(s);
}

const isFlow = (s) => s.startsWith('{') || s.startsWith('[');

/**
 * Rejoin YAML folded scalars. Unity wraps long quoted strings (most of
 * I2Languages) across lines; a line break inside a quoted scalar folds to a
 * single space. Without this pass the continuation lines look like stray
 * siblings and silently truncate the enclosing sequence.
 */
function unfoldLines(lines) {
  const out = [];
  let openQuote = null;
  let prevIndent = -1;
  let prevHadValue = false;

  const fold = (line) => { out[out.length - 1] += ' ' + line.trim(); };

  for (const line of lines) {
    if (openQuote) {
      fold(line);
      openQuote = trailingOpenQuote(out[out.length - 1]);
      continue;
    }
    if (prevHadValue && isPlainContinuation(line, prevIndent)) { fold(line); continue; }

    out.push(line);
    openQuote = trailingOpenQuote(line);
    prevIndent = line.length - line.trimStart().length;
    prevHadValue = hasScalarValue(line);
  }
  return out;
}

/**
 * A plain (unquoted) scalar folded onto the next line: more indented than the
 * node it continues, and not itself a mapping key, sequence entry or flow node.
 */
function isPlainContinuation(line, prevIndent) {
  if (line.trim() === '') return false;
  const indent = line.length - line.trimStart().length;
  if (indent <= prevIndent) return false;
  // `{` and `[` are *not* excluded: a folded scalar often resumes on a rich-text
  // tag or a `{[TOKEN]}` placeholder, and Unity never emits a bare flow node on
  // its own line.
  const s = line.trim();
  if (s.startsWith('-') || s.startsWith('#')) return false;
  return findKeyColon(s) === -1;
}

/** True when the line carries a scalar that could be folded onto more lines. */
function hasScalarValue(line) {
  let s = line.trim();
  if (s === '' || s.startsWith('#') || s.startsWith('---')) return false;
  while (s.startsWith('- ')) s = s.slice(2).trim();
  if (s === '' || s === '-') return false;
  const colon = findKeyColon(s);
  if (colon !== -1) s = s.slice(colon + 1).trim();
  return s !== '';
}

/**
 * Returns the quote char still open at end of `line`, or null.
 *
 * A quote only opens a scalar when it is the *first* character of the value —
 * otherwise plain scalars like `Niveau d'outil` would look like an open string
 * and swallow every following line.
 */
function trailingOpenQuote(line) {
  let s = line.trim();
  if (s === '' || s.startsWith('#')) return null;

  while (s.startsWith('- ')) s = s.slice(2).trim();
  if (s === '' || s === '-') return null;

  const colon = findKeyColon(s);
  if (colon !== -1) s = s.slice(colon + 1).trim();

  const q = s[0];
  if (q !== '"' && q !== "'") return null;
  return isQuoteClosed(s, q) ? null : q;
}

function isQuoteClosed(s, q) {
  for (let i = 1; i < s.length; i++) {
    if (q === '"') {
      if (s[i] === '\\') { i++; continue; }
      if (s[i] === '"') return true;
    } else if (s[i] === "'") {
      if (s[i + 1] === "'") { i++; continue; }
      return true;
    }
  }
  return false;
}

/**
 * Parse one Unity YAML document body (already stripped of the `--- !u!` header).
 * Returns a plain object.
 */
function parseBlock(lines, start, baseIndent) {
  const result = {};
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) { i++; continue; }

    const indent = line.length - line.trimStart().length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) { i++; continue; } // defensive: shouldn't happen

    const content = line.trim();

    // Sequence entry at this level: the parent key owns a list, so bail out and
    // let parseSequence handle it.
    if (content.startsWith('- ') || content === '-') break;

    const colon = findKeyColon(content);
    if (colon === -1) { i++; continue; }

    const key = content.slice(0, colon).replace(/^["']|["']$/g, '');
    const rest = content.slice(colon + 1).trim();

    if (rest !== '') {
      result[key] = isFlow(rest) ? parseFlow(rest) : parseScalar(rest);
      i++;
      continue;
    }

    // Empty value: look ahead for a nested block or sequence.
    const next = nextContentLine(lines, i + 1);
    if (next === -1) { result[key] = null; i++; break; }

    const nextLine = lines[next];
    const nextIndent = nextLine.length - nextLine.trimStart().length;
    const nextTrim = nextLine.trim();

    if (nextIndent > baseIndent || (nextIndent === baseIndent && nextTrim.startsWith('-'))) {
      if (nextTrim.startsWith('- ') || nextTrim === '-') {
        const [list, consumed] = parseSequence(lines, next, nextIndent);
        result[key] = list;
        i = consumed;
      } else {
        const sub = parseBlock(lines, next, nextIndent);
        result[key] = sub.value;
        i = sub.next;
      }
    } else {
      result[key] = null;
      i++;
    }
  }

  return { value: result, next: i };
}

/** Index of the `:` that terminates a key, ignoring colons inside quotes/flow. */
function findKeyColon(content) {
  let quote = null;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{' || ch === '[') return -1; // value-only flow line
    if (ch === ':' && (i + 1 === content.length || content[i + 1] === ' ')) return i;
  }
  return -1;
}

function nextContentLine(lines, from) {
  for (let i = from; i < lines.length; i++) {
    if (lines[i].trim() !== '' && !lines[i].trimStart().startsWith('#')) return i;
  }
  return -1;
}

function parseSequence(lines, start, indent) {
  const list = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }
    const curIndent = line.length - line.trimStart().length;
    if (curIndent < indent) break;
    const trimmed = line.trim();
    if (curIndent > indent || !trimmed.startsWith('-')) break;

    const inline = trimmed === '-' ? '' : trimmed.slice(1).trim();

    if (inline === '') {
      const next = nextContentLine(lines, i + 1);
      if (next === -1) { list.push(null); i++; break; }
      const nIndent = lines[next].length - lines[next].trimStart().length;
      if (nIndent > indent) {
        const sub = parseBlock(lines, next, nIndent);
        list.push(sub.value);
        i = sub.next;
      } else { list.push(null); i++; }
      continue;
    }

    if (isFlow(inline)) { list.push(parseFlow(inline)); i++; continue; }

    const colon = findKeyColon(inline);
    if (colon === -1) { list.push(parseScalar(inline)); i++; continue; }

    // `- Key: value` starts a map whose remaining keys are indented to align
    // with `Key`, i.e. indent + 2.
    const itemIndent = indent + 2;
    const rebuilt = [' '.repeat(itemIndent) + inline, ...lines.slice(i + 1)];
    const sub = parseBlock(rebuilt, 0, itemIndent);
    list.push(sub.value);
    i = i + 1 + (sub.next - 1);
  }

  return [list, i];
}

/**
 * Parse a Unity YAML file into an array of documents:
 * `[{ anchor, classId, type, body }, ...]` where `type` is the MonoBehaviour /
 * PrefabInstance / ... key and `body` is the parsed object.
 */
export function parseUnityYaml(text) {
  const lines = unfoldLines(text.split(/\r?\n/));
  const docs = [];
  let i = 0;

  // Skip %YAML / %TAG directives.
  while (i < lines.length && !lines[i].startsWith('---')) i++;

  while (i < lines.length) {
    const header = lines[i];
    if (!header.startsWith('---')) { i++; continue; }

    const m = /^---\s*(?:!u!(\d+)\s*)?&?(\d+)?/.exec(header);
    const classId = m && m[1] ? Number(m[1]) : null;
    const anchor = m && m[2] ? m[2] : null;
    i++;

    // The document's single root key, e.g. `MonoBehaviour:`.
    const typeLine = nextContentLine(lines, i);
    if (typeLine === -1) break;
    const type = lines[typeLine].trim().replace(/:$/, '');

    // Collect until the next document separator, then parse in isolation so a
    // malformed doc can't swallow the next one.
    let end = typeLine + 1;
    while (end < lines.length && !lines[end].startsWith('---')) end++;

    const bodyLines = lines.slice(typeLine + 1, end);
    const firstContent = nextContentLine(bodyLines, 0);
    let body = {};
    if (firstContent !== -1) {
      const bodyIndent = bodyLines[firstContent].length - bodyLines[firstContent].trimStart().length;
      body = parseBlock(bodyLines, firstContent, bodyIndent).value;
    }

    docs.push({ anchor, classId, type, body });
    i = end;
  }

  return docs;
}

export function readUnityYaml(path) {
  return parseUnityYaml(readFileSync(path, 'utf8'));
}

/**
 * Unity writes a serialized `List<int>` / `int[]` as one hex byte string:
 * `0a0000000f000000` is 10 then 15, little-endian.
 *
 * It has to be read from the raw text, never from a parsed document: many of
 * these strings are also valid numbers and some parse as scientific notation, so
 * the value silently becomes a float before anyone can decode it.
 */
export function intArray(hex, onWarn = () => {}, label = 'int array') {
  const text = String(hex ?? '').trim();
  if (!text) return [];
  if (!/^[0-9a-fA-F]+$/.test(text) || text.length % 8 !== 0) {
    onWarn(`${label} is not a whole number of int32s — dropped`);
    return [];
  }

  const out = [];
  for (let i = 0; i < text.length; i += 8) {
    out.push(parseInt(text.slice(i, i + 8).match(/../g).reverse().join(''), 16));
  }
  return out;
}

/** The raw text of one scalar line, for the fields `intArray` has to decode. */
export function rawField(file, field) {
  const pattern = new RegExp('^\\s*' + field + ':\\s*(\\S*)\\s*$', 'm');
  const line = pattern.exec(readFileSync(file, 'utf8'));
  return line ? line[1] : null;
}

/** Unity serializes Photon Quantum FP fixed-point numbers as RawValue/65536. */
export function fp(node) {
  if (node == null) return 0;
  const raw = typeof node === 'object' ? node.RawValue : node;
  return raw == null ? 0 : Number(raw) / 65536;
}
