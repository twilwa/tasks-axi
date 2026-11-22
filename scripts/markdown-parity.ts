#!/usr/bin/env tsx
/**
 * Markdown parity harness: runs the same staged-contention scenarios against
 * one or more tasks-axi builds and reports, per scenario, the exit code, the
 * normalized output, the resulting file bytes, and the time spent waiting on
 * locks (elapsed minus the same command's uncontended run).
 *
 *   pnpm exec tsx scripts/markdown-parity.ts --cli <main>/dist/bin/tasks-axi.js \
 *     --cli dist/bin/tasks-axi.js [--json]
 *
 * Synthetic data only, in mkdtemp directories with HOME pointing inside them.
 * Locks are staged by creating <file>.lock before the command starts and
 * removing it on a schedule, as another writer would. With two --cli values
 * it compares them and exits 1 on any difference beyond --tolerance-ms (300).
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SEED = `# Backlog

## In flight

- [ ] live - Something running (repo: demo) (since 2026-01-02)

## Queued

- [ ] alpha - First queued (repo: demo) (priority: 1)
  A body line.

  Another paragraph.

- [ ] beta - Second queued blocked-by: alpha
- [ ] gamma - Third queued (kind: docs)

## Done

- [x] old - Finished thing (done 2026-01-01)
`;

export interface Scenario {
  name: string;
  /** Command argv after the CLI; {main} and {other} are file paths. */
  args: string[];
  /** Locks held when the command starts: file key and release time in ms (null: never). */
  locks?: {
    file: "main" | "other";
    releaseMs: number | null;
    stale?: boolean;
  }[];
}

export const SCENARIOS: Scenario[] = [
  { name: "add", args: ["add", "delta", "New task", "--file", "{main}"] },
  { name: "start", args: ["start", "alpha", "--file", "{main}"] },
  { name: "done", args: ["done", "live", "--file", "{main}"] },
  {
    name: "update-body",
    args: ["update", "alpha", "--body", "Replaced body", "--file", "{main}"],
  },
  {
    name: "block",
    args: ["block", "gamma", "--by", "alpha", "--file", "{main}"],
  },
  { name: "rm", args: ["rm", "gamma", "--file", "{main}"] },
  { name: "render", args: ["render", "--file", "{main}"] },
  {
    name: "mv",
    args: ["mv", "gamma", "old", "--to", "{other}", "--file", "{main}"],
  },
  { name: "show", args: ["show", "alpha", "--full", "--file", "{main}"] },
  { name: "list", args: ["list", "--file", "{main}"] },
  {
    name: "write-waits-for-lock",
    args: ["add", "delta", "New task", "--file", "{main}"],
    locks: [{ file: "main", releaseMs: 1_000 }],
  },
  {
    name: "write-refused-past-wait",
    args: ["add", "delta", "New task", "--file", "{main}"],
    locks: [{ file: "main", releaseMs: null }],
  },
  {
    name: "write-refused-stale",
    args: ["add", "delta", "New task", "--file", "{main}"],
    locks: [{ file: "main", releaseMs: null, stale: true }],
  },
  {
    name: "read-ignores-lock",
    args: ["list", "--file", "{main}"],
    locks: [{ file: "main", releaseMs: null }],
  },
  {
    name: "show-ignores-lock",
    args: ["show", "beta", "--full", "--file", "{main}"],
    locks: [{ file: "main", releaseMs: null }],
  },
  {
    name: "show-missing",
    args: ["show", "nope", "--file", "{main}"],
  },
  {
    name: "mv-staggered-within-each-wait",
    args: ["mv", "gamma", "--to", "{other}", "--file", "{main}"],
    locks: [
      { file: "main", releaseMs: 1_500 },
      { file: "other", releaseMs: 3_500 },
    ],
  },
  {
    name: "mv-second-busy-past-its-wait",
    args: ["mv", "gamma", "--to", "{other}", "--file", "{main}"],
    locks: [
      { file: "main", releaseMs: 1_000 },
      { file: "other", releaseMs: null },
    ],
  },
];

