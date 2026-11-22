// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A patches, JSON tool calls), finds each edit's old lines in the tree at
// the first of three matching tiers, and changes every file or none.
// Node 22, standard library only.
//
// Usage: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// When MAKEFUN_ENV_URL is set, the trial in runner.ts takes over instead.

import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A text file: its lines, its own line break, whether it ends with one. */
interface FileState {
  lines: string[];
  eol: '\n' | '\r\n';
  ends: boolean;
}

/** One body line of a hunk or chunk: context, old, new, or a `\` line. */
interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

/** One line of the replacement text: a context line (index into O) or new. */
interface NItem {
  text: string;
  ctx: number | null;
}

/** A hunk/chunk body split into the old lines O and the new lines N. */
interface BuiltBody {
  oLines: string[];
  nItems: NItem[];
  /** A `\` line follows the body's last context or `+` line. */
  noFinalBreak: boolean;
  plusCount: number;
  /** A `\` line follows the body's last `+` line. */
  lastPlusBs: boolean;
}

interface Hunk extends BuiltBody {
  startA: number;
}

interface RawChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyItem[];
}

interface V4aChunk extends BuiltBody {
  anchor: string | null;
  eof: boolean;
}

type Edit =
  | { type: 'create'; path: string; content: FileState }
  | { type: 'delete'; path: string }
  | { type: 'change'; path: string; apply: (f: FileState) => FileState | string }
  | { type: 'move'; from: string; to: string; apply: (f: FileState) => FileState | string };

type ApplyResult = { ok: true } | { ok: false; code: string; path: string };

class ParseFailure extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

// ---------------------------------------------------------------------------
// File text model
// ---------------------------------------------------------------------------

function fileFromText(text: string): FileState {
  if (text === '') return { lines: [], eol: '\n', ends: false };
  const firstLf = text.indexOf('\n');
  const eol: '\n' | '\r\n' = firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(eol);
  const ends = parts[parts.length - 1] === '';
  if (ends) parts.pop();
  return { lines: parts, eol, ends };
}

function fileToText(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.eol) + (f.ends ? f.eol : '');
}

function cloneFile(f: FileState): FileState {
  return { lines: [...f.lines], eol: f.eol, ends: f.ends };
}

/** A patch's lines: split at `\n`, one trailing `\r` removed per line, and the
 *  empty piece after a final `\n` dropped. */
