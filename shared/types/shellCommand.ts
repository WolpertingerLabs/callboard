/**
 * Which files does a shell command write its output to, and does it detach?
 *
 * A pure, deliberately conservative reading of a Bash command, used by the
 * daemon to follow `nohup rsync … > $L/rsync.log 2> $L/rsync.err &` in a
 * background call's live tail, and by the client to decide whether such a
 * call gets an "Output" row at all. One implementation serves both, so the
 * row appears exactly when the daemon would have something to tail.
 *
 * It is not a shell. It parses the command into lists, pipelines and
 * compound commands, then walks them with an abstract state (cwd and known
 * variables). Where a branch may or may not have run — `a && L=/x || L=/y`,
 * an `if`, a loop body, a `case` arm — the possible states are joined: a
 * variable or cwd that differs between them becomes unknown. Anything it
 * cannot resolve for certain (unknown variables, `$(…)`, globs, a relative
 * path once cwd is unknown) is skipped, never guessed.
 *
 * Browser-safe: no Node imports.
 */

export type RedirectFd = "stdout" | "stderr";

export interface RedirectTarget {
  /** Absolute, normalised path. */
  path: string;
  fds: RedirectFd[];
  via: "redirect" | "tee";
  append: boolean;
}

export interface RedirectContext {
  /** Working directory the command started in. */
  cwd: string;
  /** Home directory, for `~` and `$HOME`. */
  home: string;
}

export interface ShellCommandAnalysis {
  /** Files the command writes stdout/stderr to, in the order they appear. */
  targets: RedirectTarget[];
  /** Something keeps running after the command returns: a job sent to the background with `&`, or `nohup`/`setsid`/`disown`. */
  detached: boolean;
}

/** Targets returned at most. */
export const MAX_REDIRECT_TARGETS = 8;
/** Commands longer than this are not parsed at all. */
export const MAX_COMMAND_LENGTH = 64 * 1024;
/** Deepest nesting of compound commands (subshells, groups, if, loops, function calls) followed. */
export const MAX_NESTING = 64;
/** Variables tracked at once; assignments beyond this are treated as unknown. Real commands use a handful. */
const MAX_VARS = 64;
/** Commands walked (function bodies count once per call), and state entries copied, before giving up. */
const MAX_STEPS = 40_000;
const MAX_WORK = 2_000_000;

/** Thrown when a command is too deep or too costly to follow; the analysis then reports nothing. */
class TooComplex extends Error {}

// ── Paths (POSIX, without Node's `path`) ────────────────────────────

function normalizeAbs(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}

function resolvePath(p: string, cwd: string | null): string | null {
  if (!p || p.includes("\0")) return null;
  if (p.startsWith("/")) return normalizeAbs(p);
  if (cwd === null) return null;
  return normalizeAbs(cwd + "/" + p);
}

// ── Tokens ──────────────────────────────────────────────────────────

/** A run of characters with one quoting. `bad` marks text that cannot be resolved (`$(…)`, backticks, `$'…'`). */
interface Seg {
  text: string;
  q: "none" | "single" | "double";
  bad?: boolean;
}
type Word = Seg[];
/** `arith`: an arithmetic command `(( … ))`, with the expression's raw text. */
type Tok = { t: "word"; w: Word } | { t: "op"; op: string } | { t: "redir"; fd: number | null; op: string } | { t: "arith"; text: string };

/**
 * Finds the `))` closing an arithmetic `((`, in linear time overall: paren
 * pairs are matched once for the whole command (quotes are not special here,
 * as before), and separators counted by prefix sums. Built lazily, only for
 * commands that contain `((` at all.
 */
class ArithIndex {
  private close: Int32Array;
  private seps: Int32Array;
  constructor(private s: string) {
    this.close = new Int32Array(s.length).fill(-1);
    this.seps = new Int32Array(s.length + 1);
    const open: number[] = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      this.seps[i + 1] = this.seps[i] + (c === ";" || c === "\n" ? 1 : 0);
      if (c === "(") open.push(i);
      else if (c === ")" && open.length) this.close[open.pop() as number] = i;
    }
  }
  /**
   * For `((` at `i`: the index of the first `)` of its closing `))`, or -1
   * when it is nested subshells instead — arithmetic never holds a command
   * separator, and the inner `(` must close directly before the outer one.
   */
  end(i: number): number {
    const k = this.close[i + 1];
    if (k < 0 || this.s[k + 1] !== ")") return -1;
    return this.seps[k] - this.seps[i + 2] === 0 ? k : -1;
  }
}

/** Index just past the `)` that closes the `$(` / `(` opened before `i`. */
function skipParens(s: string, i: number): number {
  let depth = 1;
  while (i < s.length && depth > 0) {
    const c = s[i];
    if (c === "\\") i += 2;
    else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      i = end < 0 ? s.length : end + 1;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
      i++;
    } else {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
  }
  return Math.min(i, s.length);
}

function skipBacktick(s: string, i: number): number {
  while (i < s.length && s[i] !== "`") i += s[i] === "\\" ? 2 : 1;
  return Math.min(i + 1, s.length);
}

function skipBrace(s: string, i: number): number {
  let depth = 1;
  while (i < s.length && depth > 0) {
    if (s[i] === "\\") i++;
    else if (s[i] === "{") depth++;
    else if (s[i] === "}") depth--;
    i++;
  }
  return Math.min(i, s.length);
}

const wordText = (w: Word): string => w.map((s) => s.text).join("");

/** File-descriptor marker for `{name}>` redirections: neither stdout nor stderr. */
const NAMED_FD = -1;

