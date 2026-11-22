import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BeadsStore } from "../../src/backends/beads.js";
import { withLock } from "../../src/backends/lock.js";
import { MarkdownStore } from "../../src/backends/markdown.js";
import { hasFlock } from "../beads-helpers.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tasks-axi-reserved-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("lock and ready-marker paths are reserved across stores", () => {
  it.each([
    ["another store's lock", "other/beads.db.lock"],
    ["another store's init lock", "other/beads.db.init.lock"],
    ["another store's ready marker", "other/beads.db.tasks-axi-ready"],
    ["a markdown lock", "backlog.md.lock"],
  ])("refuses a beads mirror onto %s", (_label, name) => {
    const target = join(dir, name);
    for (const options of [
      { mirrorPath: target },
      { mirrorPath: join(dir, "mirror.md"), mirrorArchivePath: target },
    ])
      expect(
        () => new BeadsStore({ path: join(dir, "beads.db"), ...options }),
      ).toThrow(/names a (tasks-axi lock file|beads ready marker)/);
  });

  it("still accepts an ordinary mirror", () => {
    expect(
      () =>
        new BeadsStore({
          path: join(dir, "beads.db"),
          mirrorPath: join(dir, "backlog.md"),
        }),
    ).not.toThrow();
  });

  it.skipIf(!hasFlock)(
    "refuses a markdown backlog or archive that would replace a live beads lock",
    async () => {
      const db = join(dir, "beads.db");
      await withLock(db, () => undefined, { kernel: true });
      const lock = db + ".lock";
      const before = readFileSync(lock, "utf8");
      for (const options of [
        { path: lock },
        { path: join(dir, "backlog.md"), archivePath: lock },
        { path: join(dir, "backlog.md"), noteArchivePath: lock },
      ])
        expect(() => new MarkdownStore(options)).toThrow(
          /names a live beads lock file/,
        );
      expect(readFileSync(lock, "utf8")).toBe(before);
    },
  );

  it("refuses a markdown file named as a ready marker", () => {
    expect(
      () => new MarkdownStore({ path: join(dir, "beads.db.tasks-axi-ready") }),
    ).toThrow(/ready marker/);
  });

  it("leaves markdown-only .lock names alone, as on main", async () => {
    const path = join(dir, "notes.lock");
    writeFileSync(path, "# Backlog\n\n## Queued\n");
    const store = new MarkdownStore({ path });
    await store.create({ id: "a", title: "A" });
    expect(readFileSync(path, "utf8")).toContain("a - A");
  });
});
