// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// It reads a patch in one of four formats (unified diffs with wrong line numbers, SEARCH/REPLACE blocks, V4A
// patches and JSON tool calls), finds the lines each edit names at the first of three matching tiers, and writes
// every change or none. SPEC.md is the whole contract.
//
// Sections 1 to 4, 9 and 10 (the command line, the output and exit codes, safe paths, format detection, JSON edits
// and the all-or-nothing write) are implemented below; sections 5 to 8 (three-tier matching, unified diffs,
// SEARCH/REPLACE blocks and V4A patches) are implemented in the middle of this file. The last lines hand a trial
// over to runner.ts when MAKEFUN_ENV_URL is set: keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, in the order the edits ran. */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Files as lines (SPEC.md section 3) and three-tier matching (section 5).
// ---------------------------------------------------------------------------

interface FileState {
  br: '\r\n' | '\n';
  lines: string[];
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { br, lines, final };
}

function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A line as a tier sees it: tier 0 exact, tier 1 without trailing spaces/tabs, tier 2 without either end. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrencesAt(o: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j]!, tier) !== normLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/**
 * The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at least once at or after
 * `from`, with every occurrence at that tier. When `eofOnly`, only occurrences ending at the file's last
 * line count. Null when O occurs at no tier.
 */
function findTier(
  o: string[],
  lines: string[],
  from: number,
  strict: boolean,
  eofOnly: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let occ = occurrencesAt(o, lines, t, from);
    if (eofOnly) occ = occ.filter((i) => i + o.length === lines.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface NewItem {
  text: string;
  /** True for a context line: written as the file's own matched line, never the patch's. */
  ctx: boolean;
  /** For a context line, its index inside O. */
  oIdx: number;
}

/**
 * The replacement lines N for a match of O at position `at` in the file's lines. Context lines come from
 * the file; at tier 2 every other non-empty, non-whitespace line that starts with P (the leading spaces
 * and tabs of O's first line) has that P replaced by F (those of the file's first matched line).
 */
function buildNewLines(n: NewItem[], o: string[], fileLines: string[], at: number, tier: number): string[] {
  const out: string[] = [];
  const p = o.length > 0 ? leadingWs(o[0]!) : '';
  const f = fileLines.length > at ? leadingWs(fileLines[at]!) : '';
  for (const item of n) {
    if (item.ctx) {
      out.push(fileLines[at + item.oIdx]!);
      continue;
    }
    let t = item.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** The last body item that is a context or `+` line, or null when the hunk has none. */
function lastCtxOrNew(items: BodyItem[]): BodyItem | null {
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]!;
    if (it.kind === 'ctx' || it.kind === 'new') return it;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6).
// ---------------------------------------------------------------------------

interface BodyItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line follows this body line: the file does not end with a line break here. */
  noNL: boolean;
}

interface Hunk {
  /** A: the 1-based old start line of the hunk header. */
  a: number;
  items: BodyItem[];
}

interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const diffRe = /^diff --git a\/(.+) b\/(.+)$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const stripPrefix = (p: string): string => (p.startsWith('a/') ? p.slice(2) : p.startsWith('b/') ? p.slice(2) : p);
  const headerPath = (line: string): string => {
    let t = line.slice(4);
    const tab = t.indexOf('\t');
    if (tab >= 0) t = t.slice(0, tab);
    return t.trim();
  };
  const devNull = (p: string): string | null => (p === '/dev/null' ? null : stripPrefix(p));

  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let seenPair = false;
  let inHeader = false;
  let i = 0;

  const openSection = (oldPath: string | null, newPath: string | null, pairSeen: boolean): void => {
    cur = { oldPath, newPath, create: false, del: false, hunks: [] };
    sections.push(cur);
    seenPair = pairSeen;
    inHeader = true;
  };

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      openSection(m[1]!, m[2]!, false);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkRe.exec(line);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1]!, 10), items: [] };
      i++;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          if (bl.startsWith('\\')) {
            if (hunk.items.length > 0) hunk.items[hunk.items.length - 1]!.noNL = true;
          } else if (bl === '') {
            hunk.items.push({ kind: 'ctx', text: '', noNL: false });
          } else if (bl.startsWith(' ')) {
            hunk.items.push({ kind: 'ctx', text: bl.slice(1), noNL: false });
          } else if (bl.startsWith('-')) {
            hunk.items.push({ kind: 'old', text: bl.slice(1), noNL: false });
          } else {
            hunk.items.push({ kind: 'new', text: bl.slice(1), noNL: false });
          }
          i++;
        } else {
          break;
        }
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.items.length > 0) {
        const last = hunk.items[hunk.items.length - 1]!;
        if (last.kind === 'ctx' && last.text === '') hunk.items.pop();
        else break;
      }
      cur.hunks.push(hunk);
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (!seenPair) {
            cur.oldPath = devNull(headerPath(line));
            cur.newPath = devNull(headerPath(lines[i + 1]!));
            seenPair = true;
            i += 2;
            continue;
          }
          // A second pair before the first hunk starts a new section.
          openSection(devNull(headerPath(line)), devNull(headerPath(lines[i + 1]!)), true);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('rename from ')) {
        if (!seenPair) cur.oldPath = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!seenPair) cur.newPath = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      // index, old mode, new mode, similarity index, dissimilarity index, Index: and any other line.
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      openSection(devNull(headerPath(line)), devNull(headerPath(lines[i + 1]!)), true);
      i += 2;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i++;
  }

  return sections.map((s) => uniEdit(s, strict));
}

