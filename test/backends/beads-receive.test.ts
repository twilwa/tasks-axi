import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownStore } from "../../src/backends/markdown.js";
import { BeadsStore } from "../../src/backends/beads.js";
import { main } from "../../src/cli.js";
import { hasBr, makeBeadsWorkspace, recordBr } from "../beads-helpers.js";

// Markdown outbox -> beads receive: the outbox stays the durable record until
// every selected row is confirmed in beads, then releases them in one write.
const outbox = readFileSync(
  new URL("../fixtures/migration-backlog.md", import.meta.url),
  "utf8",
);
const savedCwd = process.cwd();
let ws: ReturnType<typeof makeBeadsWorkspace>;
let home: string;
let file: string;

async function cli(...argv: string[]) {
  let output = "";
  process.exitCode = undefined;
  await main({
    argv,
    stdout: { write: (chunk: string) => void (output += chunk) },
  });
  return { output, code: process.exitCode ?? 0 };
}

function mv(...ids: string[]) {
  return cli(
    "mv",
    ...ids,
    "--file",
    file,
    "--to",
    ws.path,
    "--to-backend",
    "beads",
    "--json",
  );
}

/** tasks-axi in a real CLI process, which a br hook can pause or kill. */
function tasksAxi(
  args: string[],
  options: {
    binary?: string;
    nodeArgs?: string[];
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const child = spawn(
    process.execPath,
    [
      ...(options.nodeArgs ?? []),
      "--import",
      pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
      fileURLToPath(new URL("../../bin/tasks-axi.ts", import.meta.url)),
      ...args,
    ],
    {
      cwd: ws.dir,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("TASKS_AXI_"),
          ),
        ),
        HOME: home,
        USERPROFILE: home,
        BEADS_DIR: join(ws.dir, ".beads"),
        TASKS_AXI_BEADS_BINARY: options.binary ?? "br",
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    out: string;
    at: number;
  }>((resolve) =>
    child.on("close", (code, signal) =>
      resolve({ code, signal, out, at: performance.now() }),
    ),
  );
}

function mvProcess(
  ids: string[],
  binary: string,
  options: { nodeArgs?: string[]; env?: NodeJS.ProcessEnv } = {},
) {
  return tasksAxi(
    ["mv", ...ids, "--file", file, "--to", ws.path, "--to-backend", "beads"],
    { binary, ...options },
  );
}

async function waitFor(path: string, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for " + path);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Every file under `dir` with its contents, to prove nothing touched it. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[path] = readFileSync(path, "base64");
    }
  };
  walk(dir);
  return out;
}

/** A br recorder that SIGKILLs tasks-axi once the nth `step` call has run. */
function killAfter(step: "create" | "dep", n: number) {
  const counter = join(ws.dir, `${step}-count`);
  return recordBr(ws.dir, ws.path, {
    after:
      `if (args[2] === ${JSON.stringify(step)}) {` +
      ` const c = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) + 1 : 1;` +
      ` fs.writeFileSync(${JSON.stringify(counter)}, String(c));` +
      ` if (c === ${n} && result.status === 0) process.kill(process.ppid, 'SIGKILL'); }`,
  }).binary;
}

/** Native rows owned by tasks-axi, keyed by caller id. */
function rows(): string[] {
  const listed = ws.br(["list", "--all", "--limit", "0"]) as {
    issues: { external_ref?: string }[];
  };
  return listed.issues
    .map((issue) => issue.external_ref ?? "")
    .filter((ref) => ref.startsWith("tasks-axi:"))
    .map((ref) => ref.slice("tasks-axi:".length))
    .sort();
}