function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  let word: Word = [];
  let started = false;
  /** Heredocs opened on the current line: their bodies start after the next newline. */
  const heredocs: { delim: string; stripTabs: boolean }[] = [];
  let wantDelim: { stripTabs: boolean } | null = null;
  let arith: ArithIndex | undefined;

  const push = (text: string, q: Seg["q"], bad = false) => {
    started = true;
    const last = word[word.length - 1];
    if (last && last.q === q && !last.bad && !bad) last.text += text;
    else word.push({ text, q, ...(bad && { bad }) });
  };
  const finish = () => {
    if (started) {
      if (wantDelim) {
        heredocs.push({ delim: wordText(word), ...wantDelim });
        wantDelim = null;
      }
      toks.push({ t: "word", w: word });
    }
    word = [];
    started = false;
  };
  /** A word directly before `>`/`<` that is a file-descriptor number (`2>`) or name (`{fd}>`). */
  const takeFd = (): number | null => {
    const only = word.length === 1 && word[0].q === "none" && !word[0].bad ? word[0].text : null;
    if (only !== null && (/^\d{1,2}$/.test(only) || /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(only))) {
      word = [];
      started = false;
      return /^\d/.test(only) ? Number(only) : NAMED_FD;
    }
    finish();
    return null;
  };
  /** Skip heredoc bodies starting at `i` (just past a newline); returns the index after the last delimiter line. */
  const skipBodies = (i: number): number => {
    while (heredocs.length) {
      const { delim, stripTabs } = heredocs.shift()!;
      for (;;) {
        if (i >= s.length) return s.length;
        const nl = s.indexOf("\n", i);
        const end = nl < 0 ? s.length : nl;
        const line = s.slice(i, end);
        i = nl < 0 ? s.length : nl + 1;
        if ((stripTabs ? line.replace(/^\t+/, "") : line) === delim) break;
      }
    }
    return i;
  };

  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === " " || c === "\t") {
      finish();
      i++;
    } else if (c === "\\" && n === "\n") {
      i += 2;
    } else if (c === "\n") {
      finish();
      toks.push({ t: "op", op: "\n" });
      i = skipBodies(i + 1);
    } else if (c === "#" && !started) {
      while (i < s.length && s[i] !== "\n") i++;
    } else if (c === ";") {
      finish();
      if (n === ";") {
        toks.push({ t: "op", op: ";;" });
        i += s[i + 2] === "&" ? 3 : 2;
      } else if (n === "&") {
        toks.push({ t: "op", op: ";;" });
        i += 2;
      } else {
        toks.push({ t: "op", op: ";" });
        i++;
      }
    } else if (c === "&") {
      finish();
      if (n === "&") {
        toks.push({ t: "op", op: "&&" });
        i += 2;
      } else if (n === ">") {
        const append = s[i + 2] === ">";
        toks.push({ t: "redir", fd: null, op: append ? "&>>" : "&>" });
        i += append ? 3 : 2;
      } else {
        toks.push({ t: "op", op: "&" });
        i++;
      }
    } else if (c === "|") {
      finish();
      if (n === "|" || n === "&") {
        toks.push({ t: "op", op: "|" + n });
        i += 2;
      } else {
        toks.push({ t: "op", op: "|" });
        i++;
      }
    } else if (c === "(" && n === "(" && !started && (arith ??= new ArithIndex(s)).end(i) >= 0) {
      // `(( expr ))`: arithmetic, not two subshells.
      const end = arith.end(i);
      toks.push({ t: "arith", text: s.slice(i + 2, end) });
      i = end + 2;
    } else if (c === "(" || c === ")") {
      finish();
      toks.push({ t: "op", op: c });
      i++;
    } else if (c === ">" || c === "<") {
      const fd = takeFd();
      let op: string;
      if (c === ">") op = n === ">" ? ">>" : n === "|" ? ">|" : n === "&" ? ">&" : ">";
      else if (n === "<") op = s[i + 2] === "<" ? "<<<" : s[i + 2] === "-" ? "<<-" : "<<";
      else op = n === "&" ? "<&" : n === ">" ? "<>" : "<";
      toks.push({ t: "redir", fd, op });
      i += op.length;
      if (op === "<<" || op === "<<-") wantDelim = { stripTabs: op === "<<-" };
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      const stop = end < 0 ? s.length : end;
      push(s.slice(i + 1, stop), "single");
      i = stop + 1;
    } else if (c === '"') {
      i++;
      started = true;
      while (i < s.length && s[i] !== '"') {
        const d = s[i];
        if (d === "\\" && i + 1 < s.length) {
          const e = s[i + 1];
          if (e === "\n") i += 2;
          else if ('$`"\\'.includes(e)) {
            push(e, "single");
            i += 2;
          } else {
            push("\\", "double");
            i++;
          }
        } else if (d === "$" && s[i + 1] === "(") {
          const end = skipParens(s, i + 2);
          push(s.slice(i, end), "double", true);
          i = end;
        } else if (d === "$" && s[i + 1] === "{") {
          const end = skipBrace(s, i + 2);
          push(s.slice(i, end), "double");
          i = end;
        } else if (d === "`") {
          const end = skipBacktick(s, i + 1);
          push(s.slice(i, end), "double", true);
          i = end;
        } else {
          push(d, "double");
          i++;
        }
      }
      i++;
    } else if (c === "\\") {
      if (i + 1 < s.length) push(s[i + 1], "single");
      i += 2;
    } else if (c === "$" && n === "(") {
      const end = skipParens(s, i + 2);
      push(s.slice(i, end), "none", true);
      i = end;
    } else if (c === "$" && n === "{") {
      const end = skipBrace(s, i + 2);
      push(s.slice(i, end), "none");
      i = end;
    } else if (c === "$" && n === "'") {
      let j = i + 2;
      while (j < s.length && s[j] !== "'") j += s[j] === "\\" ? 2 : 1;
      push(s.slice(i, j + 1), "none", true);
      i = j + 1;
    } else if (c === "`") {
      const end = skipBacktick(s, i + 1);
      push(s.slice(i, end), "none", true);
      i = end;
    } else {
      push(c, "none");
      i++;
    }
  }
  finish();
  return toks;
}

