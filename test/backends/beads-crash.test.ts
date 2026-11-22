import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BeadsStore } from "../../src/backends/beads.js";
import { canonicalPath, withLock } from "../../src/backends/lock.js";
import { MarkdownStore } from "../../src/backends/markdown.js";
import { showCommand } from "../../src/commands/crud.js";
import { resolveTasksContext } from "../../src/context.js";
import { hasBr, makeBeadsWorkspace, recordBr } from "../beads-helpers.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const tsx = pathToFileURL(
  join(root, "node_modules", "tsx", "dist", "loader.mjs"),
).href;
let ws: ReturnType<typeof makeBeadsWorkspace>;

const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("TASKS_AXI_")),
);

/** A real tasks-axi CLI process against one explicit beads database. */
function cli(args: string[], db: string, binary?: string) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      tsx,
      join(root, "bin", "tasks-axi.ts"),
      ...args,
      "--backend",
      "beads",
      "--file",
      db,
    ],
    {
      cwd: ws.dir,
      env: {
        ...env,
        HOME: ws.dir,
        USERPROFILE: ws.dir,
        ...(binary ? { TASKS_AXI_BEADS_BINARY: binary } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
  const done = new Promise<{ code: number | null; out: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, out })),
  );
  return { child, done };
}

async function waitFor(path: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error("timed out waiting for " + path);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Recorder hook: on the first matching command, signal and pause it. */
function pauseOnce(
  command: string,
  marker: string,
  signal: string,
  ms: number,
) {
  return (
    "if (args[2] === " +
    JSON.stringify(command) +
    " && fs.existsSync(" +
    JSON.stringify(marker) +
    ")) {" +
    " fs.unlinkSync(" +
    JSON.stringify(marker) +
    ");" +
    " fs.writeFileSync(" +
    JSON.stringify(signal) +
    ", '');" +
    " Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, " +
    ms +
    "); }"
  );
}

describe.skipIf(!hasBr)(
  "beads writers across real processes and crashes",
  () => {
    beforeEach(() => {
      ws = makeBeadsWorkspace();
    });
    afterEach(() => ws?.cleanup());

    it("lets 8 separate CLI processes write one database and all succeed", async () => {
      await new BeadsStore({ path: ws.path }).create({
        id: "seed",
        title: "Seed",
      });
      const runs = Array.from({ length: 8 }, (_, i) =>
        cli(["add", "par-" + i, "Parallel " + i], ws.path),
      );
      const results = await Promise.all(runs.map((run) => run.done));
      expect(results.map((r) => r.code)).toEqual(Array(8).fill(0));
      expect((await new BeadsStore({ path: ws.path }).list({})).total).toBe(9);
    }, 120_000);

    it("keeps the last copy when a beads-to-markdown move times out during a late source delete", async () => {
      const br = execFileSync("bash", ["-c", "type -P br"]).toString().trim();
      await new BeadsStore({ path: ws.path }).create({
        id: "a",
        title: "Only",
      });
      const armed = join(ws.dir, "armed");
      const finished = join(ws.dir, "finished");
      const wrapper = join(ws.dir, "br-wrapper.sh");
      // A supported launcher: its background child keeps the lock descriptor
      // and applies the delete after the CLI's br timeout has fired.
      writeFileSync(
        wrapper,
        [
          "#!/bin/sh",
          'case " $* " in *" delete "*)',
          `  if [ -e '${armed}' ]; then rm '${armed}'; ( sleep 2; '${br}' "$@" >/dev/null 2>&1; touch '${finished}' ) & exec sleep 30; fi;;`,
          "esac",
          `exec '${br}' "$@"`,
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      writeFileSync(armed, "");
      const target = join(ws.dir, "dst.md");
      const child = spawn(
        process.execPath,
        [
          "--import",
          tsx,
          join(root, "bin", "tasks-axi.ts"),
          "mv",
          "a",
          "--to",
          target,
          "--to-backend",
          "markdown",
          "--backend",
          "beads",
          "--file",
          ws.path,
        ],
        {
          cwd: ws.dir,
          env: {
            ...env,
            HOME: ws.dir,
            USERPROFILE: ws.dir,
            TASKS_AXI_BEADS_BINARY: wrapper,
            TASKS_AXI_BEADS_TIMEOUT_MS: "1250",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString()));
      child.stderr.on("data", (c: Buffer) => (out += c.toString()));
      const code = await new Promise<number | null>((r) =>
        child.on("close", r),
      );
      expect(code, out).not.toBe(0);
      await waitFor(finished);
      const inSource = (
        await new BeadsStore({ path: ws.path }).list({})
      ).items.some((t) => t.id === "a");
      const inTarget =
        existsSync(target) && /\ba - Only/.test(readFileSync(target, "utf8"));
      expect(inSource || inTarget, "both copies lost").toBe(true);
      expect(inTarget, "staged copy must be kept").toBe(true);
      expect(out).toMatch(/indeterminate/);
      // The retry reconciles to exactly one copy.
      const retry = cli(
        ["mv", "a", "--to", target, "--to-backend", "markdown"],
        ws.path,
      );
      const result = await retry.done;
      expect(result.code, result.out).toBe(0);
      expect(
        (await new BeadsStore({ path: ws.path }).list({})).items.some(
          (t) => t.id === "a",
        ),
      ).toBe(false);
      expect(readFileSync(target, "utf8")).toMatch(/\ba - Only/);
    }, 120_000);

    it("does not let a successor in while a killed writer's br call can still commit", async () => {
      const store = new BeadsStore({ path: ws.path });
      await store.create({ id: "x", title: "X", body: "original" });
      const marker = join(ws.dir, "pause");
      const started = join(ws.dir, "started");
      writeFileSync(marker, "");
      const finished = join(ws.dir, "finished");
      const recorder = recordBr(ws.dir, ws.path, {
        before: pauseOnce("update", marker, started, 1_500),
        after:
          "if (args[2] === 'update') fs.appendFileSync(" +
          JSON.stringify(finished) +
          ", 'x');",
      });
      const first = cli(
        ["update", "x", "--body", "from the killed writer"],
        ws.path,
        recorder.binary,
      );
      await waitFor(started);
      first.child.kill("SIGKILL");
      await first.done;
      // The killed CLI's br update is still pending; it must land first.
      await new BeadsStore({ path: ws.path }).update("x", {
        body: "from the successor",
      });
      // Once the orphaned update has also run, the successor's write is last.
      await waitFor(finished);
      await new Promise((r) => setTimeout(r, 200));
      expect((await store.get("x"))?.body).toBe("from the successor");
    }, 60_000);

    it("reads wait for an in-flight write instead of returning a torn graph", async () => {
      const store = new BeadsStore({ path: ws.path });
      await store.create({ id: "x", title: "X", body: "before" });
      const marker = join(ws.dir, "pause");
      const started = join(ws.dir, "started");
      writeFileSync(marker, "");
      const recorder = recordBr(ws.dir, ws.path, {
        before: pauseOnce("update", marker, started, 1_000),
      });
      const writer = cli(
        ["update", "x", "--body", "after"],
        ws.path,
        recorder.binary,
      );
      await waitFor(started);
      expect((await store.get("x"))?.body).toBe("after");
      expect((await writer.done).code).toBe(0);
    }, 60_000);

    it("locks an aliased database path on its canonical lock", async () => {
      const alias = join(ws.dir, "alias.db");
      symlinkSync(ws.path, alias);
      const seen = join(ws.dir, "seen");
      const recorder = recordBr(ws.dir, alias, {
        before:
          // flock -n on the canonical lock fails while it is held.
          "if (args[2] === 'list') fs.writeFileSync(" +
          JSON.stringify(seen) +
          ", String(require('node:child_process').spawnSync('flock', ['-n', " +
          JSON.stringify(ws.path + ".lock") +
          ", 'true']).status !== 0));",
      });
      await new BeadsStore({ path: alias, binary: recorder.binary }).list({});
      expect(readFileSync(seen, "utf8")).toBe("true");
    }, 30_000);

    it("redoes an init interrupted after br set the prefix but before it wrote its workspace files", async () => {
      const db = join(ws.dir, "fresh", ".beads", "beads.db");
      const fault = join(ws.dir, "fault");
      writeFileSync(fault, "");
      const recorder = recordBr(ws.dir, db, {
        after:
          "if (args[2] === 'init' && fs.existsSync(" +
          JSON.stringify(fault) +
          ")) { fs.unlinkSync(" +
          JSON.stringify(fault) +
          "); const d = require('node:path').dirname(args[1]);" +
          " fs.rmSync(d + '/metadata.json', {force: true}); fs.rmSync(d + '/config.yaml', {force: true}); process.exit(9); }",
      });
      const store = () =>
        new BeadsStore({ path: db, binary: recorder.binary, prefix: "fresh" });
      await expect(
        store().create({ id: "a", title: "A" }),
      ).rejects.toBeTruthy();
      expect(existsSync(db)).toBe(true);
      await expect(
        store().create({ id: "a", title: "A" }),
      ).resolves.toMatchObject({ id: "a" });
      expect(existsSync(join(dirname(db), "metadata.json"))).toBe(true);
      const info = JSON.parse(
        execFileSync("br", ["--db", db, "info", "--json"], {
          encoding: "utf8",
        }),
      ) as { config: { issue_prefix: string } };
      expect(info.config.issue_prefix).toBe("fresh");
    }, 60_000);

    it("only initializes the layout br initializes, and ignores inherited redirects", async () => {
      const custom = join(ws.dir, "other", ".beads", "custom.db");
      await expect(
        new BeadsStore({ path: custom }).create({ id: "a", title: "A" }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(existsSync(join(ws.dir, "other", ".beads", "beads.db"))).toBe(
        false,
      );
      expect(existsSync(custom)).toBe(false);
      const elsewhere = join(ws.dir, "elsewhere");
      mkdirSync(elsewhere);
      const db = join(ws.dir, "fresh", ".beads", "beads.db");
      const saved = process.env.BEADS_CACHE_DIR;
      process.env.BEADS_CACHE_DIR = elsewhere;
      try {
        await new BeadsStore({ path: db, prefix: "fresh" }).create({
          id: "a",
          title: "A",
        });
      } finally {
        if (saved === undefined) delete process.env.BEADS_CACHE_DIR;
        else process.env.BEADS_CACHE_DIR = saved;
      }
      expect(existsSync(db)).toBe(true);
      // br may keep other state there, but never the database itself.
      expect(
        readdirSync(elsewhere).filter((name) => name.endsWith(".db")),
      ).toEqual([]);
    }, 60_000);

    it("re-verifies a database replaced after it was marked ready", async () => {
      const db = join(ws.dir, "fresh", ".beads", "beads.db");
      await new BeadsStore({ path: db, prefix: "fresh" }).create({
        id: "a",
        title: "A",
      });
      for (const name of readdirSync(dirname(db)))
        if (
          name.startsWith("beads.db") &&
          !name.endsWith(".tasks-axi-ready") &&
          !name.endsWith(".lock")
        )
          rmSync(join(dirname(db), name), { force: true });
      const before = readFileSync(db + ".tasks-axi-ready", "utf8");
      const store = new BeadsStore({ path: db, prefix: "fresh" });
      await expect(
        store.create({ id: "b", title: "B" }),
      ).resolves.toMatchObject({ id: "b" });
      // The marker was re-earned for the new database file, not trusted.
      const after = readFileSync(db + ".tasks-axi-ready", "utf8");
      expect(after).not.toBe(before);
      const stat = statSync(db, { bigint: true });
      expect(after).toBe(
        stat.dev + ":" + stat.ino + ":" + stat.birthtimeNs + "\n",
      );
    }, 60_000);

    it("re-verifies a database replaced under the same warm store instance", async () => {
      const db = join(ws.dir, "warm", ".beads", "beads.db");
      const store = new BeadsStore({ path: db, prefix: "warm" });
      await store.create({ id: "a", title: "A" });
      const before = readFileSync(db + ".tasks-axi-ready", "utf8");
      const dropDb = () => {
        for (const name of readdirSync(dirname(db)))
          if (
            name.startsWith("beads.db") &&
            !name.endsWith(".tasks-axi-ready") &&
            !name.endsWith(".lock")
          )
            rmSync(join(dirname(db), name), { force: true });
      };
      dropDb();
      // Same instance: the replaced database must earn the marker again.
      await expect(
        store.create({ id: "b", title: "B" }),
      ).resolves.toMatchObject({ id: "b" });
      const after = readFileSync(db + ".tasks-axi-ready", "utf8");
      expect(after).not.toBe(before);
      const stat = statSync(db, { bigint: true });
      expect(after).toBe(
        stat.dev + ":" + stat.ino + ":" + stat.birthtimeNs + "\n",
      );
      // A replacement that is not a usable database is refused, not used.
      dropDb();
      writeFileSync(db, "not a beads database\n");
      await expect(store.list({})).rejects.toBeInstanceOf(Error);
      expect(readFileSync(db + ".tasks-axi-ready", "utf8")).toBe(after);
    }, 60_000);

    it("transfers wait for a held lock on either side and move nothing past the deadline", async () => {
      const beads = new BeadsStore({ path: ws.path, lockTimeoutMs: 300 });
      await beads.create({ id: "x", title: "X" });
      const mdPath = join(ws.dir, "backlog.md");
      writeFileSync(
        mdPath,
        "# Backlog\n\n## In flight\n\n## Queued\n\n- [ ] y - Y\n\n## Done\n",
      );
      const md = new MarkdownStore({ path: mdPath });
      let release!: () => void;
      let holding!: () => void;
      const held = new Promise<void>((r) => (holding = r));
      const holder = withLock(
        canonicalPath(ws.path),
        () => {
          holding();
          return new Promise<void>((r) => (release = r));
        },
        { kernel: true },
      );
      await held;
      try {
        await expect(beads.transferMany(["x"], md)).rejects.toMatchObject({
          code: "LOCKED",
        });
        await expect(md.transferMany(["y"], beads)).rejects.toMatchObject({
          code: "LOCKED",
        });
      } finally {
        release();
        await holder;
      }
      expect((await md.list({})).items.map((task) => task.id)).toEqual(["y"]);
      expect((await beads.list({})).items.map((task) => task.id)).toEqual([
        "x",
      ]);
    }, 30_000);

    it("refuses to move tasks onto the same database through an alias", async () => {
      const alias = join(ws.dir, "alias.db");
      symlinkSync(ws.path, alias);
      const store = new BeadsStore({ path: ws.path });
      await store.create({ id: "x", title: "X" });
      await expect(
        new BeadsStore({ path: alias }).transferMany(["x"], store),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect((await store.list({})).total).toBe(1);
    }, 30_000);

    it("show reads the task and the graph it is shown against in one snapshot", async () => {
      const store = new BeadsStore({ path: ws.path });
      await store.create({ id: "blocker", title: "Blocker" });
      await store.create({
        id: "x",
        title: "X",
        deps: [{ type: "blocked-by", id: "blocker" }],
      });
      const recorder = recordBr(ws.dir, ws.path);
      const context = resolveTasksContext({
        backend: "beads",
        file: ws.path,
        cwd: ws.dir,
        home: ws.dir,
        env: { TASKS_AXI_BEADS_BINARY: recorder.binary },
      });
      expect(await showCommand(["x"], context)).toContain("blocker");
      const reads = readFileSync(recorder.log, "utf8")
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as string[])[2])
        .filter((command) => command === "list" || command === "show");
      expect(reads).toEqual(["list"]);
    }, 30_000);
  },
);
