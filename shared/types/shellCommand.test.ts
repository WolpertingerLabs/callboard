import { describe, expect, it } from "vitest";
import { extractRedirectTargets, looksDetached, looksDetachedWithRedirect, MAX_REDIRECT_TARGETS, type RedirectTarget } from "./shellCommand.js";

const ctx = { cwd: "/work/proj", home: "/home/u" };
const run = (cmd: string) => extractRedirectTargets(cmd, ctx);
const brief = (ts: RedirectTarget[]) => ts.map((t) => `${t.via}:${t.fds.join("+")}:${t.path}${t.append ? " (a)" : ""}`);

describe("extractRedirectTargets", () => {
  const cases: [string, string, string[]][] = [
    [
      "the rsync launch this was built for",
      "L=~/backup/logs; nohup rsync -a src/ dst/ > $L/rsync.log 2> $L/rsync.err &",
      ["redirect:stdout:/home/u/backup/logs/rsync.log", "redirect:stderr:/home/u/backup/logs/rsync.err"],
    ],
    ["> f 2>&1 sends both to f", "make > build.log 2>&1", ["redirect:stdout+stderr:/work/proj/build.log"]],
    ["2>&1 > f: order matters, stdout only", "make 2>&1 > build.log", ["redirect:stdout:/work/proj/build.log"]],
    ["&>", "make &> all.log", ["redirect:stdout+stderr:/work/proj/all.log"]],
    ["&>> appends", "make &>> all.log", ["redirect:stdout+stderr:/work/proj/all.log (a)"]],
    [">> appends", "echo hi >> out.log", ["redirect:stdout:/work/proj/out.log (a)"]],
    [">| clobbers", "echo hi >| out.log", ["redirect:stdout:/work/proj/out.log"]],
    ["1>&2 copies stderr's target", "cmd 2> e.log 1>&2", ["redirect:stdout+stderr:/work/proj/e.log"]],
    [">& file is &> file", "cmd >& both.log", ["redirect:stdout+stderr:/work/proj/both.log"]],
    ["no space before >", "echo hi>x.log", ["redirect:stdout:/work/proj/x.log"]],
    ["cd then a relative target", "cd sub && cmd > out.log", ["redirect:stdout:/work/proj/sub/out.log"]],
    ["cd .. normalises", "cd ../other; cmd > out.log", ["redirect:stdout:/work/other/out.log"]],
    ["bare cd goes home", "cd; cmd > out.log", ["redirect:stdout:/home/u/out.log"]],
    [
      "cd inside a subshell does not leak",
      "(cd sub && a > in.log); b > out.log",
      ["redirect:stdout:/work/proj/sub/in.log", "redirect:stdout:/work/proj/out.log"],
    ],
    ["redirect on a subshell uses the outer cwd", "(cd sub; a) > out.log", ["redirect:stdout:/work/proj/out.log"]],
    ["cd in a pipeline does not persist", "cd sub | cat; b > out.log", ["redirect:stdout:/work/proj/out.log"]],
    ["tee -a with two files", "cmd | tee -a a.log b.log", ["tee:stdout:/work/proj/a.log (a)", "tee:stdout:/work/proj/b.log (a)"]],
    ["tee -- ends options", "cmd | tee -- -weird.log", ["tee:stdout:/work/proj/-weird.log"]],
    ["tee --append", "cmd | tee --append x.log", ["tee:stdout:/work/proj/x.log (a)"]],
    ["|& tee carries stderr", "cmd |& tee x.log", ["tee:stdout+stderr:/work/proj/x.log"]],
    ["double-quoted variable with a space", 'L=/var/log; cmd > "$L/my log.txt"', ["redirect:stdout:/var/log/my log.txt"]],
    ["single quotes are literal", "cmd > '$L/x'", ["redirect:stdout:/work/proj/$L/x"]],
    ["escaped space", "cmd > my\\ log.txt", ["redirect:stdout:/work/proj/my log.txt"]],
    ["${L}", "L=/a; cmd > ${L}/b.log", ["redirect:stdout:/a/b.log"]],
    ["export L=", "export L=~/logs; cmd > $L/x.log", ["redirect:stdout:/home/u/logs/x.log"]],
    ["$HOME", "cmd > $HOME/x.log", ["redirect:stdout:/home/u/x.log"]],
    ["tilde", "cmd > ~/x.log", ["redirect:stdout:/home/u/x.log"]],
    ["duplicates merge", "a > x.log; b 2> x.log", ["redirect:stdout+stderr:/work/proj/x.log"]],
    ["absolute stays absolute", "cd sub; a > /tmp/x.log", ["redirect:stdout:/tmp/x.log"]],
    ["comment ignored", "a > x.log # > y.log", ["redirect:stdout:/work/proj/x.log"]],
    ["fd 3 ignored", "a 3> three.log > one.log", ["redirect:stdout:/work/proj/one.log"]],
    ["cd || exit keeps the cd", "cd /x || exit 1; y > r.log", ["redirect:stdout:/x/r.log"]],
    ["cd && list keeps the cd", "cd sub && make; y > r.log", ["redirect:stdout:/work/proj/sub/r.log"]],
    ["same value on both branches", "if c; then L=/a; else L=/a; fi; y > $L/f", ["redirect:stdout:/a/f"]],
    ["loop leaves untouched state alone", "L=/a; for i in 1 2; do :; done; y > $L/x", ["redirect:stdout:/a/x"]],
    ["redirect inside if", "if [ x ]; then nohup y > a.log & fi", ["redirect:stdout:/work/proj/a.log"]],
    ["redirect on a whole loop", "while read l; do echo $l; done > loop.log", ["redirect:stdout:/work/proj/loop.log"]],
    ["redirect inside a function body", "f() { y > in.log; }", ["redirect:stdout:/work/proj/in.log"]],
    ["assignment then redirect", "L=/t; > $L/f", ["redirect:stdout:/t/f"]],
    // `&` backgrounds the whole and-or list / group, in a subshell.
    ["& on a && list", "cd /x && nohup y > a.log & echo > b.log", ["redirect:stdout:/x/a.log", "redirect:stdout:/work/proj/b.log"]],
    ["& on a brace group", "{ cd /x; y > a.log; } & z > b.log", ["redirect:stdout:/x/a.log", "redirect:stdout:/work/proj/b.log"]],
    ["brace group without & persists", "{ cd /x; y > a.log; }; z > b.log", ["redirect:stdout:/x/a.log", "redirect:stdout:/x/b.log"]],
    ["redirect on a brace group", "{ a; b; } > g.log 2>&1", ["redirect:stdout+stderr:/work/proj/g.log"]],
  ];
  it.each(cases)("%s", (_name, cmd, want) => {
    expect(brief(run(cmd))).toEqual(want);
  });

  const skipped: [string, string][] = [
    ["prefix-scoped assignment is not stored", "L=/x cmd > $L/f"],
    ["command substitution", "cmd > $(date).log"],
    ["backticks", "cmd > `date`.log"],
    ["unknown variable", "cmd > $UNKNOWN/x"],
    ["default-value expansion", "cmd > ${L:-/tmp}/x"],
    ["glob", "cmd > *.log"],
    ["brace expansion", "cmd > {a,b}.log"],
    ["cd - makes cwd unknown", "cd -; cmd > x.log"],
    ["cd to an unknown place", "cd $SOMEWHERE && cmd > x.log"],
    ["/dev/null", "cmd > /dev/null 2>&1"],
    ["/dev/stderr", "cmd > /dev/stderr"],
    ["input redirects", "cmd < in.txt"],
    ["here-string", "cat <<< hello"],
    ["~user", "cmd > ~bob/x"],
    ["unquoted expansion with a space", 'L="a b"; cmd > $L'],
    ["positional parameter", "cmd > $1.log"],
    // State that only one branch sets is unknown afterwards.
    ["&& / || assignment", "[ -d /a ] && L=/a || L=/b; nohup x > $L/log &"],
    ["if/else cd", "if [ -d /a ]; then cd /a; else cd /b; fi; nohup x > rel.log &"],
    ["|| cd", "test -d /x || cd /y; y > r.log"],
    ["case arm cd", "case $x in a) cd /a;; esac; y > r.log"],
    ["cd in a loop body", "cd /x; while read l; do cd /z; done < f; y > r.log"],
    ["then-branch assignment seen from else", "if c; then L=/a; else x > $L/f; fi"],
    ["&& assignment that may not run", "L=/b; [ -d /a ] && L=/a; x > $L/f"],
    ["cd /a || cd /b", "cd /a || cd /b; y > r.log"],
    ["for variable", "for f in a b; do echo > $f.log; done"],
    ["function call may change anything", "f() { cd /x; }; f; y > r.log"],
    ["source", "source env.sh; y > r.log"],
    // Redirects are expanded before the command's own assignments.
    ["assignment-only command's redirect", "L=/t > $L/f"],
    ["named fd", "exec {fd}>fd.log"],
    ["sequence brace expansion", "cmd > log{1..3}"],
  ];
  it.each(skipped)("skips: %s", (_name, cmd) => {
    expect(run(cmd)).toEqual([]);
  });

  it("keeps an absolute target after cd -", () => {
    expect(brief(run("cd -; cmd > /abs/x.log"))).toEqual(["redirect:stdout:/abs/x.log"]);
  });

  it("skips heredoc bodies and keeps parsing after them", () => {
    expect(brief(run("nohup python - <<EOF > py.log\nprint(1) > not.log\nEOF\nz > after.log"))).toEqual([
      "redirect:stdout:/work/proj/py.log",
      "redirect:stdout:/work/proj/after.log",
    ]);
    expect(brief(run("cat <<-'END' 2> err.log\n\tx > no.log\n\tEND\ny >> after.log"))).toEqual([
      "redirect:stderr:/work/proj/err.log",
      "redirect:stdout:/work/proj/after.log (a)",
    ]);
  });

  it("caps the number of targets", () => {
    const cmd = Array.from({ length: 12 }, (_, i) => `a > f${i}.log`).join("; ");
    const out = run(cmd);
    expect(out).toHaveLength(MAX_REDIRECT_TARGETS);
    expect(out[0].path).toBe("/work/proj/f0.log");
  });

  it("does not parse very long commands", () => {
    expect(run("a > x.log; " + "x".repeat(70 * 1024))).toEqual([]);
  });

  it("orders targets as they appear in the command", () => {
    expect(brief(run("a 2> err.log > out.log"))).toEqual(["redirect:stderr:/work/proj/err.log", "redirect:stdout:/work/proj/out.log"]);
  });

  it("skips relative targets when the starting cwd is not absolute", () => {
    expect(extractRedirectTargets("a > x.log", { cwd: "", home: "/h" })).toEqual([]);
  });
});