// ── Parse ───────────────────────────────────────────────────────────

interface Redir {
  fd: number | null;
  op: string;
  target?: Word;
}
type Cmd =
  | { t: "simple"; words: Word[]; redirs: Redir[] }
  | { t: "subshell"; body: List; redirs: Redir[] }
  | { t: "group"; body: List; redirs: Redir[] }
  | { t: "if"; clauses: { cond: List; body: List }[]; orElse: List | null; redirs: Redir[] }
  | { t: "loop"; cond: List | null; forVar: string | null; body: List; redirs: Redir[] }
  | { t: "case"; arms: List[]; redirs: Redir[] }
  | { t: "func"; name: string; body: Cmd }
  | { t: "arith"; text: string; redirs: Redir[] };
interface Pipeline {
  cmds: Cmd[];
  /** Per command: fed by `|&`, so the pipe carries stderr too. */
  stderrIn: boolean[];
  bang: boolean;
}
interface AndOr {
  first: Pipeline;
  rest: { op: "&&" | "||"; p: Pipeline }[];
}
type List = { ao: AndOr; background: boolean }[];

/** Reserved words that end a list when they appear in command position. */
const LIST_END = new Set(["then", "elif", "else", "fi", "do", "done", "esac", "}"]);

function plain(word: Word | undefined): string | null {
  return word && word.length === 1 && word[0].q === "none" && !word[0].bad ? word[0].text : null;
}

class Parser {
  i = 0;
  private depth = 0;
  constructor(private toks: Tok[]) {}

  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  isOp(op: string): boolean {
    const t = this.peek();
    return !!t && t.t === "op" && t.op === op;
  }
  isWord(w: string): boolean {
    const t = this.peek();
    return !!t && t.t === "word" && plain(t.w) === w;
  }
  skipNewlines(): void {
    while (this.isOp("\n") || this.isOp(";")) this.i++;
  }
  /** Consume the reserved word `w` if it is next (after separators). */
  expectWord(w: string): void {
    this.skipNewlines();
    if (this.isWord(w)) this.i++;
  }

  /** A list, up to end of input, `)`, `;;`, or a reserved word that closes the enclosing construct. */
  list(): List {
    const items: List = [];
    for (;;) {
      this.skipNewlines();
      const t = this.peek();
      if (!t) break;
      if (t.t === "op" && (t.op === ")" || t.op === ";;")) break;
      if (t.t === "word" && LIST_END.has(plain(t.w) ?? "")) break;
      const before = this.i;
      const ao = this.andOr();
      const background = this.isOp("&");
      if (background) this.i++;
      items.push({ ao, background });
      // Stray tokens (`&&` with nothing before it, `|` at the start): skip one to make progress.
      if (this.i === before) this.i++;
    }
    return items;
  }

  andOr(): AndOr {
    const first = this.pipeline();
    const rest: AndOr["rest"] = [];
    while (this.isOp("&&") || this.isOp("||")) {
      const op = (this.peek() as { op: "&&" | "||" }).op;
      this.i++;
      this.skipNewlinesOnly();
      rest.push({ op, p: this.pipeline() });
    }
    return { first, rest };
  }
  skipNewlinesOnly(): void {
    while (this.isOp("\n")) this.i++;
  }

  pipeline(): Pipeline {
    let bang = false;
    while (this.isWord("!") || this.isWord("time")) {
      if (this.isWord("!")) bang = !bang;
      this.i++;
    }
    const cmds: Cmd[] = [this.command()];
    const stderrIn = [false];
    while (this.isOp("|") || this.isOp("|&")) {
      stderrIn.push(this.isOp("|&"));
      this.i++;
      this.skipNewlinesOnly();
      cmds.push(this.command());
    }
    return { cmds, stderrIn, bang };
  }

  /** Redirections after a compound command. */
  trailingRedirs(): Redir[] {
    const redirs: Redir[] = [];
    for (;;) {
      const t = this.peek();
      if (!t || t.t !== "redir") return redirs;
      this.i++;
      const r: Redir = { fd: t.fd, op: t.op };
      const next = this.peek();
      if (next?.t === "word") {
        r.target = next.w;
        this.i++;
      }
      redirs.push(r);
    }
  }

  command(): Cmd {
    if (++this.depth > MAX_NESTING) throw new TooComplex("nesting");
    try {
      return this.commandAt();
    } finally {
      this.depth--;
    }
  }

