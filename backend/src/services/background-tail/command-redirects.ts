/**
 * Which files does a shell command write its output to?
 *
 * A pure, deliberately conservative reading of the Bash command recorded in
 * a transcript, so the live tail can follow `nohup rsync … > $L/rsync.log
 * 2> $L/rsync.err &` as well as the engine's own `.output` file. It is not a
 * shell: it understands quoting, `;`/`&&`/`||`/`|`/`&`/newlines, subshells,
 * plain assignments (`L=~/logs`, `export L=…`), `cd`/`pushd`, the common
 * redirection forms and `tee`. Anything it cannot resolve for certain — an
 * unknown variable, a command substitution, a glob, a relative path after a
 * `cd` it could not follow — is skipped, never guessed.
 *
 * The command is the one stored in the chat's own transcript; the client
 * never supplies a path. See `index.ts` for the read policy applied to what
 * this returns.
 */
import { posix } from "path";

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

/** Targets returned at most. */
export const MAX_REDIRECT_TARGETS = 8;
/** Commands longer than this are not parsed at all. */
export const MAX_COMMAND_LENGTH = 64 * 1024;

// ── Tokens ──────────────────────────────────────────────────────────

/** A run of characters with one quoting. `bad` marks text that cannot be resolved (`$(…)`, backticks, `$'…'`). */
interface Seg {
  text: string;
  q: "none" | "single" | "double";
  bad?: boolean;
}
type Word = Seg[];
type Tok = { t: "word"; w: Word } | { t: "op"; op: string } | { t: "redir"; fd: number | null; op: string };

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

/** Index just past the backtick that closes the one before `i`. */
function skipBacktick(s: string, i: number): number {
  while (i < s.length && s[i] !== "`") i += s[i] === "\\" ? 2 : 1;
  return Math.min(i + 1, s.length);
}

/** Index just past the `}` closing a `${` opened before `i`. */
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

function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  let word: Word = [];
  let started = false;

  const push = (text: string, q: Seg["q"], bad = false) => {
    started = true;
    const last = word[word.length - 1];
    if (last && last.q === q && !last.bad && !bad) last.text += text;
    else word.push({ text, q, ...(bad && { bad }) });
  };
  const finish = () => {
    if (started) toks.push({ t: "word", w: word });
    word = [];
    started = false;
  };
  /** A word made only of unquoted digits, directly before `>`/`<`, is a file-descriptor number. */
  const takeFd = (): number | null => {
    if (word.length === 1 && word[0].q === "none" && !word[0].bad && /^\d{1,2}$/.test(word[0].text)) {
      const fd = Number(word[0].text);
      word = [];
      started = false;
      return fd;
    }
    finish();
    return null;
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
      toks.push({ t: "op", op: ";" });
      i++;
    } else if (c === "#" && !started) {
      while (i < s.length && s[i] !== "\n") i++;
    } else if (c === ";") {
      finish();
      toks.push({ t: "op", op: ";" });
      i += n === ";" ? 2 : 1;
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
      // Heredoc bodies are free text: stop here rather than misread them.
      if (op === "<<" || op === "<<-") return toks;
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

// ── Expansion ───────────────────────────────────────────────────────

interface ShellState {
  /** null once a `cd` could not be followed. */
  cwd: string | null;
  vars: Map<string, string>;
}

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
      // A lone `$` is literal.
      out += "$";
      i++;
    } else {
      // `$?`, `$1`, `$$`, `$(`…: not knowable.
      return null;
    }
  }
  return out;
}