/** Apply a section's hunks in order to a file state, each to the result of the ones before it. */
function applyHunks(state: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  let d = 0;
  for (const h of hunks) {
    const o: string[] = [];
    const n: NewItem[] = [];
    let oIdx = 0;
    for (const it of h.items) {
      if (it.kind === 'ctx') {
        o.push(it.text);
        n.push({ text: it.text, ctx: true, oIdx });
        oIdx++;
      } else if (it.kind === 'old') {
        o.push(it.text);
        oIdx++;
      } else {
        n.push({ text: it.text, ctx: false, oIdx: -1 });
      }
    }
    const last = lastCtxOrNew(h.items);
    if (o.length === 0) {
      const idx = Math.min(Math.max(h.a + d, 0), state.lines.length);
      const nTexts = n.map((x) => x.text);
      const lines = [...state.lines.slice(0, idx), ...nTexts, ...state.lines.slice(idx)];
      const touchesEnd = idx === state.lines.length;
      const final = touchesEnd ? !(last?.noNL ?? false) : state.final;
      state = { br: state.br, lines, final };
      d += nTexts.length;
      continue;
    }
    const found = findTier(o, state.lines, 0, strict, false);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const pos of found.occ) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const nTexts = buildNewLines(n, o, state.lines, best, found.tier);
    const lines = [...state.lines.slice(0, best), ...nTexts, ...state.lines.slice(best + o.length)];
    const touchesEnd = best + o.length === state.lines.length;
    const final = touchesEnd ? !(last?.noNL ?? false) : state.final;
    state = { br: state.br, lines, final };
    d += nTexts.length - o.length;
  }
  return state;
}

function uniEdit(section: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = section.oldPath;
    const newP = section.newPath;
    if (oldP === null && newP === null) return;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (section.create && newP !== null) {
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const outLines: string[] = [];
      let lastNew: BodyItem | null = null;
      for (const h of section.hunks) {
        for (const it of h.items) {
          if (it.kind === 'new') {
            outLines.push(it.text);
            lastNew = it;
          }
        }
      }
      tree.now.set(newP, outLines.length === 0 ? '' : outLines.join('\n') + (lastNew?.noNL ? '' : '\n'));
      return;
    }
    if (section.del && oldP !== null) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      const cur = tree.get(oldP);
      if (cur === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const done = applyHunks(parseFile(cur), section.hunks, strict, oldP);
      tree.now.set(newP, serializeFile(done));
      tree.now.set(oldP, null);
      tree.moves.push([oldP, newP]);
      return;
    }
    const p = oldP ?? newP!;
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    tree.now.set(p, serializeFile(applyHunks(parseFile(cur), section.hunks, strict, p)));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7).
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (l.trim() === '') continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const st = parseFile(cur);
    const found = findTier(oldLines, st.lines, 0, strict, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const at = found.occ[0]!;
    const n = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const nTexts = buildNewLines(n, oldLines, st.lines, at, found.tier);
    const lines = [...st.lines.slice(0, at), ...nTexts, ...st.lines.slice(at + oldLines.length)];
    tree.now.set(path, serializeFile({ br: st.br, lines, final: st.final }));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8).
// ---------------------------------------------------------------------------