  private commandAt(): Cmd {
    const t = this.peek();
    if (t?.t === "arith") {
      this.i++;
      return { t: "arith", text: t.text, redirs: this.trailingRedirs() };
    }
    if (this.isOp("(")) {
      this.i++;
      const body = this.list();
      if (this.isOp(")")) this.i++;
      return { t: "subshell", body, redirs: this.trailingRedirs() };
    }
    const kw = this.peek()?.t === "word" ? plain((this.peek() as { w: Word }).w) : null;
    switch (kw) {
      case "{": {
        this.i++;
        const body = this.list();
        this.expectWord("}");
        return { t: "group", body, redirs: this.trailingRedirs() };
      }
      case "if": {
        this.i++;
        const clauses: { cond: List; body: List }[] = [];
        let orElse: List | null = null;
        for (;;) {
          const cond = this.list();
          this.expectWord("then");
          const body = this.list();
          clauses.push({ cond, body });
          if (this.isWord("elif")) {
            this.i++;
            continue;
          }
          if (this.isWord("else")) {
            this.i++;
            orElse = this.list();
          }
          break;
        }
        this.expectWord("fi");
        return { t: "if", clauses, orElse, redirs: this.trailingRedirs() };
      }
      case "while":
      case "until": {
        this.i++;
        const cond = this.list();
        this.expectWord("do");
        const body = this.list();
        this.expectWord("done");
        return { t: "loop", cond, forVar: null, body, redirs: this.trailingRedirs() };
      }
      case "for":
      case "select": {
        this.i++;
        const v = plain((this.peek() as { w?: Word })?.w);
        const forVar = v && /^[A-Za-z_][A-Za-z0-9_]*$/.test(v) ? v : null;
        // Skip the header (`x in a b c`, or `((…))`) up to `do`.
        while (this.peek() && !this.isWord("do")) this.i++;
        this.expectWord("do");
        const body = this.list();
        this.expectWord("done");
        return { t: "loop", cond: null, forVar, body, redirs: this.trailingRedirs() };
      }
      case "case": {
        this.i++;
        while (this.peek() && !this.isWord("in")) this.i++;
        if (this.isWord("in")) this.i++;
        const arms: List[] = [];
        for (;;) {
          this.skipNewlines();
          if (!this.peek() || this.isWord("esac")) break;
          // Pattern: words and `|` up to the closing `)`.
          if (this.isOp("(")) this.i++;
          while (this.peek() && !this.isOp(")")) this.i++;
          if (this.isOp(")")) this.i++;
          arms.push(this.list());
          if (this.isOp(";;")) this.i++;
          else break;
        }
        this.expectWord("esac");
        return { t: "case", arms, redirs: this.trailingRedirs() };
      }
      case "function": {
        this.i++;
        const name = plain((this.peek() as { w?: Word })?.w) ?? "";
        this.i++;
        if (this.isOp("(")) this.i += 2;
        this.skipNewlinesOnly();
        return { t: "func", name, body: this.command() };
      }
    }
    // `name() body`
    const t0 = this.toks[this.i];
    const t1 = this.toks[this.i + 1];
    const t2 = this.toks[this.i + 2];
    if (t0?.t === "word" && t1?.t === "op" && t1.op === "(" && t2?.t === "op" && t2.op === ")") {
      const name = plain(t0.w) ?? "";
      this.i += 3;
      this.skipNewlinesOnly();
      return { t: "func", name, body: this.command() };
    }
    return this.simple();
  }

  simple(): Cmd {
    const words: Word[] = [];
    const redirs: Redir[] = [];
    for (;;) {
      const t = this.peek();
      if (!t || t.t === "op" || t.t === "arith") break;
      this.i++;
      if (t.t === "redir") {
        const r: Redir = { fd: t.fd, op: t.op };
        const next = this.peek();
        if (next?.t === "word") {
          r.target = next.w;
          this.i++;
        }
        redirs.push(r);
      } else {
        words.push(t.w);
      }
    }
    return { t: "simple", words, redirs };
  }
}

// ── Expansion ───────────────────────────────────────────────────────

interface ShellState {
  /** null once it cannot be known. */
  cwd: string | null;
  vars: Map<string, string>;
  /** Functions defined so far, with their bodies; null when it differs between branches. */
  funcs: Map<string, Cmd | null>;
}
/** null: this path cannot be reached (after `exit`, or the failure side of an assignment). */
type MaybeState = ShellState | null;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Expand `$NAME`/`${NAME}` in `text`; null when any reference is unknown or not a plain name. */
function expandVars(text: string, vars: Map<string, string>): string | null {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c !== "$") {
      out += c;
      i++;
      continue;
    }
    const n = text[i + 1];
    if (n === "{") {
      const end = text.indexOf("}", i + 2);
      if (end < 0) return null;
      const name = text.slice(i + 2, end);
      if (!NAME.test(name)) return null;
      const v = vars.get(name);
      if (v === undefined) return null;
      out += v;
      i = end + 1;
    } else if (n !== undefined && /[A-Za-z_]/.test(n)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j++;
      const v = vars.get(text.slice(i + 1, j));
      if (v === undefined) return null;
      out += v;
      i = j;
    } else if (n === undefined || /[\s/:.,=+-]/.test(n)) {
      out += "$";
      i++;
    } else {
      return null;
    }
  }
  return out;
}