describe.skipIf(!hasBr)("mv from a markdown outbox into beads", () => {
  beforeEach(() => {
    ws = makeBeadsWorkspace();
    home = mkdtempSync(join(tmpdir(), "tasks-axi-home-"));
    process.chdir(ws.dir);
    vi.stubEnv("HOME", home);
    vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("BEADS_DIR", join(ws.dir, ".beads"));
    vi.stubEnv("TASKS_AXI_BEADS_BINARY", "br");
    vi.stubEnv("TASKS_AXI_BACKEND", "markdown");
    vi.stubEnv("TASKS_AXI_FILE", "");
    delete process.env.TASKS_AXI_FILE;
    file = join(ws.dir, "outbox.md");
    writeFileSync(file, outbox);
  });
  afterEach(() => {
    process.chdir(savedCwd);
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    ws.cleanup();
    rmSync(home, { recursive: true, force: true });
  });

  it("carries every selected item whole and releases it from the outbox", async () => {
    const ids = ["blocked-q2", "build-a1", "held-q1", "inspect-a2"];
    const before = (await new MarkdownStore({ path: file }).list({})).items;
    const { output, code } = await mv(...ids);
    expect(code, output).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      action: "mv",
      ids,
      to: ws.path,
      created: ["build-a1", "inspect-a2", "held-q1", "blocked-q2"],
    });
    expect(rows()).toEqual([...ids].sort());
    const beads = new BeadsStore({ path: ws.path });
    expect((await beads.list({})).items).toEqual(
      before.filter((task) => ids.includes(task.id)),
    );
    expect(
      (await new MarkdownStore({ path: file }).list({})).items.map(
        (task) => task.id,
      ),
    ).toEqual(["ready-q3", "latest-d1"]);
    // Native labels mirror kind, repo and a captain hold, as migration writes them.
    const held = (
      ws.br(["list", "--all", "--limit", "0"]) as {
        issues: { external_ref?: string; labels?: string[] }[];
      }
    ).issues.find((issue) => issue.external_ref === "tasks-axi:held-q1");
    expect([...(held?.labels ?? [])].sort()).toEqual([
      "hold:captain",
      "kind:task",
      "repo:example",
    ]);
    // The items left behind keep every original byte.
    expect(readFileSync(file, "utf8")).toBe(
      "# Backlog\n\n## In flight\n## Queued\n" +
        outbox.slice(outbox.indexOf("- [ ] ready-q3")),
    );
    expect(existsSync(join(home, ".beads"))).toBe(false);
  }, 60_000);

  it("is a no-op when rerun after the items were released", async () => {
    expect((await mv("held-q1", "inspect-a2")).code).toBe(0);
    const released = readFileSync(file, "utf8");
    const { output, code } = await mv("held-q1", "inspect-a2");
    expect(code, output).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      already: true,
      created: [],
    });
    expect(rows()).toEqual(["held-q1", "inspect-a2"]);
    expect(readFileSync(file, "utf8")).toBe(released);
  }, 60_000);

  it("refuses an existing row whose content differs, overwriting neither side", async () => {
    const beads = new BeadsStore({ path: ws.path });
    await beads.create({ id: "held-q1", title: "a different task" });
    const { output, code } = await mv("inspect-a2", "held-q1");
    expect(code, output).not.toBe(0);
    expect(output).toContain("CONFLICT");
    expect(output).toContain("different content for");
    expect(output).toContain("held-q1");
    expect(rows()).toEqual(["held-q1"]);
    expect((await beads.get("held-q1"))?.title).toBe("a different task");
    expect(readFileSync(file, "utf8")).toBe(outbox);
  }, 60_000);

  it("keeps the move going past edges to ids in neither store and reports them", async () => {
    const { output, code } = await mv("ready-q3");
    expect(code, output).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      created: ["ready-q3"],
      unlinked_deps: [
        {
          id: "ready-q3",
          type: "parent",
          target: "inspect-a2",
          reason: "tracks the investigation",
        },
        {
          id: "ready-q3",
          type: "discovered-from",
          target: "old-d2",
          reason: "followup from the prior release",
        },
      ],
    });
    const moved = await new BeadsStore({ path: ws.path }).get("ready-q3");
    expect(moved).toMatchObject({ id: "ready-q3", deps: [] });
    expect(readFileSync(file, "utf8")).not.toContain("ready-q3");
  }, 60_000);

  it("links an edge whose target is already in the destination", async () => {
    await new BeadsStore({ path: ws.path }).create({
      id: "build-a1",
      title: "Already received elsewhere",
    });
    const { output, code } = await mv("blocked-q2");
    expect(code, output).toBe(0);
    expect(JSON.parse(output)).toMatchObject({ unlinked_deps: [] });
    expect(
      (await new BeadsStore({ path: ws.path }).get("blocked-q2"))?.deps,
    ).toEqual([
      { type: "blocked-by", id: "build-a1", reason: "needs the adapter first" },
    ]);
  }, 60_000);

  it("refuses to leave an active dependent behind its departing blocker", async () => {
    const { output, code } = await mv("build-a1");
    expect(code, output).not.toBe(0);
    expect(output).toContain("still blocking active tasks: blocked-q2");
    expect(rows()).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe(outbox);
  }, 60_000);

  it("finishes on rerun after a crash between the create and the release", async () => {
    const crashed = await mvProcess(["held-q1"], killAfter("create", 1));
    expect(crashed.signal, crashed.out).toBe("SIGKILL");
    expect(rows()).toEqual(["held-q1"]);
    expect(readFileSync(file, "utf8")).toBe(outbox);
    const { output, code } = await mv("held-q1");
    expect(code, output).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      created: [],
      existing: ["held-q1"],
    });
    expect(rows()).toEqual(["held-q1"]);
    expect(readFileSync(file, "utf8")).not.toContain("held-q1");
  }, 90_000);

  it.each([
    ["the second create", "create", 2],
    ["the first edge", "dep", 1],
  ] as const)(
    "converges to one row per id after a crash at %s of a batch",
    async (_at, step, n) => {
      const ids = ["blocked-q2", "build-a1", "held-q1", "inspect-a2"];
      const before = (await new MarkdownStore({ path: file }).list({})).items;
      const crashed = await mvProcess(ids, killAfter(step, n));
      expect(crashed.signal, crashed.out).toBe("SIGKILL");
      expect(rows().length).toBe(step === "create" ? n : ids.length);
      expect(readFileSync(file, "utf8")).toBe(outbox);
      const { output, code } = await mv(...ids);
      expect(code, output).toBe(0);
      expect(rows()).toEqual([...ids].sort());
      expect((await new BeadsStore({ path: ws.path }).list({})).items).toEqual(
        before.filter((task) => ids.includes(task.id)),
      );
      expect(readFileSync(file, "utf8")).toBe(
        "# Backlog\n\n## In flight\n## Queued\n" +
          outbox.slice(outbox.indexOf("- [ ] ready-q3")),
      );
    },
    90_000,
  );

  it("reports which ids are confirmed when br fails mid-batch, releasing none", async () => {
    const failing = join(ws.dir, "fail-second-create");
    writeFileSync(failing, "");
    const counter = join(ws.dir, "create-count");
    vi.stubEnv(
      "TASKS_AXI_BEADS_BINARY",
      recordBr(ws.dir, ws.path, {
        before:
          `if (args[2] === 'create') {` +
          ` const c = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) + 1 : 1;` +
          ` fs.writeFileSync(${JSON.stringify(counter)}, String(c));` +
          ` if (c === 2 && fs.existsSync(${JSON.stringify(failing)})) { fs.unlinkSync(${JSON.stringify(failing)}); process.stdout.write('{"error":{"code":"DATABASE_ERROR","message":"injected"}}'); process.exit(3); } }`,
      }).binary,
    );
    const failed = await mv("held-q1", "inspect-a2");
    expect(failed.code, failed.output).not.toBe(0);
    expect(failed.output).toContain("confirmed: inspect-a2");
    expect(failed.output).toContain("not confirmed: held-q1");
    expect(failed.output).toContain("nothing was released");
    expect(rows()).toEqual(["inspect-a2"]);
    expect(readFileSync(file, "utf8")).toBe(outbox);
    const { output, code } = await mv("held-q1", "inspect-a2");
    expect(code, output).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      created: ["held-q1"],
      existing: ["inspect-a2"],
    });
    expect(rows()).toEqual(["held-q1", "inspect-a2"]);
  }, 60_000);

  it("refuses the release when a selected outbox item is edited mid-move", async () => {
    const edited = outbox.replace("wait for review", "wait for a later review");
    vi.stubEnv(
      "TASKS_AXI_BEADS_BINARY",
      recordBr(ws.dir, ws.path, {
        after: `if (args[2] === 'create') fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(edited)});`,
      }).binary,
    );
    const { output, code } = await mv("held-q1");
    expect(code, output).not.toBe(0);
    expect(output).toContain("changed while it was being received");
    expect(readFileSync(file, "utf8")).toBe(edited);
    expect(rows()).toEqual(["held-q1"]);
    // The rerun sees the outbox and the row disagree and overwrites neither.
    vi.stubEnv("TASKS_AXI_BEADS_BINARY", "br");
    expect((await mv("held-q1")).output).toContain("different content for");
    expect(readFileSync(file, "utf8")).toBe(edited);
  }, 60_000);

  it("keeps a concurrent edit to an item it is not moving", async () => {
    const edited = outbox.replace(
      "Released successfully.",
      "Released, then audited.",
    );
    vi.stubEnv(
      "TASKS_AXI_BEADS_BINARY",
      recordBr(ws.dir, ws.path, {
        after: `if (args[2] === 'create') fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(edited)});`,
      }).binary,
    );
    const { output, code } = await mv("held-q1");
    expect(code, output).toBe(0);
    const after = readFileSync(file, "utf8");
    expect(after).toContain("Released, then audited.");
    expect(after).not.toContain("held-q1");
  }, 60_000);

  it("keeps the beads lock from confirmation through the release, so a cooperative rm waits", async () => {
    // The test holds the outbox lock, so the release has to wait for it.
    const outboxLock = `${file}.lock`;
    writeFileSync(outboxLock, "test-holder\n");
    const created = join(ws.dir, "created");
    const paused = join(ws.dir, "paused");
    const resumed = join(ws.dir, "resumed");
    // Pause the read-back (the first list after the create) inside the hold.
    const binary = recordBr(ws.dir, ws.path, {
      before:
        `if (args[2] === 'list' && fs.existsSync(${JSON.stringify(created)}) && !fs.existsSync(${JSON.stringify(paused)})) {` +
        ` fs.writeFileSync(${JSON.stringify(paused)}, ''); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000); }`,
      after:
        `if (args[2] === 'create') fs.writeFileSync(${JSON.stringify(created)}, '');` +
        ` if (args[2] === 'list' && fs.existsSync(${JSON.stringify(paused)}) && !fs.existsSync(${JSON.stringify(resumed)})) fs.writeFileSync(${JSON.stringify(resumed)}, '');`,
    }).binary;
    const move = mvProcess(["held-q1"], binary);
    await waitFor(paused);
    const remove = tasksAxi([
      "rm",
      "held-q1",
      "--backend",
      "beads",
      "--file",
      ws.path,
    ]);
    await waitFor(resumed);
    // The receipt is confirmed and the move now waits on the outbox lock.
    await new Promise((r) => setTimeout(r, 1000));
    expect(rows()).toEqual(["held-q1"]);
    unlinkSync(outboxLock);
    const [moved, removed] = await Promise.all([move, remove]);
    expect(moved.code, moved.out).toBe(0);
    expect(removed.code, removed.out).toBe(0);
    // rm ran only after the outbox had released the confirmed row.
    expect(removed.at).toBeGreaterThan(moved.at);
    expect(readFileSync(file, "utf8")).not.toContain("held-q1");
    expect(rows()).toEqual([]);
  }, 90_000);

  it("converges when a rerun finds more of an item's edges linkable than the first run", async () => {
    writeFileSync(
      file,
      "## In flight\n## Queued\n- [ ] a-q1 - Depends on two blocked-by: x-q2 blocked-by: y-q3\n## Done\n",
    );
    const beads = new BeadsStore({ path: ws.path });
    await beads.create({ id: "y-q3", title: "Y" });
    const crashed = await mvProcess(["a-q1"], killAfter("dep", 1));
    expect(crashed.signal, crashed.out).toBe("SIGKILL");
    expect((await beads.get("a-q1"))?.deps).toEqual([
      { type: "blocked-by", id: "y-q3" },
    ]);
    // Another writer adds X before the rerun, so its edge is now linkable.
    await beads.create({ id: "x-q2", title: "X" });
    const { output, code } = await mv("a-q1");
    expect(code, output).toBe(0);
    expect(
      [...((await beads.get("a-q1"))?.deps ?? [])].sort((a, b) =>
        a.id.localeCompare(b.id),
      ),
    ).toEqual([
      { type: "blocked-by", id: "x-q2" },
      { type: "blocked-by", id: "y-q3" },
    ]);
    expect(readFileSync(file, "utf8")).not.toContain("a-q1");
  }, 90_000);

  it("pins br to the destination's own workspace despite a hostile environment", async () => {
    // A decoy workspace where a home-directory store would live.
    const decoy = join(home, ".beads");
    mkdirSync(decoy);
    const init = spawnSync(
      "br",
      ["--db", join(decoy, "beads.db"), "init", "--prefix", "decoy", "--json"],
      {
        cwd: home,
        env: { ...process.env, HOME: home, BEADS_DIR: decoy },
        encoding: "utf8",
      },
    );
    expect(init.status, init.stdout + init.stderr).toBe(0);
    const before = snapshot(decoy);
    // Outside any .beads directory, so br reads the workspace from the env.
    mkdirSync(join(ws.dir, "link"));
    const db = join(ws.dir, "link", "alias.db");
    symlinkSync(ws.path, db);
    vi.stubEnv("BEADS_DIR", decoy);
    vi.stubEnv("BEADS_DB", join(decoy, "beads.db"));
    const { output, code } = await cli(
      "mv",
      "held-q1",
      "--file",
      file,
      "--to",
      db,
      "--to-backend",
      "beads",
      "--json",
    );
    expect(code, output).toBe(0);
    expect(rows()).toEqual(["held-q1"]);
    expect(snapshot(decoy)).toEqual(before);
  }, 60_000);

  it("refuses a database outside any .beads directory before running br", async () => {
    const db = join(ws.dir, "plain", "beads.db");
    const { output, code } = await cli(
      "mv",
      "held-q1",
      "--file",
      file,
      "--to",
      db,
      "--to-backend",
      "beads",
    );
    expect(code, output).toBe(2);
    expect(output).toContain("not inside a .beads or _beads directory");
    expect(existsSync(join(ws.dir, "plain"))).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(outbox);
  }, 60_000);

  it("refuses a destination workspace that routes issue ids to another database", async () => {
    writeFileSync(
      join(ws.dir, ".beads", "routes.jsonl"),
      JSON.stringify({ prefix: "test-", path: home }) + "\n",
    );
    const { output, code } = await mv("held-q1");
    expect(code, output).not.toBe(0);
    expect(output).toContain("UNSUPPORTED");
    expect(output).toContain("routes.jsonl");
    expect(readFileSync(file, "utf8")).toBe(outbox);
    rmSync(join(ws.dir, ".beads", "routes.jsonl"));
    expect(rows()).toEqual([]);
  }, 60_000);

  it("reports ids as unknown, keeping the first error, when the diagnostic read fails too", async () => {
    const counter = join(ws.dir, "create-count");
    const failing = join(ws.dir, "reads-fail");
    vi.stubEnv(
      "TASKS_AXI_BEADS_BINARY",
      recordBr(ws.dir, ws.path, {
        before:
          `if (args[2] === 'list' && fs.existsSync(${JSON.stringify(failing)})) { fs.unlinkSync(${JSON.stringify(failing)}); process.stdout.write('{"error":{"code":"DATABASE_ERROR","message":"read injected"}}'); process.exit(3); }` +
          ` if (args[2] === 'create') {` +
          ` const c = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) + 1 : 1;` +
          ` fs.writeFileSync(${JSON.stringify(counter)}, String(c));` +
          ` if (c === 2) { fs.writeFileSync(${JSON.stringify(failing)}, ''); process.stdout.write('{"error":{"code":"DATABASE_ERROR","message":"create injected"}}'); process.exit(3); } }`,
      }).binary,
    );
    const failed = await mv("held-q1", "inspect-a2");
    expect(failed.code, failed.output).not.toBe(0);
    expect(failed.output).toContain("create injected");
    expect(failed.output).toContain("unknown: inspect-a2, held-q1");
    expect(failed.output).toContain("read injected");
    expect(readFileSync(file, "utf8")).toBe(outbox);
    vi.stubEnv("TASKS_AXI_BEADS_BINARY", "br");
    const { output, code } = await mv("held-q1", "inspect-a2");
    expect(code, output).toBe(0);
    expect(rows()).toEqual(["held-q1", "inspect-a2"]);
  }, 60_000);

  it("names the confirmed rows and a safe recovery when killed during the release", async () => {
    const preload = join(ws.dir, "kill-on-release.mjs");
    writeFileSync(
      preload,
      `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (String(to) === process.env.KILL_ON_RENAME) process.kill(process.pid, "SIGKILL");
  return rename(from, to);
};
syncBuiltinESMExports();
`,
    );
    const crashed = await mvProcess(["held-q1"], "br", {
      nodeArgs: ["--import", pathToFileURL(preload).href],
      env: { KILL_ON_RENAME: file },
    });
    expect(crashed.signal, crashed.out).toBe("SIGKILL");
    // Killed between taking the outbox lock and its rename: both copies, dead lock.
    expect(rows()).toEqual(["held-q1"]);
    expect(readFileSync(file, "utf8")).toBe(outbox);
    const lock = `${file}.lock`;
    const pid = Number(readFileSync(lock, "utf8").split(":")[0]);
    expect(() => process.kill(pid, 0)).toThrow();
    const locked = await mv("held-q1");
    expect(locked.code, locked.output).not.toBe(0);
    expect(locked.output).toContain("LOCKED");
    expect(locked.output).toContain("confirmed in the destination");
    expect(locked.output).toContain("is the pid of the tasks-axi process");
    unlinkSync(lock);
    const { output, code } = await mv("held-q1");
    expect(code, output).toBe(0);
    expect(JSON.parse(output)).toMatchObject({
      created: [],
      existing: ["held-q1"],
    });
    expect(rows()).toEqual(["held-q1"]);
    expect(readFileSync(file, "utf8")).not.toContain("held-q1");
  }, 90_000);
});
