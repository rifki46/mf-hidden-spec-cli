// mend — a patch applier for edits written by AI models, implementing SPEC.md version 1.
//
// One patch, four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON tool calls), applied to a tree of
// text files with three-tier line matching (exact, trailing-whitespace-insensitive, fully trimmed), and
// all-or-nothing output: either every edit applies and the tree is written, or the failures are listed and
// nothing is written. Node 22, standard library only; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A patch-level fault (exit 2): `line` is the whole output line. */
class ParseFault {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed (exit 1): a code from SPEC.md section 2 and the path it concerns. */
class EditFault {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC.md section 3): split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (section 3): relative, no backslash, no empty, `.` or `..` segment. */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function needSafe(p: string): void {
  if (!isSafe(p)) throw new EditFault('unsafe', p);
}

/**
 * The tree as the edits leave it. `before` caches each path's bytes on disk (null: no such file);
 * `after` holds the paths the edits have touched so far (null: deleted). A move that succeeded is
 * remembered in `moves` so the report can print an `R` line for it.
 */
class Tree {
  private readonly before = new Map<string, string | null>();
  readonly after = new Map<string, string | null>();
  readonly moves: Array<readonly [string, string]> = [];

  original(p: string): string | null {
    if (!this.before.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.before.set(p, v);
    }
    return this.before.get(p)!;
  }

  get(p: string): string | null {
    return this.after.has(p) ? this.after.get(p)! : this.original(p);
  }

  snapshot(): Map<string, string | null> {
    return new Map(this.after);
  }

  restore(snap: Map<string, string | null>): void {
    this.after.clear();
    for (const [k, v] of snap) this.after.set(k, v);
  }
}

type Edit = (tree: Tree) => void;

/** A file as lines: its own line break, and whether it ends with one (section 3). */
interface FileLines {
  lines: string[];
  br: '\n' | '\r\n';
  endsWithBreak: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', endsWithBreak: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const endsWithBreak = text.endsWith(br);
  if (endsWithBreak) parts.pop();
  return { lines: parts, br, endsWithBreak };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.endsWithBreak ? f.br : '');
}