const GLOB = /[*?[]/;
const BRACE_EXPANSION = /\{[^{}]*(,|\.\.)[^{}]*\}/;

/**
 * Expand a word the way the shell would for a redirection target or plain
 * argument, or null when that cannot be known for certain. `assignment` drops
 * word splitting and globbing (assignment values get neither).
 */
function expandWord(word: Word, st: ShellState, assignment = false): string | null {
  let out = "";
  for (let k = 0; k < word.length; k++) {
    const seg = word[k];
    if (seg.bad) return null;
    let text = seg.text;
    if (seg.q === "single") {
      out += text;
      continue;
    }
    if (seg.q === "none" && k === 0 && text.startsWith("~")) {
      const rest = text.slice(1);
      // `~user`, `~+`, and `~"…"` (a quoted tilde-prefix) are not followed.
      if (rest === "" ? word.length > 1 : !rest.startsWith("/")) return null;
      const home = st.vars.get("HOME");
      if (home === undefined) return null;
      out += home;
      text = rest;
    }
    if (seg.q === "none" && !assignment) {
      const literal = text.replace(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, "");
      if (GLOB.test(literal) || BRACE_EXPANSION.test(literal)) return null;
    }
    const expanded = expandVars(text, st.vars);
    if (expanded === null) return null;
    // An unquoted expansion would be word-split and globbed: ambiguous.
    if (seg.q === "none" && !assignment && expanded !== text && (/\s/.test(expanded) || GLOB.test(expanded))) return null;
    out += expanded;
  }
  return out;
}

/** `NAME=value` with the name and `=` unquoted. `+=` appends and is reported with `append`. */
function splitAssignment(word: Word): { name: string; value: Word; append: boolean } | null {
  const first = word[0];
  if (!first || first.q !== "none" || first.bad) return null;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=/.exec(first.text);
  if (!m) return null;
  const rest = first.text.slice(m[0].length);
  const value: Word = rest ? [{ text: rest, q: "none" }, ...word.slice(1)] : word.slice(1);
  return { name: m[1], value, append: m[2] === "+" };
}

function assign(st: ShellState, a: { name: string; value: Word; append: boolean }): void {
  const v = a.append ? null : expandWord(a.value, st, true);
  // Past the cap a new variable is simply not tracked (unknown), which bounds every copy.
  if (v === null || (!st.vars.has(a.name) && st.vars.size >= MAX_VARS)) st.vars.delete(a.name);
  else st.vars.set(a.name, v);
}

/** Forget everything but `HOME` — after a function call, `source` or `eval`, anything may have changed. */
function forgetAll(st: ShellState): ShellState {
  const home = st.vars.get("HOME");
  return { cwd: null, vars: new Map(home === undefined ? [] : [["HOME", home]]), funcs: st.funcs };
}

/** An arithmetic expression that assigns (`=`, `+=`, `<<=`, `++`, `--`), as opposed to comparing (`==`, `<=`…). */
const ARITH_ASSIGN = /(^|[^=!<>])=(?!=)|<<=|>>=|\+\+|--/;

/** Variables an arithmetic expression may assign: every name in it, if it assigns at all. */
function arithAssigned(expr: string): string[] {
  return ARITH_ASSIGN.test(expr) ? (expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) : [];
}

/** Arithmetic expansions `$(( … ))` inside a command's words. */
function arithInWords(words: Word[]): string[] {
  const out: string[] = [];
  for (const w of words) for (const seg of w) if (seg.bad && seg.text.startsWith("$((")) out.push(seg.text);
  return out;
}

/**
 * The word an option names, given as `-v NAME` or `-vNAME`; undefined when
 * the option is absent.
 */
function optionValue(args: Word[], flag: string): Word | null | undefined {
  for (let i = 0; i < args.length; i++) {
    const p = plain(args[i]);
    if (p === flag) return args[i + 1] ?? null;
    if (p !== null && p.startsWith(flag) && p.length > flag.length) return [{ text: p.slice(flag.length), q: "none" }];
  }
  return undefined;
}

/** Options that take a value, per builtin: their value is not a variable name. */
const OPTION_VALUES: Record<string, string> = { read: "dinNptu", mapfile: "dnOsuCc", readarray: "dnOsuCc", unset: "" };

/** The variable-name arguments of `read`/`mapfile`/`readarray`/`getopts`/`unset`. */
function namedArgs(name: string, args: Word[]): Word[] {
  if (name === "getopts") return args.slice(1, 2);
  const valued = OPTION_VALUES[name] ?? "";
  const out: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const p = plain(args[i]);
    if (p === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (p !== null && /^-[A-Za-z]+$/.test(p)) {
      const last = p[p.length - 1];
      if (last === "a") continue; // `read -a NAME`: the array is the next word, a name
      if (valued.includes(last)) i++; // skip the option's value
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

/** Builtins that set the variables named in their arguments. */
const SETS_NAMED_VARS = new Set(["read", "mapfile", "readarray", "getopts", "unset"]);
/** Variables these set when given no name. */
const DEFAULT_VAR: Record<string, string> = { read: "REPLY", mapfile: "MAPFILE", readarray: "MAPFILE" };

// ── Walking the tree ────────────────────────────────────────────────

/** Words that wrap the next command without changing where it writes. */
const WRAPPERS = new Set(["nohup", "setsid", "exec", "command", "builtin", "time", "stdbuf"]);
const DECLARE_WORDS = new Set(["export", "readonly", "declare", "typeset", "local"]);
const DROPPED = /^\/(dev|proc|sys)(\/|$)/;

interface Outcome {
  ok: MaybeState;
  fail: MaybeState;
}
const both = (s: MaybeState): Outcome => ({ ok: s, fail: s });

interface Found {
  path: string;
  fds: Set<RedirectFd>;
  via: RedirectTarget["via"];
  append: boolean;
}

class Walker {
  found = new Map<string, Found>();
  detached = false;
  private depth = 0;
  /** Commands walked and state entries copied so far — the costs the budgets bound. */
  steps = 0;
  work = 0;
  /** Functions being walked right now — a recursive call is not followed again. */
  private calling = new Set<string>();

  private charge(entries: number): void {
    this.work += entries;
    if (this.work > MAX_WORK) throw new TooComplex("work");
  }

  clone(s: ShellState): ShellState {
    this.charge(s.vars.size + s.funcs.size);
    return { cwd: s.cwd, vars: new Map(s.vars), funcs: new Map(s.funcs) };
  }

  /** What is still known whichever of `a` or `b` actually happened. */
  join(a: MaybeState, b: MaybeState): MaybeState {
    if (!a) return b;
    if (!b || a === b) return a;
    this.charge(a.vars.size + a.funcs.size + b.funcs.size);
    const vars = new Map<string, string>();
    for (const [k, v] of a.vars) if (b.vars.get(k) === v) vars.set(k, v);
    const funcs = new Map<string, Cmd | null>();
    for (const [k, v] of a.funcs) funcs.set(k, b.funcs.has(k) && b.funcs.get(k) === v ? v : null);
    for (const k of b.funcs.keys()) if (!a.funcs.has(k)) funcs.set(k, null);
    return { cwd: a.cwd === b.cwd ? a.cwd : null, vars, funcs };
  }

  add(path: string, fds: RedirectFd[], via: RedirectTarget["via"], append: boolean): void {
    if (DROPPED.test(path)) return;
    const prev = this.found.get(path);
    if (prev) {
      for (const fd of fds) prev.fds.add(fd);
      prev.append ||= append;
      return;
    }
    this.found.set(path, { path, fds: new Set(fds), via, append });
  }

  /** Apply a command's redirections, evaluated in `st`, left to right. */
  redirects(redirs: Redir[], st: ShellState): void {
    if (redirs.length === 0) return;
    type Open = { path: string | null; append: boolean; seq: number } | null;
    const fd: { 1: Open; 2: Open } = { 1: null, 2: null };
    let seq = 0;
    const open = (w: Word | undefined, append: boolean): Open => {
      const v = w ? expandWord(w, st) : null;
      return { path: v === null ? null : resolvePath(v, st.cwd), append, seq: seq++ };
    };
    for (const r of redirs) {
      if (r.op.startsWith("<")) continue;
      if (r.op === "&>" || r.op === "&>>") {
        fd[1] = fd[2] = open(r.target, r.op === "&>>");
        continue;
      }
      const n = r.fd ?? 1;
      if (r.op === ">&") {
        const t = plain(r.target);
        if (t !== null && /^\d+$/.test(t)) {
          const src = Number(t);
          if ((n === 1 || n === 2) && (src === 1 || src === 2)) fd[n] = fd[src];
        } else if (t === "-") {
          if (n === 1 || n === 2) fd[n] = null;
        } else if (r.fd === null) {
          fd[1] = fd[2] = open(r.target, false); // `>& file` is `&> file`
        }
        continue;
      }
      if (n !== 1 && n !== 2) continue;
      fd[n] = open(r.target, r.op === ">>");
    }
    const opened: { o: NonNullable<Open>; fds: RedirectFd[] }[] = [];
    for (const [num, label] of [
      [1, "stdout"],
      [2, "stderr"],
    ] as const) {
      const o = fd[num];
      if (!o?.path) continue;
      const hit = opened.find((x) => x.o.path === o.path);
      if (hit) hit.fds.push(label);
      else opened.push({ o, fds: [label] });
    }
    opened.sort((a, b) => a.o.seq - b.o.seq);
    for (const { o, fds } of opened) this.add(o.path as string, fds, "redirect", o.append);
  }

  // None of the walking methods mutate the state they are given: a change
  // always produces a new state. So states are shared freely, and unchanged
  // paths cost nothing to join.

  list(list: List, st: MaybeState): MaybeState {
    for (const { ao, background } of list) {
      if (!st) return null;
      if (background) {
        // `&` applies to the whole and-or list, which runs in a subshell:
        // nothing it does reaches the commands after it.
        this.detached = true;
        this.andOr(ao, st);
      } else {
        st = this.andOr(ao, st);
      }
    }
    return st;
  }

  /**
   * An and-or list. Failures are tracked in two parts: those that skipped the
   * most recent pipeline (`skipped`), and that pipeline's own (`own`). Nothing
   * tests the last pipeline's own failure, so — as for any plain command — it
   * is assumed to succeed; failures that were tested and fell through (`cd x
   * || true`, `cd x && y`) still count.
   */
  andOr(ao: AndOr, st: ShellState): MaybeState {
    const first = this.pipeline(ao.first, st);
    let ok = first.ok;
    let own = first.fail;
    let skipped: MaybeState = null;
    for (const { op, p } of ao.rest) {
      if (op === "&&") {
        skipped = this.join(skipped, own);
        if (!ok) {
          own = null;
          continue;
        }
        const r = this.pipeline(p, ok);
        ok = r.ok;
        own = r.fail;
      } else {
        const failed = this.join(skipped, own);
        skipped = null;
        if (!failed) {
          own = null;
          continue;
        }
        const r = this.pipeline(p, failed);
        ok = this.join(ok, r.ok);
        own = r.fail;
      }
    }
    return this.join(ok ?? own, skipped);
  }

  pipeline(p: Pipeline, st: ShellState): Outcome {
    let out: Outcome;
    if (p.cmds.length === 1) {
      out = this.command(p.cmds[0], st, false);
    } else {
      // Every part of a multi-command pipeline runs in its own subshell.
      p.cmds.forEach((c, k) => this.command(c, st, p.stderrIn[k]));
      out = both(st);
    }
    return p.bang ? { ok: out.fail, fail: out.ok } : out;
  }

  command(cmd: Cmd, st: ShellState, stderrIn: boolean): Outcome {
    if (++this.steps > MAX_STEPS) throw new TooComplex("steps");
    if (++this.depth > MAX_NESTING) throw new TooComplex("nesting");
    try {
      return this.commandAt(cmd, st, stderrIn);
    } finally {
      this.depth--;
    }
  }

  private commandAt(cmd: Cmd, st: ShellState, stderrIn: boolean): Outcome {
    switch (cmd.t) {
      case "simple":
        return this.simple(cmd, st, stderrIn);
      case "subshell":
        this.redirects(cmd.redirs, st);
        this.list(cmd.body, st);
        return both(st);
      case "group":
        this.redirects(cmd.redirs, st);
        return both(this.list(cmd.body, st));
      case "if": {
        this.redirects(cmd.redirs, st);
        let cur: MaybeState = st;
        let result: MaybeState = null;
        for (const { cond, body } of cmd.clauses) {
          if (!cur) break;
          cur = this.list(cond, cur);
          if (!cur) break;
          result = this.join(result, this.list(body, cur));
        }
        result = this.join(result, cur && cmd.orElse ? this.list(cmd.orElse, cur) : cur);
        return both(result);
      }
      case "loop": {
        this.redirects(cmd.redirs, st);
        let entry: MaybeState = st;
        if (cmd.forVar && st.vars.has(cmd.forVar)) {
          entry = this.clone(st);
          entry.vars.delete(cmd.forVar);
        }
        if (cmd.cond) entry = this.list(cmd.cond, entry);
        if (!entry) return both(null);
        // Zero or more iterations: whatever the body changes is unknown afterwards.
        const after = this.list(cmd.body, entry);
        const again = after && cmd.cond ? this.list(cmd.cond, after) : after;
        return both(this.join(entry, again));
      }
      case "case": {
        this.redirects(cmd.redirs, st);
        let result: MaybeState = st; // no arm may match
        for (const arm of cmd.arms) result = this.join(result, this.list(arm, st));
        return both(result);
      }
      case "arith":
        this.redirects(cmd.redirs, st);
        return both(this.forgetNames(st, arithAssigned(cmd.text)));
      case "func": {
        // Defining a function runs nothing. Its body is walked where it is
        // called, with the state there.
        const next = this.clone(st);
        if (cmd.name) next.funcs.set(cmd.name, cmd.body);
        return both(next);
      }
    }
  }

  /** A call to a defined function: walk its body with the caller's state, then assume anything changed. */
  call(name: string, st: ShellState, stderrIn: boolean): Outcome {
    const body = st.funcs.get(name);
    if (body && !this.calling.has(name)) {
      this.calling.add(name);
      try {
        this.command(body, st, stderrIn);
      } finally {
        this.calling.delete(name);
      }
    }
    return both(forgetAll(st));
  }

  simple(cmd: Extract<Cmd, { t: "simple" }>, st: ShellState, stderrIn: boolean): Outcome {
    // `$(( L = … ))` assigns while the words are expanded, before anything else.
    for (const expr of arithInWords([...cmd.words, ...cmd.redirs.flatMap((r) => (r.target ? [r.target] : []))])) {
      st = this.forgetNames(st, arithAssigned(expr.slice(3)));
    }
    let words = cmd.words;
    const assigns: ReturnType<typeof splitAssignment>[] = [];
    while (words.length) {
      const a = splitAssignment(words[0]);
      if (!a) break;
      assigns.push(a);
      words = words.slice(1);
    }

    // Redirections are expanded before the command's own assignments take
    // effect, and prefix assignments (`L=x cmd`) never reach the shell.
    this.redirects(cmd.redirs, st);

    if (words.length === 0) {
      if (assigns.length === 0) return both(st);
      // Past the variable cap, new names are not tracked: nothing changes, nothing to copy.
      if (st.vars.size >= MAX_VARS && assigns.every((a) => !st.vars.has(a!.name))) return { ok: st, fail: null };
      const next = this.clone(st);
      for (const a of assigns) assign(next, a!);
      return { ok: next, fail: null };
    }

    let k = 0;
    for (;;) {
      const w = plain(words[k]);
      if (w === "nohup" || w === "setsid") this.detached = true;
      if (w !== null && WRAPPERS.has(w)) k++;
      else if (w === "sudo" && words[k + 1] && !(plain(words[k + 1]) ?? "").startsWith("-")) k++;
      else break;
    }
    words = words.slice(k);
    const name = plain(words[0]);
    const args = words.slice(1);

    if (name !== null && st.funcs.has(name)) return this.call(name, st, stderrIn);

    switch (name) {
      case "exit":
      case "return":
        return { ok: null, fail: null };
      case "true":
      case ":":
        return { ok: st, fail: null };
      case "false":
        return { ok: null, fail: st };
      case "disown":
        this.detached = true;
        return both(st);
      case "cd":
      case "pushd": {
        const next = this.clone(st);
        const operands = args.filter((w) => {
          const p = plain(w);
          return !(p && p.startsWith("-") && p !== "-");
        });
        if (operands.length === 0) next.cwd = name === "cd" ? (st.vars.get("HOME") ?? null) : null;
        else {
          const target = plain(operands[0]) === "-" ? null : expandWord(operands[0], st);
          next.cwd = target === null ? null : resolvePath(target, st.cwd);
        }
        // A failed cd leaves the directory where it was.
        return { ok: next, fail: st };
      }
      case "popd":
        return { ok: { ...this.clone(st), cwd: null }, fail: st };
      case "source":
      case ".":
      case "eval":
        return both(forgetAll(st));
      case "printf":
      case "wait": {
        const v = optionValue(args, name === "printf" ? "-v" : "-p");
        if (v === undefined) return both(st);
        return both(v === null ? forgetAll(st) : this.forget(st, [v]));
      }
      case "let":
        return both(
          this.forgetNames(
            st,
            args.flatMap((w) => arithAssigned(wordText(w))),
          ),
        );
      case "tee": {
        let append = false;
        let options = true;
        const files: Word[] = [];
        for (const w of args) {
          const p = plain(w);
          if (options && p === "--") options = false;
          else if (options && p === "--append") append = true;
          else if (options && p && p.startsWith("--")) continue;
          else if (options && p && /^-[a-z]+$/.test(p)) append ||= p.includes("a");
          else files.push(w);
        }
        const fds: RedirectFd[] = stderrIn ? ["stdout", "stderr"] : ["stdout"];
        for (const w of files) {
          const v = expandWord(w, st);
          const path = v === null ? null : resolvePath(v, st.cwd);
          if (path) this.add(path, fds, "tee", append);
        }
        return both(st);
      }
    }
    if (name !== null && SETS_NAMED_VARS.has(name)) {
      const next = this.forget(st, namedArgs(name, args), name === "unset");
      if (DEFAULT_VAR[name]) next.vars.delete(DEFAULT_VAR[name]);
      return both(next);
    }
    if (name !== null && DECLARE_WORDS.has(name)) {
      // With options (`-n` namerefs, `-i` arithmetic, `-a` arrays…) values
      // are not plain strings: forget every name instead of assigning it.
      const optioned = args.some((w) => /^[-+]/.test(plain(w) ?? ""));
      const next = this.clone(st);
      for (const w of args) {
        if (/^[-+]/.test(plain(w) ?? "")) continue;
        const a = splitAssignment(w);
        if (a && !optioned) assign(next, a);
        else if (a) next.vars.delete(a.name);
        else if (name !== "export" && name !== "readonly") {
          const p = plain(w);
          if (p === null || !NAME.test(p)) return both(forgetAll(st));
          next.vars.delete(p);
        }
      }
      return both(next);
    }
    return both(st);
  }

  /**
   * Forget the variables named by `words` (and, for `unset`, functions). A
   * name that is not literal could be any variable, so everything goes.
   */
  forget(st: ShellState, words: Word[], functionsToo = false): ShellState {
    const next = this.clone(st);
    for (const w of words) {
      const p = plain(w);
      if (p === null || !NAME.test(p)) return forgetAll(st);
      next.vars.delete(p);
      if (functionsToo) next.funcs.delete(p);
    }
    return next;
  }

  /** Forget the given variable names (no-op, and no copy, when none is known). */
  forgetNames(st: ShellState, names: string[]): ShellState {
    if (!names.some((n) => st.vars.has(n))) return st;
    const next = this.clone(st);
    for (const n of names) next.vars.delete(n);
    return next;
  }
}

/** Parse `command` once: its redirect targets and whether it detaches. */
export function analyzeShellCommand(command: string, ctx: RedirectContext): ShellCommandAnalysis {
  const nothing: ShellCommandAnalysis = { targets: [], detached: false };
  if (typeof command !== "string" || command.length > MAX_COMMAND_LENGTH) return nothing;
  // Runs inside render in the browser and on every poll in the daemon: a
  // command too deep or too costly to follow (or a bug here) means "nothing
  // to tail", never an exception.
  try {
    return analyze(command, ctx);
  } catch {
    return nothing;
  }
}

interface AnalysisProbe {
  tokens?: number;
  walker?: Walker;
}

function analyze(command: string, ctx: RedirectContext, probe: AnalysisProbe = {}): ShellCommandAnalysis {
  const toks = tokenize(command);
  probe.tokens = toks.length;
  const parser = new Parser(toks);
  const tree: List = [];
  // A stray closer (`)`, `fi`, `;;`) ends a list early: step over it and carry on.
  while (parser.peek()) {
    tree.push(...parser.list());
    if (parser.peek()) parser.i++;
  }
  const walker = new Walker();
  probe.walker = walker;
  const cwd = ctx.cwd.startsWith("/") ? normalizeAbs(ctx.cwd) : null;
  walker.list(tree, { cwd, vars: new Map([["HOME", ctx.home]]), funcs: new Map() });
  const targets = [...walker.found.values()].slice(0, MAX_REDIRECT_TARGETS).map((f) => ({
    path: f.path,
    fds: (["stdout", "stderr"] as const).filter((x) => f.fds.has(x)),
    via: f.via,
    append: f.append,
  }));
  return { targets, detached: walker.detached };
}

/** What one analysis cost, for tests: deterministic counts in place of wall-clock time. */
export interface AnalysisCost {
  tokens: number;
  steps: number;
  work: number;
  /** A limit (nesting, steps, work) stopped it; it reported nothing. */
  bailed: boolean;
  result: ShellCommandAnalysis;
}
export const ANALYSIS_LIMITS = { MAX_NESTING, MAX_STEPS, MAX_WORK, MAX_VARS } as const;

/** Test-only: run the analysis and report its cost. */
export function analysisCostForTest(command: string, ctx: RedirectContext): AnalysisCost {
  const probe: AnalysisProbe = {};
  try {
    const result = analyze(command, ctx, probe);
    return { tokens: probe.tokens ?? 0, steps: probe.walker?.steps ?? 0, work: probe.walker?.work ?? 0, bailed: false, result };
  } catch (err) {
    if (!(err instanceof TooComplex)) throw err;
    return {
      tokens: probe.tokens ?? 0,
      steps: probe.walker?.steps ?? 0,
      work: probe.walker?.work ?? 0,
      bailed: true,
      result: { targets: [], detached: false },
    };
  }
}

export function extractRedirectTargets(command: string, ctx: RedirectContext): RedirectTarget[] {
  return analyzeShellCommand(command, ctx).targets;
}

/** A job sent to the background with `&`, or a `nohup`/`setsid`/`disown` command — read from the parsed command, so quoted text never counts. */
export function looksDetached(command: string): boolean {
  return analyzeShellCommand(command, { cwd: "/", home: "/" }).detached;
}

/**
 * The client's hint for showing an "Output" row on a call with no engine
 * task: the command detaches and writes to at least one file the daemon
 * would tail. The daemon's own check is the same analysis with the real cwd
 * and home; placeholders here only change where relative paths point.
 */
export function looksDetachedWithRedirect(command: string | null | undefined): boolean {
  if (typeof command !== "string" || command === "") return false;
  const { targets, detached } = analyzeShellCommand(command, { cwd: "/__cwd__", home: "/__home__" });
  return detached && targets.length > 0;
}