function splitPatchLines(text: string): string[] {
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** The lines of a JSON `insert`'s `new_str`, by the same splitting rule. */
function splitInsertedLines(s: string): string[] {
  if (s === '') return [];
  const parts = s.split('\n');
  if (s.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// ---------------------------------------------------------------------------
// Line matching (SPEC section 5)
// ---------------------------------------------------------------------------

function stripTrailing(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function linesEqualAtTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailing(a) === stripTrailing(b);
  return stripBoth(a) === stripBoth(b);
}

/** All 0-based positions where O occurs in the file's lines at a tier. */
function findOccurrences(fileLines: string[], oLines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const k = oLines.length;
  if (k === 0) return out;
  for (let i = from; i + k <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < k; j++) {
      if (!linesEqualAtTier(fileLines[i + j], oLines[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** The first tier (0, then 1, then 2) at which O occurs at least once at or
 *  after `from`, with that tier's occurrences. */
function findTierFrom(
  fileLines: string[],
  oLines: string[],
  from: number,
  strict: boolean,
): { tier: number; occ: number[] } | null {
  for (const tier of tiersToTry(strict)) {
    const occ = findOccurrences(fileLines, oLines, tier, from);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** The first line at or after `from` equal to a single line at the first tier
 *  where one is. */
function findTierSingle(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  for (const tier of tiersToTry(strict)) {
    for (let i = from; i < lines.length; i++) {
      if (linesEqualAtTier(lines[i], anchor, tier)) return i;
    }
  }
  return null;
}

/** Split a hunk/chunk body into O (context + `-` lines) and N (context +
 *  `+` lines), remembering which N lines are context lines and whether a
 *  `\` line follows the last context/`+` line or the last `+` line. */
function splitBodyItems(body: BodyItem[]): BuiltBody {
  const oLines: string[] = [];
  const nItems: NItem[] = [];
  let oIdx = 0;
  let lastCtxOrNew = -1;
  let plusCount = 0;
  let lastPlusIdx = -1;
  for (let i = 0; i < body.length; i++) {
    const it = body[i];
    if (it.kind === 'ctx') {
      oLines.push(it.text);
      nItems.push({ text: it.text, ctx: oIdx });
      oIdx++;
      lastCtxOrNew = i;
    } else if (it.kind === 'old') {
      oLines.push(it.text);
      oIdx++;
    } else if (it.kind === 'new') {
      nItems.push({ text: it.text, ctx: null });
      lastCtxOrNew = i;
      plusCount++;
      lastPlusIdx = i;
    }
  }
  return {
    oLines,
    nItems,
    noFinalBreak: lastCtxOrNew >= 0 && body[lastCtxOrNew + 1] !== undefined && body[lastCtxOrNew + 1].kind === 'bs',
    plusCount,
    lastPlusBs: lastPlusIdx >= 0 && body[lastPlusIdx + 1] !== undefined && body[lastPlusIdx + 1].kind === 'bs',
  };
}

/** The body-line core shared by unified hunks and V4A chunks: a leading
 *  space (context), `-` (old), `+` (new), or an empty line (empty context). */
function classifyBodyLine(l: string): BodyItem | null {
  if (l.startsWith(' ')) return { kind: 'ctx', text: l.slice(1) };
  if (l.startsWith('-')) return { kind: 'old', text: l.slice(1) };
  if (l.startsWith('+')) return { kind: 'new', text: l.slice(1) };
  if (l === '') return { kind: 'ctx', text: '' };
  return null;
}

/** Drop the empty context lines at the end of a body: they are not part of it. */
function trimTrailingEmptyLines(body: BodyItem[]): void {
  while (body.length > 0) {
    const last = body[body.length - 1];
    if (last.kind === 'ctx' && last.text === '') body.pop();
    else break;
  }
}

/** Replace the k matched lines at `pos` by N. Context lines are written as
 *  the file's own matched lines; at tier 2 the other N lines are re-indented
 *  from O's first line's leading whitespace to the file's. */
function applyReplacement(
  fileLines: string[],
  pos: number,
  oLines: string[],
  nItems: NItem[],
  tier: number,
): string[] {
  const out = fileLines.slice(0, pos);
  const fLead = leadingWs(fileLines[pos] ?? '');
  const pLead = leadingWs(oLines[0] ?? '');
  for (const item of nItems) {
    if (item.ctx !== null) {
      out.push(fileLines[pos + item.ctx]);
    } else if (tier === 2 && /[^ \t]/.test(item.text) && item.text.startsWith(pLead)) {
      out.push(fLead + item.text.slice(pLead.length));
    } else {
      out.push(item.text);
    }
  }
  out.push(...fileLines.slice(pos + oLines.length));
  return out;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface RawSection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** A `--- ` / `+++ ` path: text after the four characters, up to the first
 *  tab, surrounding spaces removed; `/dev/null` means no file, a leading
 *  `a/` or `b/` is removed. */
function parseDiffPath(line: string): string | null {
  let p = line.slice(4).split('\t')[0].trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunk(lines: string[], at: number): { hunk: Hunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[at]);
  if (m === null) throw new ParseFailure(at + 1);
  const startA = Number(m[1]);
  const body: BodyItem[] = [];
  let j = at + 1;
  while (j < lines.length) {
    const l = lines[j];
    // The body ends at a `--- ` line followed by a `+++ ` line: that pair
    // starts a new section, it is not an old line of this hunk.
    if (l.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
    if (l.startsWith('\\')) {
      body.push({ kind: 'bs', text: l });
      j++;
      continue;
    }
    const item = classifyBodyLine(l);
    if (item === null) break;
    body.push(item);
    j++;
  }
  trimTrailingEmptyLines(body);
  const built = splitBodyItems(body);
  return { hunk: { startA, ...built }, next: j };
}

/** Apply a section's hunks in order, each to the result of the ones before
 *  it; returns a failure code instead of a file on a hunk failure. */
function applyUnifiedHunks(file: FileState, hunks: Hunk[], strict: boolean): FileState | string {
  let lines = [...file.lines];
  let ends = file.ends;
  let d = 0;
  for (const hunk of hunks) {
    if (hunk.oLines.length > 0) {
      const found = findTierFrom(lines, hunk.oLines, 0, strict);
      if (found === null) return 'no-match';
      const target = hunk.startA - 1 + d;
      let best = found.occ[0];
      let bestDist = Math.abs(best - target);
      for (let k = 1; k < found.occ.length; k++) {
        const dist = Math.abs(found.occ[k] - target);
        if (dist < bestDist) {
          best = found.occ[k];
          bestDist = dist;
        }
      }
      const next = applyReplacement(lines, best, hunk.oLines, hunk.nItems, found.tier);
      if (best + hunk.oLines.length === lines.length) ends = !hunk.noFinalBreak;
      lines = next;
    } else {
      const pos = Math.min(Math.max(hunk.startA + d, 0), lines.length);
      const inserted = hunk.nItems.map((it) => it.text);
      const next = [...lines.slice(0, pos), ...inserted, ...lines.slice(pos)];
      if (pos === lines.length) ends = !hunk.noFinalBreak;
      lines = next;
    }
    d += hunk.nItems.length - hunk.oLines.length;
  }
  return { lines, eol: file.eol, ends };
}

function unifiedSectionToEdit(s: RawSection, strict: boolean): Edit {
  const oldP = s.pairOld ?? s.renameOld ?? s.gitOld;
  const newP = s.pairNew ?? s.renameNew ?? s.gitNew;
  if (oldP === null || s.isCreate) {
    const plus: string[] = [];
    for (const h of s.hunks) {
      for (const it of h.nItems) {
        if (it.ctx === null) plus.push(it.text);
      }
    }
    let lastPlusBs = false;
    let hasPlus = false;
    for (let k = s.hunks.length - 1; k >= 0; k--) {
      if (s.hunks[k].plusCount > 0) {
        lastPlusBs = s.hunks[k].lastPlusBs;
        hasPlus = true;
        break;
      }
    }
    const content: FileState = { lines: plus, eol: '\n', ends: hasPlus && !lastPlusBs };
    return { type: 'create', path: newP ?? '/dev/null', content };
  }
  if (newP === null || s.isDelete) {
    return { type: 'delete', path: oldP ?? '/dev/null' };
  }
  const apply = (f: FileState): FileState | string => applyUnifiedHunks(f, s.hunks, strict);
  if (oldP !== newP) return { type: 'move', from: oldP, to: newP, apply };
  return { type: 'change', path: oldP, apply };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  let inHeader = false;
  const newSection = (gitOld: string | null, gitNew: string | null): RawSection => {
    const s: RawSection = {
      gitOld,
      gitNew,
      pairOld: null,
      pairNew: null,
      renameOld: null,
      renameNew: null,
      isCreate: false,
      isDelete: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/.exec(line);
      if (m === null) throw new ParseFailure(i + 1);
      newSection(m[1], m[2]);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const oldP = parseDiffPath(line);
      const newP = parseDiffPath(lines[i + 1]);
      if (cur !== null && inHeader) {
        if (cur.pairOld === null) {
          cur.pairOld = oldP;
          cur.pairNew = newP;
        }
      } else {
        const s = newSection(null, null);
        s.pairOld = oldP;
        s.pairNew = newP;
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new ParseFailure(i + 2);
      if (line.startsWith('@@')) {
        const parsed = parseHunk(lines, i);
        cur.hunks.push(parsed.hunk);
        i = parsed.next;
        inHeader = false;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (cur.renameOld === null) cur.renameOld = line.slice('rename from '.length);
      } else if (line.startsWith('rename to ')) {
        if (cur.renameNew === null) cur.renameNew = line.slice('rename to '.length);
      } else if (/^new file mode( |$)/.test(line)) {
        cur.isCreate = true;
      } else if (/^deleted file mode( |$)/.test(line)) {
        cur.isDelete = true;
      }
      // index, old/new mode, similarity/dissimilarity index, Index: and any
      // other header line are ignored.
      i++;
      continue;
    }
    if (cur !== null) {
      if (line.startsWith('@@')) {
        const parsed = parseHunk(lines, i);
        cur.hunks.push(parsed.hunk);
        i = parsed.next;
        continue;
      }
      // Outside bodies, lines that are not part of a section header are
      // ignored (prose, code fences).
      i++;
      continue;
    }
    if (line.startsWith('@@')) throw new ParseFailure(i + 1);
    i++;
  }
  if (sections.length === 0) throw new ParseFailure(1);
  return sections.map((s) => unifiedSectionToEdit(s, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const isSearch = (l: string): boolean => l.replace(/[ \t]+$/, '') === '<<<<<<< SEARCH';
  const isSep = (l: string): boolean => l.replace(/[ \t]+$/, '') === '=======';
  const isReplace = (l: string): boolean => l.replace(/[ \t]+$/, '') === '>>>>>>> REPLACE';
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (!isSearch(lines[i])) {
      i++;
      continue;
    }
    // The path is the nearest line before the SEARCH line, after the previous
    // block's REPLACE line, that is not blank and does not start with three
    // backticks; else the previous block's path.
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseFailure(i + 1);
    }
    let sep = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (isSep(lines[j])) {
        sep = j;
        break;
      }
      if (isSearch(lines[j]) || isReplace(lines[j])) break;
    }
    if (sep === -1) throw new ParseFailure(i + 1);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j++) {
      if (isReplace(lines[j])) {
        end = j;
        break;
      }
      if (isSearch(lines[j])) break;
    }
    if (end === -1) throw new ParseFailure(i + 1);
    blocks.push({ path, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  if (blocks.length === 0) throw new ParseFailure(1);
  return blocks.map((b) => {
    if (b.oldLines.length === 0) {
      return {
        type: 'create',
        path: b.path,
        content: { lines: [...b.newLines], eol: '\n', ends: b.newLines.length > 0 },
      } as Edit;
    }
    return {
      type: 'change',
      path: b.path,
      apply: (f: FileState): FileState | string => {
        const found = findTierFrom(f.lines, b.oldLines, 0, strict);
        if (found === null) return 'no-match';
        if (found.occ.length > 1) return 'ambiguous';
        const nItems: NItem[] = b.newLines.map((t) => ({ text: t, ctx: null }));
        return {
          lines: applyReplacement(f.lines, found.occ[0], b.oldLines, nItems, found.tier),
          eol: f.eol,
          ends: f.ends,
        };
      },
    } as Edit;
  });
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

function applyV4aChunks(file: FileState, chunks: V4aChunk[], strict: boolean): FileState | string {
  let lines = [...file.lines];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.anchor !== null && chunk.anchor !== '') {
      const found = findTierSingle(lines, chunk.anchor, cursor, strict);
      if (found === null) return 'no-match';
      cursor = found + 1;
    }
    if (chunk.oLines.length > 0) {
      const found = findTierFrom(lines, chunk.oLines, cursor, strict);
      if (found === null) return 'no-match';
      let pos: number | null = null;
      if (chunk.eof) {
        for (const p of found.occ) {
          if (p + chunk.oLines.length === lines.length) {
            pos = p;
            break;
          }
        }
        if (pos === null) return 'no-match';
      } else {
        pos = found.occ[0];
      }
      lines = applyReplacement(lines, pos, chunk.oLines, chunk.nItems, found.tier);
      cursor = pos + chunk.nItems.length;
    } else {
      const pos = chunk.eof ? lines.length : cursor;
      const inserted = chunk.nItems.map((it) => it.text);
      lines = [...lines.slice(0, pos), ...inserted, ...lines.slice(pos)];
      cursor = pos + chunk.nItems.length;
    }
  }
  return { lines, eol: file.eol, ends: file.ends };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  let first = -1;
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (lines[i].trim() !== '') {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) throw new ParseFailure(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFailure(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseFailure(n + 1);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File:')) {
      const path = line.slice('*** Add File:'.length).trim();
      i++;
      const body: string[] = [];
      while (i < last) {
        const l = lines[i];
        if (l.startsWith('+')) {
          body.push(l.slice(1));
          i++;
        } else if (l.trim() === '') {
          body.push('');
          i++;
        } else {
          break;
        }
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      edits.push({
        type: 'create',
        path,
        content: { lines: body, eol: '\n', ends: body.length > 0 },
      });
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      const path = line.slice('*** Delete File:'.length).trim();
      edits.push({ type: 'delete', path });
      i++;
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      const path = line.slice('*** Update File:'.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i].startsWith('*** Move to:')) {
        moveTo = lines[i].slice('*** Move to:'.length).trim();
        i++;
      }
      const rawChunks: RawChunk[] = [];
      let cur: RawChunk | null = null;
      let firstChunk = true;
      const closeChunk = (): void => {
        if (cur !== null) {
          rawChunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const l = lines[i];
        if (l.startsWith('@@')) {
          closeChunk();
          cur = { anchor: l.slice(2).trim(), eof: false, body: [] };
          firstChunk = false;
          i++;
          continue;
        }
        if (l.replace(/[ \t]+$/, '') === '*** End of File') {
          if (cur === null) throw new ParseFailure(i + 1);
          cur.eof = true;
          closeChunk();
          firstChunk = false;
          i++;
          continue;
        }
        if (isSectionStart(l)) break;
        const item = classifyBodyLine(l);
        if (item !== null) {
          if (cur === null) {
            if (!firstChunk) {
              // A blank line after an end-of-file chunk is an ignored
              // separator; any other body line here starts no chunk.
              if (l.trim() === '') {
                i++;
                continue;
              }
              throw new ParseFailure(i + 1);
            }
            cur = { anchor: null, eof: false, body: [] };
            firstChunk = false;
          }
          cur.body.push(item);
          i++;
          continue;
        }
        throw new ParseFailure(i + 1);
      }
      closeChunk();
      // Blank lines at the end of a section are not part of it.
      if (rawChunks.length > 0) {
        trimTrailingEmptyLines(rawChunks[rawChunks.length - 1].body);
      }
      if (rawChunks.length === 0 && moveTo === null) throw new ParseFailure(updateLine);
      const chunks: V4aChunk[] = rawChunks.map((c) => ({ anchor: c.anchor, eof: c.eof, ...splitBodyItems(c.body) }));
      const apply = (f: FileState): FileState | string => applyV4aChunks(f, chunks, strict);
      if (moveTo !== null) edits.push({ type: 'move', from: path, to: moveTo, apply });
      else edits.push({ type: 'change', path, apply });
      continue;
    }
    throw new ParseFailure(i + 1);
  }
  if (edits.length === 0) throw new ParseFailure(1);
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

function jsonStrReplaceEdit(path: string, oldStr: string, newStr: string): Edit {
  return {
    type: 'change',
    path,
    apply: (f: FileState): FileState | string => {
      let text = fileToText(f);
      let oldS = oldStr;
      let newS = newStr;
      const crlf = f.eol === '\r\n';
      if (crlf) {
        text = text.replace(/\r\n/g, '\n');
        oldS = oldS.replace(/\r\n/g, '\n');
        newS = newS.replace(/\r\n/g, '\n');
      }
      let count = 0;
      let first = -1;
      let pos = 0;
      for (;;) {
        const j = text.indexOf(oldS, pos);
        if (j === -1) break;
        count++;
        if (first === -1) first = j;
        pos = j + 1;
      }
      if (count === 0) return 'no-match';
      if (count > 1) return 'ambiguous';
      const out = text.slice(0, first) + newS + text.slice(first + oldS.length);
      return fileFromText(crlf ? out.replace(/\n/g, '\r\n') : out);
    },
  };
}

function jsonInsertEdit(path: string, insertLine: number, newStr: string): Edit {
  return {
    type: 'change',
    path,
    apply: (f: FileState): FileState | string => {
      if (insertLine < 0 || insertLine > f.lines.length) return 'no-match';
      const added = splitInsertedLines(newStr);
      return {
        lines: [...f.lines.slice(0, insertLine), ...added, ...f.lines.slice(insertLine)],
        eol: f.eol,
        ends: f.ends,
      };
    },
  };
}

function jsonObjectToEdit(obj: unknown): Edit | null {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const path = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { type: 'create', path, content: fileFromText(o.file_text) };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return jsonStrReplaceEdit(path, o.old_str, (o.new_str as string | undefined) ?? '');
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return jsonInsertEdit(path, o.insert_line, o.new_str);
  }
  return null;
}

function parseJson(lines: string[], text: string): Edit[] {
  const firstIdx = lines.findIndex((l) => l.trim() !== '');
  if (firstIdx === -1) throw new ParseFailure(1);
  const firstNonWs = lines[firstIdx].trimStart()[0];
  if (firstNonWs === '[') {
    // One JSON array of edit objects; any fault is at the line where the
    // array starts.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseFailure(firstIdx + 1);
    }
    if (!Array.isArray(parsed)) throw new ParseFailure(firstIdx + 1);
    const edits: Edit[] = [];
    for (const el of parsed) {
      const e = jsonObjectToEdit(el);
      if (e === null) throw new ParseFailure(firstIdx + 1);
      edits.push(e);
    }
    if (edits.length === 0) throw new ParseFailure(1);
    return edits;
  }
  // JSON Lines: one edit object a line, blank lines ignored.
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new ParseFailure(i + 1);
    }
    const e = jsonObjectToEdit(obj);
    if (e === null) throw new ParseFailure(i + 1);
    edits.push(e);
  }
  if (edits.length === 0) throw new ParseFailure(1);
  return edits;
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4) and patch parsing
// ---------------------------------------------------------------------------

function detectFormat(lines: string[]): string | null {
  const firstNonBlank = lines.find((l) => l.trim() !== '');
  if (firstNonBlank === undefined) return null;
  if (firstNonBlank.trim() === '*** Begin Patch') return 'v4a';
  const firstChar = firstNonBlank.trimStart()[0];
  if (firstChar === '[' || firstChar === '{') return 'json';
  for (const l of lines) {
    if (l.replace(/[ \t]+$/, '') === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

function parsePatch(format: string, lines: string[], text: string, strict: boolean): Edit[] {
  if (format === 'unified') return parseUnified(lines, strict);
  if (format === 'search-replace') return parseSearchReplace(lines, strict);
  if (format === 'v4a') return parseV4a(lines, strict);
  return parseJson(lines, text);
}

// ---------------------------------------------------------------------------
// Paths, the tree, and applying edits (SPEC sections 3 and 10)
// ---------------------------------------------------------------------------

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function editPaths(edit: Edit): string[] {
  if (edit.type === 'create' || edit.type === 'delete' || edit.type === 'change') return [edit.path];
  return [edit.from, edit.to];
}

/** Apply one edit to the in-memory tree; a failed edit changes nothing. */
function applyEdit(tree: Map<string, FileState>, edit: Edit, moves: [string, string][]): ApplyResult {
  for (const p of editPaths(edit)) {
    if (!isSafePath(p)) return { ok: false, code: 'unsafe', path: p };
  }
  if (edit.type === 'create') {
    if (tree.has(edit.path)) return { ok: false, code: 'exists', path: edit.path };
    tree.set(edit.path, cloneFile(edit.content));
    return { ok: true };
  }
  if (edit.type === 'delete') {
    if (!tree.has(edit.path)) return { ok: false, code: 'missing', path: edit.path };
    tree.delete(edit.path);
    return { ok: true };
  }
  if (edit.type === 'change') {
    const cur = tree.get(edit.path);
    if (cur === undefined) return { ok: false, code: 'missing', path: edit.path };
    const res = edit.apply(cloneFile(cur));
    if (typeof res === 'string') return { ok: false, code: res, path: edit.path };
    tree.set(edit.path, res);
    return { ok: true };
  }
  const cur = tree.get(edit.from);
  if (cur === undefined) return { ok: false, code: 'missing', path: edit.from };
  if (tree.has(edit.to)) return { ok: false, code: 'exists', path: edit.to };
  const res = edit.apply(cloneFile(cur));
  if (typeof res === 'string') return { ok: false, code: res, path: edit.from };
  tree.delete(edit.from);
  tree.set(edit.to, res);
  moves.push([edit.from, edit.to]);
  return { ok: true };
}

function readTree(dir: string): Map<string, FileState> {
  const out = new Map<string, FileState>();
  const walk = (d: string, prefix: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p, `${prefix}${name}/`);
      else if (st.isFile()) {
        try {
          out.set(`${prefix}${name}`, fileFromText(readFileSync(p, 'utf8')));
        } catch {
          // An unreadable file is left out of the tree.
        }
      }
    }
  };
  walk(dir, '');
  return out;
}

function writeTree(original: Map<string, FileState>, finalTree: Map<string, FileState>): void {
  for (const p of original.keys()) {
    if (!finalTree.has(p)) rmSync(p, { force: true });
  }
  for (const [p, f] of finalTree) {
    const o = original.get(p);
    if (o === undefined || fileToText(o) !== fileToText(f)) {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, fileToText(f), 'utf8');
    }
  }
}

function byteOrder(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The exit-0 report lines for the change from the original tree to the
 *  final one, in byte order of the paths (an `R` line sorts by its new path). */
function computeOutput(
  original: Map<string, FileState>,
  finalTree: Map<string, FileState>,
  moves: [string, string][],
): string[] {
  const keyed: { key: string; text: string }[] = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (original.has(oldP) && !finalTree.has(oldP) && !original.has(newP) && finalTree.has(newP)) {
      keyed.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      usedOld.add(oldP);
      usedNew.add(newP);
    }
  }
  const allPaths = new Set<string>([...original.keys(), ...finalTree.keys()]);
  for (const p of allPaths) {
    const o = original.get(p);
    const f = finalTree.get(p);
    if (o !== undefined && f === undefined) {
      if (!usedOld.has(p)) keyed.push({ key: p, text: `D ${p}` });
    } else if (o === undefined && f !== undefined) {
      if (!usedNew.has(p)) keyed.push({ key: p, text: `A ${p}` });
    } else if (o !== undefined && f !== undefined) {
      if (fileToText(o) !== fileToText(f)) keyed.push({ key: p, text: `M ${p}` });
    }
  }
  keyed.sort((a, b) => byteOrder(a.key, b.key));
  return keyed.map((k) => k.text);
}

// ---------------------------------------------------------------------------
// Command line (SPEC sections 1 and 2)
// ---------------------------------------------------------------------------

interface CliArgs {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): CliArgs | null {
  let format = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let noMoreOptions = false;
  const positional: string[] = [];
  for (const arg of argv) {
    if (!noMoreOptions && arg === '--') {
      noMoreOptions = true;
      continue;
    }
    if (!noMoreOptions && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (seenCheck) return null;
        seenCheck = true;
        check = true;
      } else if (arg === '--strict') {
        if (seenStrict) return null;
        seenStrict = true;
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seenFormat) return null;
        seenFormat = true;
        const v = arg.slice('--format='.length);
        if (v !== 'auto' && v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json') return null;
        format = v;
      } else {
        return null;
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) return null;
  return { format, check, strict, patch: positional[0] ?? null };
}

function runCli(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args === null) {
    process.stdout.write('error: usage\n');
    process.exitCode = 2;
    return;
  }
  let patchText: string;
  if (args.patch === null || args.patch === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(args.patch, 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      process.exitCode = 2;
      return;
    }
  }
  const patchLines = splitPatchLines(patchText);
  let format = args.format;
  if (format === 'auto') {
    const detected = detectFormat(patchLines);
    if (detected === null) {
      process.stdout.write('error: format\n');
      process.exitCode = 2;
      return;
    }
    format = detected;
  }
  let edits: Edit[];
  try {
    edits = parsePatch(format, patchLines, patchText, args.strict);
  } catch (err) {
    if (err instanceof ParseFailure) {
      process.stdout.write(`error: parse ${err.line}\n`);
      process.exitCode = 2;
      return;
    }
    throw err;
  }
  const original = readTree('.');
  const tree = new Map<string, FileState>();
  for (const [p, f] of original) tree.set(p, cloneFile(f));
  const failures: { code: string; path: string }[] = [];
  const moves: [string, string][] = [];
  for (const edit of edits) {
    const res = applyEdit(tree, edit, moves);
    if (!res.ok) failures.push(res);
  }
  if (failures.length > 0) {
    const out: string[] = failures.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${failures.length} of ${edits.length} edits`);
    process.stdout.write(`${out.join('\n')}\n`);
    process.exitCode = 1;
    return;
  }
  const changed = computeOutput(original, tree, moves);
  if (!args.check) writeTree(original, tree);
  const n = changed.length;
  const out = [...changed, `ok: ${n} file${n === 1 ? '' : 's'}`];
  process.stdout.write(`${out.join('\n')}\n`);
  process.exitCode = 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (process.env.MAKEFUN_ENV_URL) {
  const { runTrial } = await import('./runner.ts');
  await runTrial(process.env.MAKEFUN_ENV_URL);
} else {
  runCli();
}
