#!/usr/bin/env tsx
/**
 * Reproducible beads-backend write benchmark on synthetic data only.
 *
 *   pnpm exec tsx scripts/bench-beads.ts --rows 400 [--rows 1500]
 *     [--cli dist/bin/tasks-axi.js] [--seed-cli <path>] [--reps 3]
 *     [--parallel 8] [--json] [--keep] [--workspace <kept-dir>]
 *
 * Builds a throwaway workspace (HOME points inside it, so no real home config
 * is read) holding a synthetic markdown backlog of N rows: about 20% active
 * (in flight + queued), 10 recent Done rows, the rest in done-archive.md, with
 * realistic multi-line bodies and some blocked-by edges. It migrates that into
 * a beads database with [beads] mirror and mirror_archive configured, then
 * times add, start, done and show (median of --reps), N parallel adds, and
 * migration per row. --seed-cli migrates with a different build than --cli,
 * so an old build's write path can be timed without its slow migration.
 * --workspace copies a workspace kept by an earlier --keep run (one --rows
 * value) instead of building and migrating, so two builds' writes can be
 * timed back-to-back on identical copies. Every result records the host load
 * average and the time of a bare `br version`, the per-call floor.
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderBacklog } from "../src/backends/markdown-grammar.js";
import type { State, Task } from "../src/model.js";

interface Run {
  ms: number;
  code: number | null;
  out: string;
}

function flag(name: string): string[] {
  const values: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++)
    if (argv[i] === name && argv[i + 1] !== undefined) values.push(argv[++i]);
  return values;
}
const has = (name: string) => process.argv.slice(2).includes(name);

const rowsList = flag("--rows").map(Number);
if (!rowsList.length) rowsList.push(400);
const cli = resolve(flag("--cli")[0] ?? "dist/bin/tasks-axi.js");
const seedCli = resolve(flag("--seed-cli")[0] ?? cli);
const reps = Number(flag("--reps")[0] ?? 3);
const parallel = Number(flag("--parallel")[0] ?? 8);
const seeded = flag("--workspace")[0];

/** One trivial br call against the workspace database: the per-call floor. */
function brFloorMs(dir: string): number {
  const start = performance.now();
  spawnSync("br", ["--db", join(dir, ".beads", "beads.db"), "version"], {
    stdio: "ignore",
  });
  return Math.round(performance.now() - start);
}

const WORDS =
  "widget lease handoff mirror review backlog worker deploy cache retry queue gate schema token config session report migration lock fixture".split(
    " ",
  );