function isoDay(date: Date, utc: boolean): string {
  const y = utc ? date.getUTCFullYear() : date.getFullYear();
  const m = (utc ? date.getUTCMonth() : date.getMonth()) + 1;
  const d = utc ? date.getUTCDate() : date.getDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Replace today's date, local and UTC, with <today>. */
export function undated(text: string): string {
  const now = new Date();
  let out = text;
  for (const day of new Set([isoDay(now, false), isoDay(now, true)]))
    out = out.split(day).join("<today>");
  return out;
}

export interface Outcome {
  code: number | null;
  out: string;
  files: Record<string, string | null>;
  waitMs: number;
}

function exec(
  node: string[],
  args: string[],
  dir: string,
): Promise<{ code: number | null; out: string; ms: number }> {
  return new Promise((done) => {
    const started = performance.now();
    const child = spawn(process.execPath, [...node, ...args], {
      cwd: dir,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([k]) => !k.startsWith("TASKS_AXI_"),
          ),
        ),
        HOME: dir,
        USERPROFILE: dir,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("close", (code) =>
      done({ code, out, ms: performance.now() - started }),
    );
  });
}

async function once(node: string[], scenario: Scenario, contended: boolean) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tasks-axi-md-parity-")));
  try {
    const paths = {
      main: join(dir, "backlog.md"),
      other: join(dir, "other.md"),
    };
    writeFileSync(paths.main, SEED);
    writeFileSync(paths.other, "# Backlog\n\n## Queued\n\n");
    const timers: NodeJS.Timeout[] = [];
    if (contended)
      for (const lock of scenario.locks ?? []) {
        const path = paths[lock.file] + ".lock";
        writeFileSync(path, "staged-by-parity-harness\n");
        if (lock.stale) {
          const old = new Date(Date.now() - 3_600_000);
          utimesSync(path, old, old);
        }
        if (lock.releaseMs !== null)
          timers.push(
            setTimeout(() => rmSync(path, { force: true }), lock.releaseMs),
          );
      }
    const args = scenario.args.map((a) =>
      a === "{main}" ? paths.main : a === "{other}" ? paths.other : a,
    );
    const run = await exec(node, args, dir);
    timers.forEach(clearTimeout);
    // Stamps carry today's date (local or UTC), so normalize it: the
    // fixture must not depend on the day or time zone it was recorded in.
    const files: Record<string, string | null> = {};
    for (const [key, path] of Object.entries(paths))
      files[key] = existsSync(path)
        ? undated(readFileSync(path, "utf8"))
        : null;
    for (const name of ["done-archive.md", "note-archive.md"]) {
      const path = join(dir, name);
      if (existsSync(path)) files[name] = undated(readFileSync(path, "utf8"));
    }
    const out = undated(run.out)
      .split(dir)
      .join("<dir>")
      .replaceAll("\\", "/")
      .replace(/\d+(\.\d+)? ?(ms|s|seconds?|minutes?|m|h)\b/g, "<n>$2");
    return { code: run.code, out, files, ms: run.ms };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run every scenario against one CLI (node argv that starts it). */
export async function runScenarios(
  node: string[],
  scenarios = SCENARIOS,
): Promise<Record<string, Outcome>> {
  const results: Record<string, Outcome> = {};
  for (const scenario of scenarios) {
    const base = await once(node, scenario, false);
    const run = scenario.locks ? await once(node, scenario, true) : base;
    results[scenario.name] = {
      code: run.code,
      out: run.out,
      files: run.files,
      waitMs: scenario.locks ? Math.max(0, Math.round(run.ms - base.ms)) : 0,
    };
  }
  return results;
}

export function compare(
  expected: Record<string, Outcome>,
  actual: Record<string, Outcome>,
  toleranceMs = 300,
): string[] {
  const diffs: string[] = [];
  for (const [name, want] of Object.entries(expected)) {
    const got = actual[name];
    if (!got) {
      diffs.push(name + ": missing");
      continue;
    }
    if (got.code !== want.code)
      diffs.push(`${name}: exit ${got.code} != ${want.code}`);
    if (got.out !== want.out)
      diffs.push(
        `${name}: output differs\n--- want\n${want.out}\n--- got\n${got.out}`,
      );
    if (JSON.stringify(got.files) !== JSON.stringify(want.files))
      diffs.push(
        `${name}: file bytes differ ${JSON.stringify(got.files)} != ${JSON.stringify(want.files)}`,
      );
    if (Math.abs(got.waitMs - want.waitMs) > toleranceMs)
      diffs.push(
        `${name}: waited ${got.waitMs} ms, expected ${want.waitMs} ms`,
      );
  }
  return diffs;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const argv = process.argv.slice(2);
  const clis: string[] = [];
  let json = false;
  let tolerance = 300;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cli") clis.push(resolve(argv[++i]!));
    else if (argv[i] === "--json") json = true;
    else if (argv[i] === "--tolerance-ms") tolerance = Number(argv[++i]);
  }
  if (!clis.length) clis.push(resolve("dist/bin/tasks-axi.js"));
  const results: Record<string, Record<string, Outcome>> = {};
  for (const cli of clis) results[cli] = await runScenarios([cli]);
  const diffs =
    clis.length === 2
      ? compare(results[clis[0]!]!, results[clis[1]!]!, tolerance)
      : [];
  if (json) console.log(JSON.stringify({ results, diffs }, null, 2));
  else {
    for (const [cli, res] of Object.entries(results)) {
      console.log(cli);
      for (const [name, o] of Object.entries(res))
        console.log(`  ${name.padEnd(32)} exit=${o.code} wait=${o.waitMs}ms`);
    }
    if (clis.length === 2)
      console.log(
        diffs.length
          ? diffs.join("\n")
          : "identical within " + tolerance + " ms",
      );
  }
  process.exitCode = diffs.length ? 1 : 0;
}
