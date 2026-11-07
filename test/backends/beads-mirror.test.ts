import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTasksContext } from "../../src/context.js";
import { MarkdownStore } from "../../src/backends/markdown.js";
import { BeadsStore } from "../../src/backends/beads.js";
import { hasBr, makeBeadsWorkspace, recordBr } from "../beads-helpers.js";

let ws: ReturnType<typeof makeBeadsWorkspace>;

describe.skipIf(!hasBr)("opt-in beads markdown mirror", () => {
  beforeEach(() => {
    ws = makeBeadsWorkspace();
    writeFileSync(
      join(ws.dir, ".tasks.toml"),
      `backend = "beads"
[markdown]
done_keep = 1
[beads]
path = ".beads/beads.db"
mirror = "mirror/backlog.md"
mirror_archive = "mirror/done-archive.md"
`,
    );
  });
  afterEach(() => ws.cleanup());

  it.each([
    "database",
    "wal",
    "lock",
    "note archive",
    "same output",
    "archive only",
  ])("rejects unsafe mirror paths before writes: %s", (collision) => {
    const protectedPath = {
      database: ws.path,
      wal: `${ws.path}-wal`,
      lock: `${ws.path}.lock`,
      "note archive": join(ws.dir, ".beads/note-archive.md"),
      "same output": join(ws.dir, "mirror/backlog.md"),
      "archive only": undefined,
    }[collision];
    expect(
      () =>
        new BeadsStore({
          path: ws.path,
          mirrorPath:
            collision === "archive only"
              ? undefined
              : join(ws.dir, "mirror/backlog.md"),
          mirrorArchivePath:
            protectedPath ?? join(ws.dir, "mirror/done-archive.md"),
        }),
    ).toThrow(/mirror/);
  });

  it("rejects database and output aliases through existing symlink ancestors", () => {
    symlinkSync(
      join(ws.dir, ".beads"),
      join(ws.dir, "database-alias"),
      "junction",
    );
    expect(
      () =>
        new BeadsStore({
          path: ws.path,
          mirrorPath: join(ws.dir, "database-alias/beads.db"),
        }),
    ).toThrow(/mirror paths/);
    mkdirSync(join(ws.dir, "mirror"));
    symlinkSync(
      join(ws.dir, "mirror"),
      join(ws.dir, "mirror-alias"),
      "junction",
    );
    expect(
      () =>
        new BeadsStore({
          path: ws.path,
          mirrorPath: join(ws.dir, "mirror/backlog.md"),
          mirrorArchivePath: join(ws.dir, "mirror-alias/backlog.md"),
        }),
    ).toThrow(/mirror paths/);
  });

  it("does not generate mirrors without opt-in, or on reads; idempotent writes refresh under the lock", async () => {
    const plain = new BeadsStore({ path: ws.path });
    await plain.create({ id: "existing-q1", title: "existing task" });
    expect(existsSync(join(ws.dir, "backlog.md"))).toBe(false);
    expect(existsSync(join(ws.dir, "done-archive.md"))).toBe(false);
    const configured = resolveTasksContext({
      cwd: ws.dir,
      home: ws.dir,
      env: {},
    });
    await configured.store.list({});
    await configured.store.get("existing-q1");
    expect(existsSync(join(ws.dir, "mirror"))).toBe(false);
    const recorder = recordBr(ws.dir, ws.path, {
      before: `if (!fs.existsSync(${JSON.stringify(`${ws.path}.lock`)})) process.exit(98);`,
    });
    const guarded = new BeadsStore({
      path: ws.path,
      binary: recorder.binary,
      mirrorPath: join(ws.dir, "mirror/backlog.md"),
    });
    expect((await guarded.update("existing-q1", {})).changed).toEqual([]);
    expect(
      (
        await new MarkdownStore({
          path: join(ws.dir, "mirror/backlog.md"),
        }).get("existing-q1")
      )?.title,
    ).toBe("existing task");
    expect(existsSync(`${ws.path}.lock`)).toBe(false);
    expect(guarded.capabilities().prune).toBe(false);
  }, 30_000);

  it("supports zero retained Done rows and preserves their complete archive bodies", async () => {
    const store = new BeadsStore({
      path: ws.path,
      mirrorPath: join(ws.dir, "mirror/backlog.md"),
      doneKeep: 0,
    });
    await store.create({
      id: "completed-d1",
      title: "completed",
      state: "done",
      closed: "2026-01-01",
      body: "## Result\nAll notes retained.",
    });
    expect(
      (
        await new MarkdownStore({
          path: join(ws.dir, "mirror/backlog.md"),
        }).list({})
      ).total,
    ).toBe(0);
    expect(
      await new MarkdownStore({
        path: join(ws.dir, "mirror/done-archive.md"),
        archived: true,
      }).get("completed-d1"),
    ).toEqual(await store.get("completed-d1"));
    expect((await store.list({})).total).toBe(1);
  }, 30_000);

  it.each(["backlog.md", "done-archive.md"])(
    "reports a failed %s replacement without rolling back beads and can rebuild",
    async (blocked) => {
      const ctx = resolveTasksContext({ cwd: ws.dir, home: ws.dir, env: {} });
      const blockedPath = join(ws.dir, "mirror", blocked);
      mkdirSync(blockedPath, { recursive: true });
      await expect(
        ctx.store.create({
          id: "saved-q1",
          title: "persisted despite mirror failure",
        }),
      ).rejects.toThrow(
        /Beads write succeeded, but markdown mirror refresh failed/,
      );
      expect((await ctx.store.get("saved-q1"))?.title).toBe(
        "persisted despite mirror failure",
      );
      expect(
        readdirSync(join(ws.dir, "mirror")).some((name) =>
          name.includes(".tmp-"),
        ),
      ).toBe(false);
      if (blocked === "done-archive.md")
        expect(existsSync(join(ws.dir, "mirror/backlog.md"))).toBe(false);
      rmSync(blockedPath, { recursive: true });
      expect(await ctx.store.render?.()).toBe(1);
      expect(
        await new MarkdownStore({
          path: join(ws.dir, "mirror/backlog.md"),
        }).get("saved-q1"),
      ).toEqual(await ctx.store.get("saved-q1"));
    },
    30_000,
  );

  it("writes canonical read-only markdown after mutations, retaining newest closed tasks without deleting history", async () => {
    const ctx = resolveTasksContext({ cwd: ws.dir, home: ws.dir, env: {} });
    const activePath = join(ws.dir, "mirror/backlog.md");
    const archivePath = join(ws.dir, "mirror/done-archive.md");
    const active = new MarkdownStore({ path: activePath });
    const archived = new MarkdownStore({ path: archivePath, archived: true });
    await ctx.store.create({
      id: "worker-q1",
      title: "SHIP implementation",
      body: "## Intent\nWork carefully.\n\nSecond paragraph.",
      kind: "ship",
      repo: "example",
      priority: 0,
      created: "2026-01-01",
      hold: { reason: "review pending", kind: "captain", until: "2099-01-01" },
    });
    expect(await active.get("worker-q1")).toEqual(
      await ctx.store.get("worker-q1"),
    );
    expect(readFileSync(activePath, "utf8")).toContain("read-only");
    await ctx.store.create({
      id: "old-d1",
      title: "old",
      state: "done",
      closed: "2025-01-01",
    });
    await ctx.store.create({
      id: "new-d2",
      title: "new",
      state: "done",
      closed: "2026-01-01",
    });
    await ctx.store.create({
      id: "oldest-d3",
      title: "oldest",
      state: "done",
      closed: "2024-01-01",
    });
    expect(
      (await active.list({ state: "done" })).items.map((task) => task.id),
    ).toEqual(["new-d2"]);
    expect((await archived.list({})).items.map((task) => task.id)).toEqual([
      "old-d1",
      "oldest-d3",
    ]);
    expect((await ctx.store.list({})).total).toBe(4);
    await ctx.store.addDep("worker-q1", {
      type: "blocked-by",
      id: "new-d2",
      reason: "needs the published result",
    });
    expect(await active.get("worker-q1")).toEqual(
      await ctx.store.get("worker-q1"),
    );
    await ctx.store.update("worker-q1", {
      body: "Curated replacement.",
      hold: null,
    });
    expect(await active.get("worker-q1")).toEqual(
      await ctx.store.get("worker-q1"),
    );
    await ctx.store.transition("oldest-d3", "queued");
    expect(await active.get("oldest-d3")).toEqual(
      await ctx.store.get("oldest-d3"),
    );
    expect(await archived.get("oldest-d3")).toBeNull();
    await ctx.store.removeDep("worker-q1", {
      type: "blocked-by",
      id: "new-d2",
    });
    expect((await active.get("worker-q1"))?.deps).toEqual([]);
    await ctx.store.remove("old-d1");
    expect(await archived.get("old-d1")).toBeNull();
  }, 30_000);
});
