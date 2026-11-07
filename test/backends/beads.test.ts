import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BeadsStore } from "../../src/backends/beads.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTasksContext } from "../../src/context.js";
import type { Store } from "../../src/store.js";
import { hasBr, makeBeadsWorkspace } from "../beads-helpers.js";

let workspace: ReturnType<typeof makeBeadsWorkspace>;
let store: Store;
describe.skipIf(!hasBr)("beads_rust Store conformance", () => {
  beforeEach(() => {
    workspace = makeBeadsWorkspace();
    store = resolveTasksContext({
      backend: "beads",
      file: workspace.path,
      cwd: workspace.dir,
      home: workspace.dir,
      env: {},
    }).store;
  });
  afterEach(() => workspace?.cleanup());

  it("does not truncate large reads, applies query limits after total, and sees native state changes", async () => {
    const metadata = (order: number) =>
      JSON.stringify({
        tasks_axi: {
          version: 1,
          created: "2026-07-01",
          prioritySet: true,
          order,
          kind: "task",
          repo: "example",
        },
      });
    const body = "Detailed notes\n".repeat(80_000);
    for (let i = 0; i < 52; i++)
      workspace.br(
        [
          "create",
          "--title",
          `Task ${i}`,
          "--slug",
          `item-${i}`,
          "--external-ref",
          `tasks-axi:item-${i}`,
          "--agent-context",
          metadata(i),
          ...(i === 0 ? ["--description-file", "-"] : []),
        ],
        i === 0 ? body : undefined,
      );
    const { items, total } = await store.list({
      repo: "example",
      kind: "task",
      limit: 2,
    });
    expect(total).toBe(52);
    expect(items.map((item) => item.id)).toEqual(["item-0", "item-1"]);
    expect(items[0].body).toBe(body);
    expect((await store.list({ limit: 0 })).total).toBe(52);
    expect((await store.list({ repo: "elsewhere" })).items).toEqual([]);
    const raw = workspace.br(["list", "--all", "--limit", "0"]) as {
      issues: Record<string, unknown>[];
    };
    const first = raw.issues.find(
      (bead) => bead.external_ref === "tasks-axi:item-0",
    )!;
    for (const status of ["blocked", "deferred"]) {
      workspace.br(["update", String(first.id), "--status", status]);
      expect((await store.get("item-0"))?.state).toBe("queued");
    }
    await store.transition("item-0", "done", { date: "2026-07-02" });
    expect((await store.list({ state: "done" })).items).toMatchObject([
      { id: "item-0", closed: "2026-07-02" },
    ]);
  }, 60_000);

  it("observes other instances and serializes concurrent mutations without losing fields", async () => {
    const other = new BeadsStore({ path: workspace.path });
    expect(await store.get("shared")).toBeNull();
    await other.create({ id: "shared", title: "Shared" });
    expect((await store.get("shared"))?.title).toBe("Shared");
    await Promise.all([
      store.update("shared", { body: "Current notes" }),
      other.update("shared", { meta: { reviewed: true } }),
    ]);
    expect(await store.get("shared")).toMatchObject({
      body: "Current notes",
      meta: { reviewed: true },
    });
    const results = await Promise.allSettled([
      store.create({ id: "once", title: "First" }),
      other.create({ id: "once", title: "Second" }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { code: "CONFLICT" } });
    expect((await other.list({})).total).toBe(2);
  }, 30_000);

  it("rejects corrupt adapter data without exposing unrelated native issues", async () => {
    workspace.br(["create", "--title", "Unmanaged native work"]);
    expect((await store.list({})).items).toEqual([]);
    await store.create({ id: "managed", title: "Managed" });
    const raw = workspace.br(["list", "--all", "--limit", "0"]) as {
      issues: Record<string, unknown>[];
    };
    const native = raw.issues.find(
      (bead) => bead.external_ref === "tasks-axi:managed",
    )!;
    workspace.br([
      "update",
      String(native.id),
      "--force",
      "--agent-context",
      JSON.stringify({ tasks_axi: { version: 1, deps: "not-an-array" } }),
    ]);
    await expect(store.get("managed")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
  }, 30_000);

  it("maps all native edge types to bare ids, preserves reasons, and rejects cycles", async () => {
    for (const id of ["blocked", "parent", "origin", "child"])
      await store.create({ id, title: id });
    const deps = [
      {
        type: "blocked-by" as const,
        id: "blocked",
        reason: "Needs prerequisite",
      },
      { type: "parent" as const, id: "parent", reason: "Part of parent" },
      { type: "discovered-from" as const, id: "origin", reason: "Follow-up" },
    ];
    for (const dep of deps) expect(await store.addDep("child", dep)).toBe(true);
    expect((await store.get("child"))?.deps).toEqual(deps);
    await expect(
      store.create({
        id: "ambiguous",
        title: "Invalid pair",
        deps: [deps[0], { type: "parent", id: "blocked" }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await store.get("ambiguous")).toBeNull();
    expect(await store.addDep("child", deps[0])).toBe(false);
    await expect(
      store.addDep("child", { type: "parent", id: "blocked" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      store.addDep("blocked", { type: "blocked-by", id: "child" }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringMatching(/blocked.*child/),
    });
    expect(await store.removeDep("child", deps[1])).toBe(true);
    expect(await store.removeDep("child", deps[1])).toBe(false);
    expect((await store.get("child"))?.deps).toEqual([deps[0], deps[2]]);
  }, 30_000);

  it("persists untruncated metadata, native mirrors, and archived bodies as comments", async () => {
    const body = "Original notes\n\n" + "details ".repeat(40);
    const kind = "kind-" + "x".repeat(60);
    const repo = "repo-" + "y".repeat(60);
    await store.create({
      id: "metadata",
      title: "Metadata",
      body,
      kind,
      repo,
      priority: 0,
      created: "2026-07-01",
      meta: { source: "example" },
      hold: { reason: "Await approval", kind: "captain", until: "2099-01-01" },
    });
    const raw = workspace.br(["list", "--all", "--limit", "0"]) as {
      issues: Record<string, unknown>[];
    };
    const native = raw.issues[0];
    expect(native.id).not.toBe("metadata");
    expect(native).toMatchObject({
      external_ref: "tasks-axi:metadata",
      description: body,
      priority: 0,
      status: "open",
    });
    expect(native.labels).toEqual(
      expect.arrayContaining([
        `kind:${kind}`.slice(0, 50),
        `repo:${repo}`.slice(0, 50),
        "hold:captain",
      ]),
    );
    expect(String(native.defer_until)).toMatch(/^2099-01-01/);
    expect(JSON.parse(String(native.agent_context))).toMatchObject({
      tasks_axi: {
        version: 1,
        kind,
        repo,
        created: "2026-07-01",
        meta: { source: "example" },
        hold: {
          reason: "Await approval",
          kind: "captain",
          until: "2099-01-01",
        },
      },
    });
    workspace.br(["update", String(native.id), "--add-label", "unrelated"]);
    await store.update("metadata", {
      body: "Short",
      archiveBody: true,
      kind: "scout",
      repo: "new-repo",
      hold: null,
    });
    const comments = workspace.br(["comments", "list", String(native.id)]) as {
      text: string;
    }[];
    expect(comments.map((comment) => comment.text)).toEqual([body]);
    const [updated] = workspace.br(["show", String(native.id)]) as Record<
      string,
      unknown
    >[];
    expect(updated.description).toBe("Short");
    expect(updated.labels).toEqual(
      expect.arrayContaining(["kind:scout", "repo:new-repo", "unrelated"]),
    );
    expect(updated.labels).not.toContain("hold:captain");
    expect(updated.defer_until).toBeUndefined();
    expect(await store.get("metadata")).toMatchObject({
      kind: "scout",
      repo: "new-repo",
      body: "Short",
      meta: { source: "example" },
    });
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "pins all commands to the selected DB and hydrates the graph with one batched show",
    async () => {
      const log = join(workspace.dir, "commands.jsonl");
      const wrapper = join(workspace.dir, "record-br.cjs");
      const db = join(workspace.dir, "isolated", ".beads", "beads.db");
      const ignoreTitle = join(workspace.dir, "ignore-title");
      const failDelete = join(workspace.dir, "fail-delete");
      // A process-boundary recorder, not a fake br response or PATH shim.
      // The marker enables a single deliberately ignored field for read-back testing.
      writeFileSync(
        wrapper,
        `#!${process.execPath}\nconst fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] !== '--db' || args[1] !== ${JSON.stringify(db)}) process.exit(99);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (fs.existsSync(${JSON.stringify(ignoreTitle)}) && args.includes('--title')) args.splice(args.indexOf('--title'), 2);
if (fs.existsSync(${JSON.stringify(failDelete)}) && args[2] === 'delete') process.exit(27);
const result = spawnSync('br', args, {input:fs.readFileSync(0), maxBuffer:16*1024*1024});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);\n`,
        { mode: 0o700 },
      );
      const recorded = new BeadsStore({ path: db, binary: wrapper });
      await recorded.create({ id: "first", title: "Prerequisite" });
      await recorded.create({
        id: "second",
        title: "Dependent",
        deps: [{ type: "blocked-by", id: "first", reason: "Waits for first" }],
      });
      const writes = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(writes[0]).toContain("init");
      expect(writes.every((args) => args[0] === "--db" && args[1] === db)).toBe(
        true,
      );
      expect(writes.find((args) => args[2] === "create")).toEqual(
        expect.arrayContaining([
          "--slug",
          "first",
          "--external-ref",
          "tasks-axi:first",
        ]),
      );
      writeFileSync(log, "");
      expect((await recorded.list({})).items[1].deps).toEqual([
        { type: "blocked-by", id: "first", reason: "Waits for first" },
      ]);
      const reads = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(reads).toHaveLength(2);
      expect(reads[0]).toEqual([
        "--db",
        db,
        "list",
        "--all",
        "--limit",
        "0",
        "--json",
      ]);
      expect(reads[1][2]).toBe("show");
      expect(reads[1].slice(3, -1)).toHaveLength(2);
      expect((await store.list({})).total).toBe(0);
      await recorded.update("second", { body: "Current notes" });
      await recorded.update("second", { body: "", archiveBody: true });
      await recorded.transition("second", "done", { date: "2026-07-02" }); // still blocked: close must force
      writeFileSync(failDelete, "");
      await expect(recorded.remove("second")).rejects.toMatchObject({
        code: "UNKNOWN",
      });
      expect((await recorded.get("second"))?.id).toBe("second"); // failed deletion restores the ref
      unlinkSync(failDelete);
      await recorded.remove("second");
      const final = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(final.find((args) => args[2] === "close")).toContain("--force");
      expect(
        final.find((args) => args.includes("--description-file")),
      ).toContain("--force");
      expect(final.find((args) => args[2] === "comments")).toEqual(
        expect.arrayContaining(["add", "-f", "-"]),
      );
      const deletion = final.findIndex((args) => args[2] === "delete");
      expect(final[deletion]).toContain("--force");
      expect(final[deletion - 1]).toEqual(
        expect.arrayContaining(["--external-ref", ""]),
      );
      writeFileSync(ignoreTitle, "");
      await expect(
        recorded.update("first", { title: "Ignored update" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      unlinkSync(ignoreTitle);
      expect((await recorded.get("first"))?.title).toBe("Prerequisite");
    },
    30_000,
  );

  it("fails validation before writes for malformed inputs and unsupported public obligations", async () => {
    for (const patch of [
      { title: "\nInvalid" },
      { title: "   " },
      { kind: "bad(kind)" },
      { priority: 8 },
      { created: "yesterday" },
      { created: "" },
      { closed: "" },
      { hold: { reason: "" } },
      { deps: [{ type: "blocked-by" as const, id: "missing" }] },
    ]) {
      await expect(
        store.create({ id: "invalid", title: "Valid title", ...patch }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(await store.get("invalid")).toBeNull();
    }
    await expect(
      store.create({
        id: "public-promise",
        title: "Promise",
        kind: "public-followup",
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await store.create({ id: "valid", title: "Valid" });
    await expect(store.update("valid", { title: "" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(
      store.update("valid", { kind: "public-followup" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(
      store.addDep("valid", { type: "blocked-by", id: "valid" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      store.addDep("valid", { type: "blocked-by", id: "missing" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  }, 30_000);

  it("protects active dependents, deletes with ref release, and permits caller id reuse", async () => {
    await store.create({ id: "reusable", title: "Original" });
    await store.create({
      id: "consumer",
      title: "Waits",
      deps: [{ type: "blocked-by", id: "reusable", reason: "Needs original" }],
    });
    await expect(store.remove("reusable")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(
      await store.removeDep("consumer", { type: "blocked-by", id: "reusable" }),
    ).toBe(true);
    expect(await store.remove("reusable")).toMatchObject({
      id: "reusable",
      title: "Original",
    });
    expect(await store.get("reusable")).toBeNull();
    expect(
      await store.create({ id: "reusable", title: "Replacement" }),
    ).toMatchObject({ id: "reusable", title: "Replacement" });
    expect((await store.list({})).items.map((task) => task.id)).toEqual([
      "consumer",
      "reusable",
    ]);
  }, 30_000);

  it("accepts an explicit workspace directory and initializes only that database with the configured prefix", async () => {
    const path = join(workspace.dir, "new", ".beads");
    const selected = resolveTasksContext({
      backend: "beads",
      file: path,
      cwd: workspace.dir,
      home: workspace.dir,
      env: { TASKS_AXI_BEADS_PREFIX: "lane" },
    }).store;
    expect(
      await selected.create({ id: "caller-id", title: "New database" }),
    ).toMatchObject({ id: "caller-id" });
    expect((await selected.list({})).total).toBe(1);
    expect(existsSync(join(path, "beads.db"))).toBe(true);
    expect(existsSync(join(path, ".beads"))).toBe(false);
    expect((await store.list({})).total).toBe(0);
  }, 30_000);

  it("creates and retrieves bare caller ids without putting adapter metadata in the body", async () => {
    const created = await store.create({
      id: "sample-task",
      title: "SCOUT investigate",
      body: "First body line\n\nLast body line",
      kind: "scout",
      repo: "example",
      priority: 1,
      created: "2026-07-01",
    });
    const task = await store.get("sample-task");
    expect(task).toEqual(created);
    expect(task).toMatchObject({
      id: "sample-task",
      title: "SCOUT investigate",
      state: "queued",
      kind: "scout",
      repo: "example",
      body: "First body line\n\nLast body line",
      priority: 1,
      created: "2026-07-01",
      links: [],
      deps: [],
    });
    expect(await store.list({})).toEqual({ items: [task], total: 1 });
    expect(await store.get("missing")).toBeNull();
    await store.create({ id: "Caller.KEY_1", title: "Mixed caller key" });
    expect((await store.get("Caller.KEY_1"))?.id).toBe("Caller.KEY_1");
  }, 30_000);
});