interface VChunk {
  /** Null or empty: no anchor. */
  anchor: string | null;
  /** True when a `*** End of File` line closed this chunk. */
  eof: boolean;
  items: BodyItem[];
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i++;
    if (i >= last) break;
    const line = lines[i]!;
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const body: string[] = [];
      i++;
      while (i < last && !isSectionStart(lines[i]!)) {
        const l = lines[i]!;
        if (blank(l)) {
          body.push('');
          i++;
          continue;
        }
        if (!l.startsWith('+')) throw new Exit2(`error: parse ${i + 1}`);
        body.push(l.slice(1));
        i++;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      edits.push(v4aAddEdit(path, body));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last && !isSectionStart(lines[i]!)) {
        if (blank(lines[i]!)) {
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLineNo = i + 1;
      i++;
      const raw: Array<{ text: string; no: number }> = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        raw.push({ text: lines[i]!, no: i + 1 });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      let j = 0;
      let moveTo: string | null = null;
      if (j < raw.length && raw[j]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[j]!.text.slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let closedByEof = false;
      while (j < raw.length) {
        const { text: l, no } = raw[j]!;
        if (l.startsWith('@@')) {
          cur = { anchor: l.slice(2).trim(), eof: false, items: [] };
          chunks.push(cur);
          closedByEof = false;
          j++;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${no}`);
          cur.eof = true;
          cur = null;
          closedByEof = true;
          j++;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (cur === null) {
            if (closedByEof) throw new Exit2(`error: parse ${no}`);
            cur = { anchor: null, eof: false, items: [] };
            chunks.push(cur);
          }
          if (l === '') cur.items.push({ kind: 'ctx', text: '', noNL: false });
          else if (l.startsWith(' ')) cur.items.push({ kind: 'ctx', text: l.slice(1), noNL: false });
          else if (l.startsWith('-')) cur.items.push({ kind: 'old', text: l.slice(1), noNL: false });
          else cur.items.push({ kind: 'new', text: l.slice(1), noNL: false });
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${no}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLineNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aAddEdit(path: string, body: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, body.length === 0 ? '' : body.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

/** The first line at or after `cursor` equal to `anchor` at the first tier where one is, or -1. */
function findAnchor(anchor: string, lines: string[], cursor: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = cursor; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return -1;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let st = parseFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const at = findAnchor(ch.anchor, st.lines, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const o: string[] = [];
      const n: NewItem[] = [];
      let oIdx = 0;
      for (const it of ch.items) {
        if (it.kind === 'ctx') {
          o.push(it.text);
          n.push({ text: it.text, ctx: true, oIdx });
          oIdx++;
        } else if (it.kind === 'old') {
          o.push(it.text);
          oIdx++;
        } else {
          n.push({ text: it.text, ctx: false, oIdx: -1 });
        }
      }
      if (o.length === 0) {
        const idx = ch.eof ? st.lines.length : cursor;
        const nTexts = n.map((x) => x.text);
        const lines = [...st.lines.slice(0, idx), ...nTexts, ...st.lines.slice(idx)];
        st = { br: st.br, lines, final: st.final };
        cursor = idx + nTexts.length;
        continue;
      }
      const found = findTier(o, st.lines, cursor, strict, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const at = found.occ[0]!;
      const nTexts = buildNewLines(n, o, st.lines, at, found.tier);
      const lines = [...st.lines.slice(0, at), ...nTexts, ...st.lines.slice(at + o.length)];
      st = { br: st.br, lines, final: st.final };
      cursor = at + nTexts.length;
    }
    const text = serializeFile(st);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9).
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Running the CLI (SPEC.md sections 1, 2 and 10).
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const rowMap = new Map<string, { key: string; line: string }>();
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rowMap.set(p, { key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  // A successful move whose old path existed before the patch and is gone after it, and whose new path did
  // not exist before it and is there after it, is one `R <old> -> <new>` line, sorting by <new>.
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      const dRow = rowMap.get(oldP);
      const aRow = rowMap.get(newP);
      if (dRow !== undefined && aRow !== undefined && dRow.line.startsWith('D ') && aRow.line.startsWith('A ')) {
        rowMap.delete(oldP);
        rowMap.delete(newP);
        rowMap.set(newP, { key: newP, line: `R ${oldP} -> ${newP}` });
      }
    }
  }
  const rows = [...rowMap.values()]
    .sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)))
    .map((r) => r.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
