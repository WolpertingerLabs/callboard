import { describe, expect, it } from "vitest";
import { extractRedirectTargets, looksDetached, MAX_REDIRECT_TARGETS, type RedirectTarget } from "./command-redirects.js";

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
  ];
  it.each(skipped)("skips: %s", (_name, cmd) => {
    expect(run(cmd)).toEqual([]);
  });

  it("keeps an absolute target after cd -", () => {
    expect(brief(run("cd -; cmd > /abs/x.log"))).toEqual(["redirect:stdout:/abs/x.log"]);
  });

  it("stops at a heredoc and keeps what came before", () => {
    expect(brief(run("a > before.log; cat <<EOF > after.log\n> inside.log\nEOF\nb > later.log"))).toEqual(["redirect:stdout:/work/proj/before.log"]);
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
  ])("%s → %s", (cmd, want) => {
    expect(looksDetached(cmd)).toBe(want);
  });
});