/** The three matching tiers of section 5 as line transforms; --strict keeps only tier 0. */
const TIER_FN: Array<(s: string) => string> = [
  (s) => s,
  (s) => s.replace(/[ \t]+$/, ''),
  (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
];

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

interface Occurrence {
  tier: number;
  positions: number[];
}

/** The first tier at which `old` occurs in `lines` at or after `from`, with every position there. */
function findOccurrence(lines: string[], old: string[], from: number, strict: boolean): Occurrence | null {
  for (const tier of tiersToTry(strict)) {
    const f = TIER_FN[tier]!;
    const wanted = old.map(f);
    const positions: number[] = [];
    for (let i = from; i + old.length <= lines.length; i += 1) {
      let ok = true;
      for (let j = 0; j < old.length; j += 1) {
        if (f(lines[i + j]!) !== wanted[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

const leadingWs = (s: string): string => /^[ \t]*/.exec(s)![0]!;

/**
 * One replacement line of N at the tier the match was found (section 5): at tier 2 a non-context line is
 * re-indented, the file's first matched line's indent F taking the place of O's first line's indent P.
 */
function replacementLine(text: string, tier: number, fileFirst: string, oldFirst: string): string {
  if (tier !== 2) return text;
  if (text === '' || /^[ \t]+$/.test(text)) return text;
  const F = leadingWs(fileFirst);
  const P = leadingWs(oldFirst);
  return text.startsWith(P) ? F + text.slice(P.length) : text;
}

/** A body line of a unified hunk or a V4A chunk: context, old-only, new-only, or a `\` marker line. */
interface BodyLine {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
}

/** The lines a body writes over the matched ones: context lines are the file's own, `add` lines may re-indent. */
function buildReplacement(fileLines: string[], pos: number, body: BodyLine[], tier: number, oldFirst: string): string[] {
  const out: string[] = [];
  let oi = 0;
  for (const b of body) {
    if (b.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (b.kind === 'del') {
      oi += 1;
    } else if (b.kind === 'add') {
      out.push(replacementLine(b.text, tier, fileLines[pos]!, oldFirst));
    }
  }
  return out;
}

/** True when a `\` line follows the body's last context or `add` line (the no-final-break marker). */
function noBreakAfter(body: BodyLine[]): boolean {
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const k = body[i]!.kind;
    if (k === 'ctx' || k === 'add') return body[i + 1]?.kind === 'bs';
  }
  return false;
}

/** Format detection (section 4), in the section's own order. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart().charAt(0);
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.replace(/[ \t]+$/, '') === '<<<<<<< SEARCH')) return 'search-replace';
  const unified = lines.some(
    (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
  );
  return unified ? 'unified' : null;
}

/** One JSON edit object (section 9) as an edit, or null when it is not a valid edit object. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;

  const readExisting = (tree: Tree): string => {
    needSafe(p);
    const t = tree.get(p);
    if (t === null) throw new EditFault('missing', p);
    return t;
  };

  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      needSafe(p);
      if (tree.get(p) !== null) throw new EditFault('exists', p);
      tree.after.set(p, text);
    };
  }

  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = readExisting(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.split('\r\n').join('\n') : s);
      const text = toLf(before);
      const needle = toLf(oldStr);
      let count = 0;
      for (let k = text.indexOf(needle); k >= 0; k = text.indexOf(needle, k + 1)) count += 1;
      if (count === 0) throw new EditFault('no-match', p);
      if (count > 1) throw new EditFault('ambiguous', p);
      const at = text.indexOf(needle);
      const merged = text.slice(0, at) + toLf(newStr) + text.slice(at + needle.length);
      tree.after.set(p, crlf ? merged.split('\n').join('\r\n') : merged);
    };
  }

  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const at = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const f = splitFile(readExisting(tree));
      if (at < 0 || at > f.lines.length) throw new EditFault('no-match', p);
      f.lines.splice(at, 0, ...add);
      tree.after.set(p, joinFile(f));
    };
  }

  return null;
}

/** The JSON reader (section 9): one array of edit objects, or JSON Lines. */
function readJsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new ParseFault(`error: parse ${first + 1}`);
    return v.map((x) => {
      const e = jsonEdit(x);
      if (e === null) throw new ParseFault(`error: parse ${first + 1}`);
      return e;
    });
  }
  const edits: Edit[] = [];
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A unified hunk: its header's old-start A (B and D are not used) and its body lines. */
interface Hunk {
  a: number;
  body: BodyLine[];
}

/** One unified section while it is being read: every way its paths can be named, plus its hunks. */
interface Section {
  diffOld?: string;
  diffNew?: string;
  oldP?: string | null;
  newP?: string | null;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** A `---`/`+++` path: text after the four characters, up to a tab, spaces removed, `a/` or `b/` stripped. */
function headerPath(raw: string): string | null {
  let p = raw;
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Read one section's header and hunks from index `start`; returns the first index not consumed. */
function parseSection(lines: string[], start: number, sec: Section): number {
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (sec.oldP !== undefined) return i;
        sec.oldP = headerPath(l.slice(4));
        sec.newP = headerPath(lines[i + 1]!.slice(4));
        i += 2;
        continue;
      }
      throw new ParseFault(`error: parse ${i + 2}`);
    }
    if (l.startsWith('+++ ')) {
      sec.newP = headerPath(l.slice(4));
      i += 1;
      continue;
    }
    if (l.startsWith('rename from ')) {
      sec.renameFrom = l.slice('rename from '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      sec.renameTo = l.slice('rename to '.length).trim();
      i += 1;
      continue;
    }
    if (l.startsWith('new file mode')) {
      sec.newFile = true;
      i += 1;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      sec.deletedFile = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return i;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new ParseFault(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number.parseInt(m[1]!, 10), body: [] };
      i += 1;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') hunk.body.push({ kind: 'ctx', text: '' });
        else if (b.startsWith(' ')) hunk.body.push({ kind: 'ctx', text: b.slice(1) });
        else if (b.startsWith('-')) hunk.body.push({ kind: 'del', text: b.slice(1) });
        else if (b.startsWith('+')) hunk.body.push({ kind: 'add', text: b.slice(1) });
        else if (b.startsWith('\\')) hunk.body.push({ kind: 'bs', text: b.slice(1) });
        else break;
        i += 1;
      }
      while (hunk.body.length > 0) {
        const tail = hunk.body[hunk.body.length - 1]!;
        if (tail.kind === 'ctx' && tail.text === '') hunk.body.pop();
        else break;
      }
      sec.hunks.push(hunk);
      continue;
    }
    i += 1;
  }
  return i;
}

/** Apply a section's hunks in order to a file's lines (section 6), tracking the running offset d. */
function applyHunks(f: FileLines, hunks: Hunk[], path: string, strict: boolean): void {
  let d = 0;
  for (const h of hunks) {
    const oldLines = h.body.filter((b) => b.kind === 'ctx' || b.kind === 'del').map((b) => b.text);
    const newCount = h.body.filter((b) => b.kind === 'ctx' || b.kind === 'add').length;
    if (oldLines.length === 0) {
      const adds = h.body.filter((b) => b.kind === 'add').map((b) => b.text);
      const pos = Math.max(0, Math.min(h.a + d, f.lines.length));
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...adds);
      if (atEnd) f.endsWithBreak = !noBreakAfter(h.body);
      d += adds.length;
      continue;
    }
    const occ = findOccurrence(f.lines, oldLines, 0, strict);
    if (occ === null) throw new EditFault('no-match', path);
    const target = h.a - 1 + d;
    let pos = occ.positions[0]!;
    for (const p of occ.positions) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const seg = buildReplacement(f.lines, pos, h.body, occ.tier, oldLines[0]!);
    const runsToEnd = pos + oldLines.length === f.lines.length;
    f.lines.splice(pos, oldLines.length, ...seg);
    if (runsToEnd) f.endsWithBreak = !noBreakAfter(h.body);
    d += newCount - oldLines.length;
  }
}

/** One unified section as one edit: a creation, a deletion, a move, or a change (section 6). */
function unifiedEdit(sec: Section, strict: boolean): Edit {
  const oldRaw: string | null | undefined =
    sec.oldP !== undefined ? sec.oldP : sec.renameFrom !== undefined ? sec.renameFrom : sec.diffOld;
  const newRaw: string | null | undefined =
    sec.newP !== undefined ? sec.newP : sec.renameTo !== undefined ? sec.renameTo : sec.diffNew;
  const creation = oldRaw === null || sec.newFile;
  const deletion = newRaw === null || sec.deletedFile;
  return (tree) => {
    if (creation && !deletion) {
      const target = typeof newRaw === 'string' ? newRaw : '';
      needSafe(target);
      if (tree.get(target) !== null) throw new EditFault('exists', target);
      const adds: string[] = [];
      let fin = true;
      for (const h of sec.hunks) {
        for (let j = 0; j < h.body.length; j += 1) {
          const b = h.body[j]!;
          if (b.kind === 'add') {
            adds.push(b.text);
            fin = h.body[j + 1]?.kind !== 'bs';
          }
        }
      }
      tree.after.set(target, joinFile({ lines: adds, br: '\n', endsWithBreak: fin }));
      return;
    }
    if (deletion) {
      const target = typeof oldRaw === 'string' ? oldRaw : '';
      needSafe(target);
      if (tree.get(target) === null) throw new EditFault('missing', target);
      tree.after.set(target, null);
      return;
    }
    const from = typeof oldRaw === 'string' ? oldRaw : '';
    const to = typeof newRaw === 'string' ? newRaw : '';
    needSafe(from);
    needSafe(to);
    const before = tree.get(from);
    if (before === null) throw new EditFault('missing', from);
    if (to !== from && tree.get(to) !== null) throw new EditFault('exists', to);
    const f = splitFile(before);
    applyHunks(f, sec.hunks, from, strict);
    tree.after.set(to, joinFile(f));
    if (to !== from) {
      tree.after.set(from, null);
      tree.moves.push([from, to]);
    }
  };
}

/** The unified reader (section 6): sections, their headers and hunks; prose outside bodies is ignored. */
function readUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      if (m === null) throw new ParseFault(`error: parse ${i + 1}`);
      const sec: Section = { diffOld: m[1]!, diffNew: m[2]!, newFile: false, deletedFile: false, hunks: [] };
      sections.push(sec);
      i = parseSection(lines, i + 1, sec);
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = {
        oldP: headerPath(l.slice(4)),
        newP: headerPath(lines[i + 1]!.slice(4)),
        newFile: false,
        deletedFile: false,
        hunks: [],
      };
      sections.push(sec);
      i = parseSection(lines, i + 2, sec);
    } else if (l.startsWith('@@')) {
      throw new ParseFault(`error: parse ${i + 1}`);
    } else {
      i += 1;
    }
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** One SEARCH/REPLACE block as one edit (section 7). */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    needSafe(path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFault('exists', path);
      tree.after.set(path, joinFile({ lines: [...newLines], br: '\n', endsWithBreak: true }));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new EditFault('missing', path);
    const f = splitFile(before);
    const occ = findOccurrence(f.lines, oldLines, 0, strict);
    if (occ === null) throw new EditFault('no-match', path);
    if (occ.positions.length > 1) throw new EditFault('ambiguous', path);
    const pos = occ.positions[0]!;
    const seg = newLines.map((t) => replacementLine(t, occ.tier, f.lines[pos]!, oldLines[0]!));
    f.lines.splice(pos, oldLines.length, ...seg);
    tree.after.set(path, joinFile(f));
  };
}

/** The SEARCH/REPLACE reader (section 7): blocks, their markers, and the path line each block takes. */
function readSearchReplace(lines: string[], strict: boolean): Edit[] {
  const isMark = (l: string, m: string): boolean => l.replace(/[ \t]+$/, '') === m;
  const edits: Edit[] = [];
  let prevPath: string | undefined;
  let prevEnd = 0;
  let i = 0;
  while (i < lines.length) {
    if (!isMark(lines[i]!, '<<<<<<< SEARCH')) {
      i += 1;
      continue;
    }
    const searchAt = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (isMark(lines[j]!, '=======')) {
        eq = j;
        break;
      }
      if (isMark(lines[j]!, '>>>>>>> REPLACE')) break;
    }
    if (eq < 0) throw new ParseFault(`error: parse ${searchAt + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (isMark(lines[j]!, '>>>>>>> REPLACE')) {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new ParseFault(`error: parse ${searchAt + 1}`);
    let path: string | undefined;
    for (let k = searchAt - 1; k >= prevEnd; k -= 1) {
      const l = lines[k]!;
      if (!isBlank(l) && !l.trim().startsWith('```')) {
        path = l.trim();
        break;
      }
    }
    if (path === undefined) path = prevPath;
    if (path === undefined) throw new ParseFault(`error: parse ${searchAt + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchAt + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** A V4A chunk: an optional anchor line, whether `*** End of File` closed it, and its body lines. */
interface Chunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

/** One V4A Update File section as one edit (section 8): chunks under a cursor, then the optional move. */
function v4aUpdateEdit(path: string, moveTo: string | undefined, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    needSafe(path);
    if (moveTo !== undefined) needSafe(moveTo);
    const before = tree.get(path);
    if (before === null) throw new EditFault('missing', path);
    if (moveTo !== undefined && tree.get(moveTo) !== null) throw new EditFault('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        let found = -1;
        for (const tier of tiersToTry(strict)) {
          const tf = TIER_FN[tier]!;
          const want = tf(chunk.anchor);
          for (let k = cursor; k < f.lines.length; k += 1) {
            if (tf(f.lines[k]!) === want) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new EditFault('no-match', path);
        cursor = found + 1;
      }
      const oldLines = chunk.body.filter((b) => b.kind === 'ctx' || b.kind === 'del').map((b) => b.text);
      if (oldLines.length === 0) {
        const adds = chunk.body.filter((b) => b.kind === 'add').map((b) => b.text);
        const pos = chunk.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        f.lines.splice(pos, 0, ...adds);
        cursor = pos + adds.length;
        continue;
      }
      let placed: { tier: number; pos: number } | null = null;
      for (const tier of tiersToTry(strict)) {
        const tf = TIER_FN[tier]!;
        const wanted = oldLines.map(tf);
        for (let k = cursor; k + oldLines.length <= f.lines.length; k += 1) {
          let ok = true;
          for (let j = 0; j < oldLines.length; j += 1) {
            if (tf(f.lines[k + j]!) !== wanted[j]) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
          if (chunk.eof && k + oldLines.length !== f.lines.length) continue;
          placed = { tier, pos: k };
          break;
        }
        if (placed !== null) break;
      }
      if (placed === null) throw new EditFault('no-match', path);
      const seg = buildReplacement(f.lines, placed.pos, chunk.body, placed.tier, oldLines[0]!);
      f.lines.splice(placed.pos, oldLines.length, ...seg);
      cursor = placed.pos + seg.length;
    }
    const out = joinFile(f);
    if (moveTo !== undefined) {
      tree.after.set(moveTo, out);
      tree.after.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.after.set(path, out);
    }
  };
}

/** The V4A reader (section 8): the Begin/End frame, then Add, Delete and Update sections. */
function readV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFault(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && isBlank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseFault(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (isBlank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i += 1;
      const content: string[] = [];
      while (i < last && !isSectionStart(lines[i]!)) {
        const c = lines[i]!;
        if (c.startsWith('+')) content.push(c.slice(1));
        else if (c === '') content.push('');
        else throw new ParseFault(`error: parse ${i + 1}`);
        i += 1;
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      edits.push((tree) => {
        needSafe(path);
        if (tree.get(path) !== null) throw new EditFault('exists', path);
        tree.after.set(path, joinFile({ lines: content, br: '\n', endsWithBreak: true }));
      });
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last && !isSectionStart(lines[i]!)) {
        if (!isBlank(lines[i]!)) throw new ParseFault(`error: parse ${i + 1}`);
        i += 1;
      }
      edits.push((tree) => {
        needSafe(path);
        if (tree.get(path) === null) throw new EditFault('missing', path);
        tree.after.set(path, null);
      });
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const atLine = i + 1;
      i += 1;
      let moveTo: string | undefined;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i += 1;
      }
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let closedByEof = false;
      while (i < last && !isSectionStart(lines[i]!)) {
        const c = lines[i]!;
        if (c.startsWith('@@')) {
          const anchorText = c.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [] };
          chunks.push(cur);
          closedByEof = false;
          i += 1;
          continue;
        }
        if (c.trim() === '*** End of File') {
          if (cur === null) throw new ParseFault(`error: parse ${i + 1}`);
          cur.eof = true;
          cur = null;
          closedByEof = true;
          i += 1;
          continue;
        }
        if (c.startsWith('*** Move to: ')) throw new ParseFault(`error: parse ${i + 1}`);
        if (c === '' || c.startsWith(' ') || c.startsWith('-') || c.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new ParseFault(`error: parse ${i + 1}`);
            cur = { anchor: null, eof: false, body: [] };
            chunks.push(cur);
          }
          if (c === '') cur.body.push({ kind: 'ctx', text: '' });
          else if (c.startsWith(' ')) cur.body.push({ kind: 'ctx', text: c.slice(1) });
          else if (c.startsWith('-')) cur.body.push({ kind: 'del', text: c.slice(1) });
          else cur.body.push({ kind: 'add', text: c.slice(1) });
          i += 1;
          continue;
        }
        throw new ParseFault(`error: parse ${i + 1}`);
      }
      if (!closedByEof && chunks.length > 0) {
        const body = chunks[chunks.length - 1]!.body;
        while (body.length > 0) {
          const tail = body[body.length - 1]!;
          if (tail.kind === 'ctx' && tail.text === '') body.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === undefined) throw new ParseFault(`error: parse ${atLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new ParseFault(`error: parse ${i + 1}`);
  }
  return edits;
}

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** The CLI itself (sections 1, 2 and 10): arguments, the error order, the edits, the report, the write. */
function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const positional: string[] = [];
  let optionsEnded = false;
  for (const a of args) {
    if (!optionsEnded && a === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMAT_NAMES.includes(a.slice('--format='.length))) {
        format = a.slice('--format='.length);
      } else if (a === '--check' && !checkOnly) {
        checkOnly = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
      continue;
    }
    positional.push(a);
  }
  if (positional.length > 1) return { code: 2, out: ['error: usage'] };
  const patchArg = positional.length === 0 ? null : positional[0]!;
  let text = '';
  if (patchArg === null || patchArg === '-') {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  } else {
    try {
      text = readFileSync(patchArg, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = readJsonEdits(text, lines);
    else if (kind === 'unified') edits = readUnified(lines, strict);
    else if (kind === 'search-replace') edits = readSearchReplace(lines, strict);
    else edits = readV4a(lines, strict);
    if (edits.length === 0) throw new ParseFault('error: parse 1');
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const faults: EditFault[] = [];
  for (const edit of edits) {
    const snap = tree.snapshot();
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof EditFault)) throw e;
      tree.restore(snap);
      tree.moves.length = moveCount;
      faults.push(e);
    }
  }
  if (faults.length > 0) {
    return {
      code: 1,
      out: [...faults.map((f) => `error: ${f.code} ${f.path}`), `failed: ${faults.length} of ${edits.length} edits`],
    };
  }
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of tree.after.keys()) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.get(p);
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  if (!checkOnly) {
    for (const [p, v] of tree.after) {
      if (tree.original(p) === v) continue;
      if (v === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, v);
      }
    }
  }
  const n = rows.length;
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${n} ${n === 1 ? 'file' : 'files'}`] };
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
