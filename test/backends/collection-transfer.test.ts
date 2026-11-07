import { describe, expect, it } from "vitest";
import { BeadsStore } from "../../src/backends/beads.js";
import type { Store } from "../../src/store.js";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hasBr, makeBeadsWorkspace, recordBr } from "../beads-helpers.js";
import { makeBacklog } from "../helpers.js";

describe.skipIf(!hasBr)("markdown/beads collection transfers", () => {
  for (const [from, to] of [
    ["markdown", "beads"],
    ["beads", "markdown"],
    ["beads", "beads"],
  ]) {
    it(`moves a multi-id dependency set ${from} -> ${to}, preserving reasons, state and dates`, async () => {
      const markdown = makeBacklog("# Backlog\n");
      const left = makeBeadsWorkspace();
      const right = makeBeadsWorkspace();
      const source: Store =
        from === "markdown"
          ? markdown.store
          : new BeadsStore({ path: left.path });
      const target: Store =
        to === "markdown"
          ? markdown.store
          : new BeadsStore({ path: right.path });
      try {
        await source.create({ id: "root", title: "Root", created: null });
        await source.create({
          id: "work",
          title: "SCOUT Work",
          repo: "example",
          state: "in_flight",
          priority: 4,
          created: "2026-06-15",
          body: "One\n\nTwo",
          hold: {
            reason: "Await review",
            kind: "external",
            until: "2026-09-01",
          },
          deps: [
            { type: "blocked-by", id: "root", reason: "needs root first" },
          ],
        });
        await source.create({
          id: "closed",
          title: "Finished",
          state: "done",
          closed: "2026-06-20",
        });
        const expected = await source.list({});
        // Deliberately request dependents before their blockers, with a duplicate.
        await source.transferMany!(["work", "closed", "root", "work"], target);
        expect((await source.list({})).items).toEqual([]);
        expect((await target.list({})).items).toEqual(
          expect.arrayContaining(expected.items),
        );
        expect((await target.list({})).total).toBe(3);
        expect(await target.get("root")).not.toHaveProperty("created");
        expect(await target.get("closed")).toMatchObject({
          state: "done",
          closed: "2026-06-20",
        });
      } finally {
        markdown.cleanup();
        left.cleanup();
        right.cleanup();
      }
    }, 30_000);
  }
  for (const [from, to, crashOn] of [
    ["markdown", "beads", "create"],
    ["beads", "markdown", "delete"],
    ["beads", "beads", "create"],
    ["beads", "beads", "delete"],
  ]) {
    it(`reruns after a process dies just after br ${crashOn}: ${from} -> ${to}`, async () => {
      const markdown = makeBacklog("# Backlog\n");
      const left = makeBeadsWorkspace();
      const right = makeBeadsWorkspace();
      const sourcePath = from === "markdown" ? markdown.path : left.path;
      const targetPath = to === "markdown" ? markdown.path : right.path;
      const source: Store =
        from === "markdown"
          ? markdown.store
          : new BeadsStore({ path: left.path });
      const target: Store =
        to === "markdown"
          ? markdown.store
          : new BeadsStore({ path: right.path });
      const faultWorkspace = crashOn === "delete" ? left : right;
      const recorder = recordBr(faultWorkspace.dir, faultWorkspace.path, {
        // This wrapper's parent is ONLY the dedicated transfer child below.
        after: `if (result.status === 0 && args[2] === ${JSON.stringify(crashOn)}) process.kill(process.ppid, 'SIGKILL');`,
      });
      try {
        await source.create({ id: "root", title: "Root", created: null });
        await source.create({
          id: "work",
          title: "Work",
          deps: [{ type: "blocked-by", id: "root", reason: "wait" }],
        });
        const expected = (await source.list({})).items;
        const child = spawnSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `
          import { BeadsStore } from ${JSON.stringify(new URL("../../src/backends/beads.ts", import.meta.url).href)};
          import { MarkdownStore } from ${JSON.stringify(new URL("../../src/backends/markdown.ts", import.meta.url).href)};
          const source = new ${from === "markdown" ? "MarkdownStore" : "BeadsStore"}(${JSON.stringify({ path: sourcePath, ...(crashOn === "delete" ? { binary: recorder.binary } : {}) })});
          const target = new ${to === "markdown" ? "MarkdownStore" : "BeadsStore"}(${JSON.stringify({ path: targetPath, ...(crashOn === "create" ? { binary: recorder.binary } : {}) })});
          await source.transferMany(["work", "root"], target);
        `,
          ],
          { encoding: "utf8", timeout: 20_000 },
        );
        expect(child.error).toBeUndefined();
        expect(child.signal).toBe("SIGKILL");
        // The child has exited. Only its throwaway locks can now be removed.
        for (const path of [sourcePath, targetPath])
          rmSync(`${path}.lock`, { force: true });
        for (const id of ["root", "work"]) {
          expect(
            (await source.get(id)) ?? (await target.get(id)),
          ).not.toBeNull();
        }
        await source.transferMany!(["work", "root"], target);
        expect((await source.list({})).total).toBe(0);
        expect((await target.list({})).items).toEqual(
          expect.arrayContaining(expected),
        );
        expect((await target.list({})).total).toBe(2);
      } finally {
        markdown.cleanup();
        left.cleanup();
        right.cleanup();
      }
    }, 30_000);
  }

  it("resumes an interrupted multi-id transfer, including already removed source ids", async () => {
    const markdown = makeBacklog("# Backlog\n");
    const workspace = makeBeadsWorkspace();
    const beads = new BeadsStore({ path: workspace.path });
    try {
      await markdown.store.create({ id: "root", title: "Root", created: null });
      await markdown.store.create({
        id: "work",
        title: "Work",
        deps: [{ type: "blocked-by", id: "root", reason: "wait" }],
      });
      // The persisted state after the destination graph was written and the
      // dependent removed, but the process stopped before removing the blocker.
      for (const id of ["root", "work"]) {
        const task = (await markdown.store.get(id))!;
        await beads.create({ ...task, created: task.created ?? null });
      }
      await markdown.store.remove("work");
      await markdown.store.transferMany(["work", "root"], beads);
      expect((await markdown.store.list({})).total).toBe(0);
      expect((await beads.list({})).total).toBe(2);
      expect(await beads.get("work")).toMatchObject({
        deps: [{ type: "blocked-by", id: "root", reason: "wait" }],
      });
      // A final retry after success is also a no-op.
      await markdown.store.transferMany(["work", "root"], beads);
      expect((await beads.list({})).total).toBe(2);
    } finally {
      markdown.cleanup();
      workspace.cleanup();
    }
  });

  for (const [from, to] of [
    ["markdown", "beads"],
    ["beads", "markdown"],
    ["beads", "beads"],
  ]) {
    it(`refuses a differing destination collision before moving any id: ${from} -> ${to}`, async () => {
      const markdown = makeBacklog("# Backlog\n");
      const left = makeBeadsWorkspace();
      const right = makeBeadsWorkspace();
      const source: Store =
        from === "markdown"
          ? markdown.store
          : new BeadsStore({ path: left.path });
      const target: Store =
        to === "markdown"
          ? markdown.store
          : new BeadsStore({ path: right.path });
      try {
        await source.create({ id: "fresh", title: "Fresh" });
        await source.create({
          id: "collision",
          title: "Same title",
          hold: { reason: "Source hold", until: "2026-08-01" },
        });
        await target.create({
          id: "collision",
          title: "Same title",
          hold: { reason: "Destination hold", until: "2026-09-01" },
        });
        const sourceBefore = await source.list({});
        const targetBefore = await target.list({});
        await expect(
          source.transferMany!(["fresh", "collision"], target),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        expect(await source.list({})).toEqual(sourceBefore);
        expect(await target.list({})).toEqual(targetBefore);
      } finally {
        markdown.cleanup();
        left.cleanup();
        right.cleanup();
      }
    }, 30_000);
  }

  it("preserves beads metadata and all supported dependency types between beads databases", async () => {
    const left = makeBeadsWorkspace();
    const right = makeBeadsWorkspace();
    const source = new BeadsStore({ path: left.path });
    const target = new BeadsStore({ path: right.path });
    try {
      for (const id of ["root", "parent", "discovery"])
        await source.create({ id, title: id, created: null });
      await source.create({
        id: "work",
        title: "Work",
        kind: "custom",
        repo: "example",
        priority: 2,
        meta: { tracker: "example", nested: { keep: true } },
        deps: [
          { type: "blocked-by", id: "root", reason: "wait on root" },
          { type: "parent", id: "parent", reason: "part of parent" },
          {
            type: "discovered-from",
            id: "discovery",
            reason: "found during discovery",
          },
        ],
      });
      const before = await source.get("work");
      await source.transferMany(
        ["work", "discovery", "parent", "root"],
        target,
      );
      expect(await target.get("work")).toEqual(before);
      expect((await source.list({})).total).toBe(0);
      expect((await target.list({})).total).toBe(4);
    } finally {
      left.cleanup();
      right.cleanup();
    }
  }, 30_000);

  for (const refuseRestore of [false, true]) {
    it(`keeps the only surviving copies when a later source delete fails (restore refused: ${refuseRestore})`, async () => {
      const markdown = makeBacklog("# Backlog\n");
      const workspace = makeBeadsWorkspace();
      const source = new BeadsStore({ path: workspace.path });
      const counter = JSON.stringify(join(workspace.dir, "delete-count"));
      const recorder = recordBr(workspace.dir, workspace.path, {
        before: `
          if (${refuseRestore} && args[2] === 'create') process.exit(28);
          if (args[2] === 'delete') {
            const n = fs.existsSync(${counter}) ? Number(fs.readFileSync(${counter}, 'utf8')) + 1 : 1;
            fs.writeFileSync(${counter}, String(n));
            if (n === 2) process.exit(27);
          }`,
      });
      try {
        await source.create({ id: "root", title: "Root", created: null });
        await source.create({
          id: "work",
          title: "Work",
          deps: [{ type: "blocked-by", id: "root", reason: "wait" }],
        });
        const before = await source.list({});
        const faulty = new BeadsStore({
          path: workspace.path,
          binary: recorder.binary,
        });
        const move = faulty.transferMany(["root", "work"], markdown.store);
        if (refuseRestore) {
          await expect(move).rejects.toMatchObject({
            code: "CONFLICT",
            suggestions: expect.arrayContaining([
              expect.stringContaining("Rerun the same mv"),
            ]),
          });
          expect((await markdown.store.list({})).total).toBe(2);
          expect(await source.get("work")).toBeNull();
          await source.transferMany(["root", "work"], markdown.store);
          expect((await source.list({})).total).toBe(0);
        } else {
          await expect(move).rejects.toThrow();
          expect(await source.list({})).toEqual(before);
          expect((await markdown.store.list({})).total).toBe(0);
        }
      } finally {
        markdown.cleanup();
        workspace.cleanup();
      }
    }, 30_000);
  }

  it("cleans up a destination create whose br reply fails after the native write committed", async () => {
    const markdown = makeBacklog("# Backlog\n");
    const workspace = makeBeadsWorkspace();
    const recorder = recordBr(workspace.dir, workspace.path, {
      after:
        "if (args[2] === 'create' && result.status === 0) process.exit(29);",
    });
    const target = new BeadsStore({
      path: workspace.path,
      binary: recorder.binary,
    });
    try {
      await markdown.store.create({ id: "root", title: "Root" });
      await expect(
        markdown.store.transferMany(["root"], target),
      ).rejects.toThrow();
      expect(await markdown.store.get("root")).not.toBeNull();
      expect(await target.get("root")).toBeNull();
    } finally {
      markdown.cleanup();
      workspace.cleanup();
    }
  }, 30_000);

  it("does not let an unrelated async chain bypass transfer-owned collection locks", async () => {
    const markdown = makeBacklog("# Backlog\n");
    const workspace = makeBeadsWorkspace();
    const target = new BeadsStore({ path: workspace.path });
    const other = new BeadsStore({ path: workspace.path });
    let started!: () => void;
    let finish!: () => void;
    const copying = new Promise<void>((resolve) => {
      started = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      await markdown.store.create({ id: "root", title: "Root" });
      await target.create({ id: "unrelated", title: "Unrelated" });
      const create = target.create.bind(target);
      target.create = async (input) => {
        const task = await create(input);
        started();
        await resume;
        return task;
      };
      const move = markdown.store.transferMany(["root"], target);
      await copying;
      try {
        await expect(
          other.update("unrelated", { body: "Changed" }),
        ).rejects.toMatchObject({ code: "LOCKED" });
      } finally {
        finish();
        await move;
      }
      expect(await markdown.store.get("root")).toBeNull();
      expect(await target.get("unrelated")).not.toHaveProperty("body");
    } finally {
      finish();
      markdown.cleanup();
      workspace.cleanup();
    }
  }, 30_000);

  it("keeps sources and refuses rollback over hand-edited destination content", async () => {
    const markdown = makeBacklog("# Backlog\n");
    const workspace = makeBeadsWorkspace();
    const source = new BeadsStore({ path: workspace.path });
    try {
      await source.create({ id: "root", title: "Original title" });
      await source.create({ id: "work", title: "Work" });
      const before = await source.list({});
      const create = markdown.store.create.bind(markdown.store);
      markdown.store.create = async (input) => {
        const task = await create(input);
        if (input.id === "work")
          writeFileSync(
            markdown.path,
            markdown
              .read()
              .replace("Original title", "Hand-edited destination"),
          );
        return task;
      };
      await expect(
        source.transferMany(["root", "work"], markdown.store),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await source.list({})).toEqual(before);
      expect(await markdown.store.get("root")).toMatchObject({
        title: "Hand-edited destination",
      });
    } finally {
      markdown.cleanup();
      workspace.cleanup();
    }
  }, 30_000);

  it("refuses to remove a source changed by hand after the destination copy was staged", async () => {
    const markdown = makeBacklog("# Backlog\n");
    const workspace = makeBeadsWorkspace();
    const target = new BeadsStore({ path: workspace.path });
    try {
      await markdown.store.create({ id: "root", title: "Original title" });
      const remove = markdown.store.remove.bind(markdown.store);
      markdown.store.remove = async (id) => {
        writeFileSync(
          markdown.path,
          markdown.read().replace("Original title", "Hand-edited title"),
        );
        return remove(id);
      };
      await expect(
        markdown.store.transferMany(["root"], target),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await markdown.store.get("root")).toMatchObject({
        title: "Hand-edited title",
      });
      expect(await target.get("root")).toBeNull();
    } finally {
      markdown.cleanup();
      workspace.cleanup();
    }
  }, 30_000);

  it("never deletes a beads task when markdown cannot represent its metadata", async () => {
    const markdown = makeBacklog("# Backlog\n");
    const workspace = makeBeadsWorkspace();
    const beads = new BeadsStore({ path: workspace.path });
    try {
      await beads.create({
        id: "with-meta",
        title: "Has metadata",
        meta: { tracker: "example", nested: { keep: true } },
      });
      const before = await beads.get("with-meta");
      await expect(
        beads.transferMany(["with-meta"], markdown.store),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(await beads.get("with-meta")).toEqual(before);
      expect(await markdown.store.get("with-meta")).toBeNull();
    } finally {
      markdown.cleanup();
      workspace.cleanup();
    }
  });

  it("refuses stranded dependencies before writing any destination task", async () => {
    const markdown = makeBacklog("# Backlog\n");
    const workspace = makeBeadsWorkspace();
    const recorder = recordBr(workspace.dir, workspace.path);
    const beads = new BeadsStore({
      path: workspace.path,
      binary: recorder.binary,
    });
    try {
      await markdown.store.create({ id: "root", title: "Root" });
      await markdown.store.create({
        id: "work",
        title: "Work",
        deps: [{ type: "blocked-by", id: "root", reason: "wait" }],
      });
      const before = markdown.read();
      await expect(
        markdown.store.transferMany(["root"], beads),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      await expect(
        markdown.store.transferMany(["work"], beads),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(markdown.read()).toBe(before);
      const commands = readFileSync(recorder.log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(
        commands.some((args) =>
          ["create", "delete", "update"].includes(args[2]),
        ),
      ).toBe(false);
    } finally {
      markdown.cleanup();
      workspace.cleanup();
    }
  });

  it("moves markdown to beads without changing worker fields", async () => {
    const markdown = makeBacklog("# Backlog\n");
    const workspace = makeBeadsWorkspace();
    const beads = new BeadsStore({ path: workspace.path });
    try {
      await markdown.store.create({
        id: "transfer-me",
        title: "SCOUT investigate https://github.com/example/repo/pull/42",
        state: "in_flight",
        repo: "example",
        priority: 0,
        body: "Current notes\n\nSecond paragraph",
        created: "2026-06-01",
        hold: {
          reason: "Waiting for review",
          kind: "captain",
          until: "2026-08-01",
        },
      });
      const before = await markdown.store.get("transfer-me");
      await markdown.store.transferMany(["transfer-me"], beads);
      expect(await markdown.store.get("transfer-me")).toBeNull();
      expect(await beads.get("transfer-me")).toEqual(before);
    } finally {
      markdown.cleanup();
      workspace.cleanup();
    }
  });
});
