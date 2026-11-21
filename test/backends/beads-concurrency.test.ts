import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BeadsStore } from "../../src/backends/beads.js";
import { hasBr, makeBeadsWorkspace, recordBr } from "../beads-helpers.js";

let workspace: ReturnType<typeof makeBeadsWorkspace>;
const lockModule = pathToFileURL(resolve("src/backends/lock.ts")).href;

function mirrored(binary?: string): BeadsStore {
  return new BeadsStore({
    path: workspace.path,
    mirrorPath: join(workspace.dir, "backlog.md"),
    mirrorArchivePath: join(workspace.dir, "done-archive.md"),
    ...(binary ? { binary } : {}),
  });
}

describe.skipIf(!hasBr)("beads concurrency and write cost", () => {
  beforeEach(() => {
    workspace = makeBeadsWorkspace();
  });
  afterEach(() => workspace?.cleanup());

  it("lets 8 parallel writers through separate stores all succeed", async () => {
    await mirrored().create({ id: "seed", title: "Seed" });
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        mirrored().create({ id: "par-" + i, title: "Parallel " + i }),
      ),
    );
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect((await mirrored().list({})).total).toBe(9);
    const mirror = readFileSync(join(workspace.dir, "backlog.md"), "utf8");
    for (let i = 0; i < 8; i++) expect(mirror).toContain("par-" + i + " - ");
  }, 120_000);

  it("recovers the database lock left by an interrupted writer", async () => {
    const script = join(workspace.dir, "crash.mts");
    writeFileSync(
      script,
      "import { withLock } from " +
        JSON.stringify(lockModule) +
        ";\nawait withLock(process.argv[2], () => process.exit(9), { recover: {} });\n",
    );
    const code = await new Promise((done) =>
      spawn(process.execPath, ["--import", "tsx", script, workspace.path], {
        stdio: "inherit",
      }).on("close", done),
    );
    expect(code).toBe(9);
    expect(readFileSync(workspace.path + ".lock", "utf8")).toContain("pid=");
    await expect(
      mirrored().create({ id: "after-crash", title: "After crash" }),
    ).resolves.toMatchObject({ id: "after-crash" });
  }, 60_000);

  it("leaves the mirror exactly as a full re-render after every kind of write", async () => {
    const store = mirrored();
    const files = () =>
      ["backlog.md", "done-archive.md"]
        .map((name) => readFileSync(join(workspace.dir, name), "utf8"))
        .join("\n----\n");
    const fresh = async () => {
      await mirrored().render();
      return files();
    };
    const writes: [string, () => Promise<unknown>][] = [
      ["create", () => store.create({ id: "a", title: "A", body: "Body" })],
      [
        "create linked",
        () =>
          store.create({
            id: "b",
            title: "B",
            deps: [{ type: "blocked-by", id: "a" }],
          }),
      ],
      ["start", () => store.transition("b", "in_flight")],
      [
        "update",
        () => store.update("a", { body: "New", priority: 1, repo: "r" }),
      ],
      [
        "hold",
        () =>
          store.update("a", { hold: { reason: "waiting", kind: "external" } }),
      ],
      [
        "add dep",
        () => store.addDep("a", { type: "discovered-from", id: "c" }),
      ],
      [
        "remove dep",
        () => store.removeDep("b", { type: "blocked-by", id: "a" }),
      ],
      [
        "done",
        () =>
          store.transition("a", "done", {
            pr: "https://github.com/o/r/pull/1",
          }),
      ],
      ["reopen", () => store.transition("a", "queued")],
      ["remove", () => store.remove("c")],
      ["idempotent update", () => store.update("b", {})],
    ];
    await store.create({ id: "c", title: "C" });
    for (const [name, write] of writes) {
      await write();
      const after = files();
      expect({ name, mirror: after }).toEqual({ name, mirror: await fresh() });
    }
  }, 120_000);

  it("keeps the number of br calls per write independent of backlog size", async () => {
    const callsFor = async (rows: number) => {
      workspace.cleanup();
      workspace = makeBeadsWorkspace();
      // Seed through br directly: shaped like adapter writes, without their cost.
      const native: string[] = [];
      for (let i = 0; i < rows; i++) {
        const deps =
          i % 4 === 1 ? [{ type: "blocked-by", id: "row-" + (i - 1) }] : [];
        const created = workspace.br([
          "create",
          "--title",
          "Row " + i,
          "--external-ref",
          "tasks-axi:row-" + i,
          "--agent-context",
          JSON.stringify({
            tasks_axi: {
              version: 1,
              created: "2026-07-01",
              prioritySet: false,
              order: i,
              deps,
            },
          }),
          ...(deps.length ? ["--deps", "blocks:" + native[i - 1]] : []),
        ]) as { id: string };
        native.push(created.id);
      }
      const recorder = recordBr(workspace.dir, workspace.path);
      const store = mirrored(recorder.binary);
      await store.create({
        id: "probe",
        title: "Probe",
        deps: [{ type: "blocked-by", id: "row-0" }],
      });
      await store.transition("probe", "in_flight");
      await store.update("probe", { body: "Notes" });
      await store.transition("probe", "done");
      return readFileSync(recorder.log, "utf8").trim().split("\n").length;
    };
    const small = await callsFor(4);
    const large = await callsFor(80);
    expect(large).toBe(small);
  }, 300_000);
});
