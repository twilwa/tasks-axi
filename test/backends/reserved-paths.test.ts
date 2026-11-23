import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BeadsStore } from "../../src/backends/beads.js";
import { MarkdownStore } from "../../src/backends/markdown.js";
import { hasFlock } from "../beads-helpers.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tasks-axi-reserved-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("beads mirror paths cannot name lock or ready-marker files", () => {
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
  );

  // With Markdown only, every path and name is handled exactly as on main.
  it.each(["notes.lock", "beads.db.tasks-axi-ready"])(
    "leaves a markdown-only backlog named %s alone, as on main",
    async (name) => {
      const path = join(dir, name);
      writeFileSync(path, "# Backlog\n\n## Queued\n");
      const store = new MarkdownStore({ path });
      await store.create({ id: "a", title: "A" });
      expect(readFileSync(path, "utf8")).toContain("a - A");
    },
  );
});