function words(seed: number, count: number): string {
  return Array.from(
    { length: count },
    (_, i) => WORDS[(seed * 7 + i * 13) % WORDS.length],
  ).join(" ");
}
function day(offset: number): string {
  const d = new Date(Date.UTC(2026, 0, 1) + offset * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Deterministic synthetic tasks: ~5% in flight, ~15% queued, rest done. */
export function syntheticTasks(rows: number): Task[] {
  const tasks: Task[] = [];
  const inFlight = Math.max(1, Math.round(rows * 0.05));
  const queued = Math.max(1, Math.round(rows * 0.15));
  for (let i = 0; i < rows; i++) {
    const state: State =
      i < inFlight ? "in_flight" : i < inFlight + queued ? "queued" : "done";
    const id = "syn-" + String(i).padStart(5, "0");
    const task: Task = {
      id,
      title: words(i, 6) + " for row " + i,
      state,
      links: [],
      deps: [],
      repo: "repo-" + (i % 7),
    };
    if (i % 3 === 0) task.priority = i % 5;
    task.body = [
      "Context: " + words(i + 1, 14) + ".",
      "- step one: " + words(i + 2, 8),
      "- step two: " + words(i + 3, 8),
      "Notes: " + words(i + 4, 18) + ".",
    ].join("\n");
    if (state === "done") task.closed = day(i % 300);
    else task.created = day(i % 300);
    // Active rows block on earlier active rows; done rows on earlier done rows.
    const target = i - 3;
    if (i % 4 === 1 && target >= 0) {
      const other = tasks[target];
      if (
        (state === "done") === (other.state === "done") &&
        !(state === "in_flight" && other.state === "queued")
      )
        task.deps.push({ type: "blocked-by", id: other.id });
    }
    tasks.push(task);
  }
  return tasks;
}

function backlog(tasks: Task[], states: [State, string][], title: string) {
  return renderBacklog({
    finalNewline: true,
    preamble: [title, ""],
    sections: states.map(([state, label]) => ({
      headerLine: "## " + label,
      state,
      entries: tasks
        .filter((task) => task.state === state)
        .map((task) => ({ kind: "task" as const, task, raw: [], dirty: true })),
    })),
  });
}

function run(
  args: string[],
  cwd: string,
  home: string,
  bin = cli,
): Promise<Run> {
  return new Promise((done, fail) => {
    const start = performance.now();
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("TASKS_AXI_"),
          ),
        ),
        HOME: home,
        USERPROFILE: home,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("error", fail);
    child.on("close", (code) =>
      done({ ms: Math.round(performance.now() - start), code, out }),
    );
  });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function bench(rows: number) {
  const dir = mkdtempSync(join(tmpdir(), "tasks-axi-bench-"));
  const home = join(dir, "home");
  const result: Record<string, unknown> = {
    rows,
    dir,
    load_before: loadavg().map((n) => Math.round(n * 100) / 100),
  };
  const failures: string[] = [];
  const check = (name: string, r: Run) => {
    if (r.code !== 0)
      failures.push(
        name + ": exit " + r.code + ": " + r.out.trim().slice(0, 300),
      );
    return r.ms;
  };
  if (seeded) {
    // The copy keeps its relative .tasks.toml paths, so it is self-contained.
    cpSync(seeded, dir, { recursive: true });
    result.copied_from = seeded;
  } else await seed(rows, dir, home, result, check);
  result.br_floor_ms = brFloorMs(dir);
  await writes(dir, home, result, check);
  result.load_after = loadavg().map((n) => Math.round(n * 100) / 100);
  if (failures.length) result.failures = failures;
  if (!has("--keep")) rmSync(dir, { recursive: true, force: true });
  return result;
}

async function seed(
  rows: number,
  dir: string,
  home: string,
  result: Record<string, unknown>,
  check: (name: string, r: Run) => number,
) {
  mkdirSync(home);
  mkdirSync(join(dir, "md"));
  const tasks = syntheticTasks(rows);
  const done = tasks.filter((task) => task.state === "done");
  const recent = new Set(done.slice(0, 10).map((task) => task.id));
  writeFileSync(
    join(dir, "md", "backlog.md"),
    backlog(
      tasks.filter((task) => task.state !== "done" || recent.has(task.id)),
      [
        ["in_flight", "In flight"],
        ["queued", "Queued"],
        ["done", "Done"],
      ],
      "# Backlog",
    ),
  );
  writeFileSync(
    join(dir, "md", "done-archive.md"),
    backlog(
      done.filter((task) => !recent.has(task.id)),
      [["done", "Done"]],
      "# Done archive",
    ),
  );
  // Without the env override, the [markdown] table would need backend=markdown.
  writeFileSync(
    join(dir, ".tasks.toml"),
    [
      'backend = "beads"',
      "[markdown]",
      'path = "md/backlog.md"',
      'archive = "md/done-archive.md"',
      "[beads]",
      'path = ".beads"',
      'mirror = "mirror/backlog.md"',
      'mirror_archive = "mirror/done-archive.md"',
      "",
    ].join("\n"),
  );
  const migrate = await run(
    ["migrate", "--from", "markdown", "--to", "beads", "--json"],
    dir,
    home,
    seedCli,
  );
  check("migrate", migrate);
  result.migrate_ms = migrate.ms;
  result.migrate_ms_per_row = Math.round((migrate.ms / rows) * 10) / 10;
  try {
    const reported = JSON.parse(migrate.out) as Record<string, unknown>;
    if (reported.ms_per_row !== undefined)
      result.migrate_reported_ms_per_row = reported.ms_per_row;
  } catch {
    // older builds print no per-row timing
  }
}

async function writes(
  dir: string,
  home: string,
  result: Record<string, unknown>,
  check: (name: string, r: Run) => number,
) {
  const timings: Record<string, number[]> = {
    add: [],
    start: [],
    done: [],
    show: [],
  };
  for (let i = 0; i < reps; i++) {
    const id = "bench-" + i;
    timings.add.push(
      check(
        "add",
        await run(
          ["add", id, "benchmark row " + i, "--body", "Synthetic body line."],
          dir,
          home,
        ),
      ),
    );
    timings.start.push(check("start", await run(["start", id], dir, home)));
    timings.done.push(check("done", await run(["done", id], dir, home)));
    timings.show.push(check("show", await run(["show", id], dir, home)));
  }
  for (const [name, values] of Object.entries(timings)) {
    result[name + "_ms"] = median(values);
    result[name + "_all_ms"] = values;
  }
  const start = performance.now();
  const runs = await Promise.all(
    Array.from({ length: parallel }, (_, i) =>
      run(["add", "par-" + i, "parallel row " + i], dir, home),
    ),
  );
  result.parallel = {
    writers: parallel,
    succeeded: runs.filter((r) => r.code === 0).length,
    wall_ms: Math.round(performance.now() - start),
    per_writer_ms: runs.map((r) => r.ms),
    errors: runs
      .filter((r) => r.code !== 0)
      .map((r) => r.out.trim().split("\n")[0]),
  };
}

const results = [];
for (const rows of rowsList) {
  const result = await bench(rows);
  results.push(result);
  if (!has("--json")) console.error(JSON.stringify(result));
}
console.log(JSON.stringify({ cli, seed_cli: seedCli, results }, null, 2));