const GLOB = /[*?[]/;
const BRACE_EXPANSION = /\{[^{}]*,[^{}]*\}/;

/**
 * Expand a word the way the shell would for a redirection target or a plain
 * argument, or return null when that cannot be known for certain.
 * `assignment` drops word splitting and globbing (assignment values get
 * neither) — the caller has already removed the `NAME=` prefix.
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
      // Literal glob or brace characters in unquoted text.
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

/** `NAME=value` with the name and `=` unquoted: the name and the value's word, else null. */
function splitAssignment(word: Word): { name: string; value: Word } | null {
  const first = word[0];
  if (!first || first.q !== "none" || first.bad) return null;
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(first.text);
  if (!m || first.text[m[0].length - 2] === "+") return null; // `+=` appends; not followed
  const rest = first.text.slice(m[0].length);
  const value: Word = rest ? [{ text: rest, q: "none" }, ...word.slice(1)] : word.slice(1);
  return { name: m[1], value };
}

function resolvePath(p: string, cwd: string | null): string | null {
  if (!p || p.includes("\0")) return null;
  if (posix.isAbsolute(p)) return posix.normalize(p);
  if (cwd === null) return null;
  return posix.resolve(cwd, p);
}

// ── Walking commands ────────────────────────────────────────────────

interface Redir {
  fd: number | null;
  op: string;
  target?: Word;
}
interface Cmd {
  words: Word[];
  redirs: Redir[];
  /** Fed by `|&`: the pipe carries stderr too. */
  stderrIn: boolean;
}

/** Words that open or continue a compound command, or wrap the next command without changing where it writes. */
const PREFIX_WORDS = new Set([
  "{",
  "}",
  "!",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "do",
  "done",
  "while",
  "until",
  "time",
  "nohup",
  "setsid",
  "exec",
  "command",
  "builtin",
]);
const DECLARE_WORDS = new Set(["export", "readonly", "declare", "typeset", "local"]);
const DROPPED = /^\/(dev|proc|sys)(\/|$)/;

/** Fast check for a word that is literally `w`, unquoted. */
function plain(word: Word): string | null {
  return word.length === 1 && word[0].q === "none" && !word[0].bad ? word[0].text : null;
}

interface Found {
  path: string;
  fds: Set<RedirectFd>;
  via: RedirectTarget["via"];
  append: boolean;
}

export function extractRedirectTargets(command: string, ctx: RedirectContext): RedirectTarget[] {
  if (typeof command !== "string" || command.length > MAX_COMMAND_LENGTH) return [];
  const toks = tokenize(command);

  const found = new Map<string, Found>();
  const add = (path: string, fds: RedirectFd[], via: RedirectTarget["via"], append: boolean) => {
    if (DROPPED.test(path)) return;
    const prev = found.get(path);
    if (prev) {
      for (const fd of fds) prev.fds.add(fd);
      prev.append ||= append;
      return;
    }
    found.set(path, { path, fds: new Set(fds), via, append });
  };

  let state: ShellState = { cwd: posix.isAbsolute(ctx.cwd) ? posix.normalize(ctx.cwd) : null, vars: new Map([["HOME", ctx.home]]) };
  const stack: ShellState[] = [];
  const clone = (s: ShellState): ShellState => ({ cwd: s.cwd, vars: new Map(s.vars) });

  const runCmd = (cmd: Cmd, persist: boolean) => {
    let words = cmd.words;
    // Leading assignments: kept only when they are the whole command.
    const assigns: { name: string; value: Word }[] = [];
    while (words.length) {
      const a = splitAssignment(words[0]);
      if (!a) break;
      assigns.push(a);
      words = words.slice(1);
    }
    if (words.length === 0 && persist) {
      for (const a of assigns) {
        const v = expandWord(a.value, state, true);
        if (v === null) state.vars.delete(a.name);
        else state.vars.set(a.name, v);
      }
    }
    while (words.length && PREFIX_WORDS.has(plain(words[0]) ?? "")) words = words.slice(1);
    if (words.length && plain(words[0]) === "sudo" && words[1] && !(plain(words[1]) ?? "").startsWith("-")) words = words.slice(1);

    const name = words.length ? plain(words[0]) : null;
    const args = words.slice(1);
    if ((name === "cd" || name === "pushd") && persist) {
      const operands = args.filter((w) => {
        const p = plain(w);
        return !(p && p.startsWith("-") && p !== "-");
      });
      if (operands.length === 0) state.cwd = state.vars.get("HOME") ?? null;
      else {
        const target = plain(operands[0]) === "-" ? null : expandWord(operands[0], state);
        state.cwd = target === null ? null : resolvePath(target, state.cwd);
      }
    } else if (name === "popd" && persist) {
      state.cwd = null;
    } else if (name && DECLARE_WORDS.has(name) && persist) {
      for (const w of args) {
        const a = splitAssignment(w);
        if (!a) continue;
        const v = expandWord(a.value, state, true);
        if (v === null) state.vars.delete(a.name);
        else state.vars.set(a.name, v);
      }
    } else if (name === "tee") {
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
      const fds: RedirectFd[] = cmd.stderrIn ? ["stdout", "stderr"] : ["stdout"];
      for (const w of files) {
        const v = expandWord(w, state);
        const path = v === null ? null : resolvePath(v, state.cwd);
        if (path) add(path, fds, "tee", append);
      }
    }

    // File-descriptor table for this command, left to right. `null` is the
    // inherited destination (the engine's output file, or the pipe).
    type Open = { path: string | null; append: boolean; seq: number } | null;
    const fd: { 1: Open; 2: Open } = { 1: null, 2: null };
    let seq = 0;
    const open = (w: Word | undefined, append: boolean): Open => {
      const v = w ? expandWord(w, state) : null;
      return { path: v === null ? null : resolvePath(v, state.cwd), append, seq: seq++ };
    };
    for (const r of cmd.redirs) {
      if (r.op.startsWith("<")) continue;
      if (r.op === "&>" || r.op === "&>>") {
        fd[1] = fd[2] = open(r.target, r.op === "&>>");
        continue;
      }
      const n = r.fd ?? 1;
      if (r.op === ">&") {
        const t = r.target ? plain(r.target) : null;
        if (t !== null && /^\d+$/.test(t)) {
          const src = Number(t);
          if ((n === 1 || n === 2) && (src === 1 || src === 2)) fd[n] = fd[src];
        } else if (t === "-") {
          if (n === 1 || n === 2) fd[n] = null;
        } else if (r.fd === null) {
          // `>& file` is `&> file`.
          fd[1] = fd[2] = open(r.target, false);
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
    for (const { o, fds } of opened) add(o.path as string, fds, "redirect", o.append);
  };

  let pipeline: Cmd[] = [];
  let cmd: Cmd = { words: [], redirs: [], stderrIn: false };
  let pending: Redir | null = null;

  const endCmd = (nextStderr = false) => {
    pending = null;
    if (cmd.words.length || cmd.redirs.length) pipeline.push(cmd);
    cmd = { words: [], redirs: [], stderrIn: nextStderr };
  };
  const endPipeline = (background: boolean) => {
    endCmd();
    const persist = pipeline.length === 1 && !background;
    for (const c of pipeline) runCmd(c, persist);
    pipeline = [];
  };

  for (const tok of toks) {
    if (tok.t === "word") {
      if (pending) {
        pending.target = tok.w;
        pending = null;
      } else cmd.words.push(tok.w);
    } else if (tok.t === "redir") {
      if (tok.op === "<<" || tok.op === "<<-") break;
      const r: Redir = { fd: tok.fd, op: tok.op };
      cmd.redirs.push(r);
      pending = r;
    } else if (tok.op === "|" || tok.op === "|&") {
      endCmd(tok.op === "|&");
    } else {
      endPipeline(tok.op === "&");
      if (tok.op === "(") {
        stack.push(state);
        state = clone(state);
      } else if (tok.op === ")" && stack.length) {
        state = stack.pop() as ShellState;
      }
    }
  }
  endPipeline(false);

  return [...found.values()].slice(0, MAX_REDIRECT_TARGETS).map((f) => ({
    path: f.path,
    fds: (["stdout", "stderr"] as const).filter((x) => f.fds.has(x)),
    via: f.via,
    append: f.append,
  }));
}

/**
 * A command that keeps running after the tool call returns: `nohup`,
 * `setsid` or `disown`, or a job sent to the background with a lone `&`.
 * A hint for eligibility only.
 */
export function looksDetached(command: string): boolean {
  if (typeof command !== "string") return false;
  if (/(^|[\s;&|(])(nohup|setsid|disown)(\s|$|;)/.test(command)) return true;
  return /(^|[^&>|<])&(?![&>])/.test(command);
}