describe("looksDetached", () => {
  it.each([
    ["nohup cmd > x", true],
    ["setsid cmd", true],
    ["cmd > x &", true],
    ["cmd & echo started", true],
    ["cmd > x 2>&1", false],
    ["a && b", false],
    ["a &> x", false],
    ["a |& tee x", false],
    ["echo nohup-ish", false],
    ["curl 'http://a?b=1&c=2' > out.json", false],
    ["grep nohup f > out", false],
    ['echo "a & b"', false],
    ["( y & )", true],
    ["sudo nohup y", true],
    ["y & disown", true],
  ])("%s → %s", (cmd, want) => {
    expect(looksDetached(cmd)).toBe(want);
  });
});

// Mirrored in the client: frontend/src/utils/backgroundTasks.ts re-exports this.
describe("looksDetachedWithRedirect", () => {
  it.each([
    ["L=~/backup/logs; nohup rsync -a src/ dst/ > $L/rsync.log 2> $L/rsync.err &", true],
    ["setsid ./server > server.log 2>&1", true],
    ["./build.sh > build.log &", true],
    ["./build.sh 2>&1 | tee build.log &", true],
    ["nohup ./server &", false],
    ["nohup ./server > /dev/null 2>&1 &", false],
    ["npm run dev >/dev/null 2>&1 &", false],
    ["make > build.log 2>&1", false],
    ["curl 'http://x/?a=1&b=2' > page.html", false],
    ["a && b > out.log", false],
    ["make &> all.log", false],
    ["", false],
    [undefined, false],
  ])("%s → %s", (cmd, want) => {
    expect(looksDetachedWithRedirect(cmd)).toBe(want);
  });
});
