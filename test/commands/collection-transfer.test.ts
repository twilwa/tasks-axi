import { describe, expect, it } from "vitest";
import { dirname } from "node:path";
import { BeadsStore } from "../../src/backends/beads.js";
import { mvCommand } from "../../src/commands/state.js";
import type { TasksContext } from "../../src/context.js";
import { hasBr, makeBeadsWorkspace } from "../beads-helpers.js";
import { makeBacklog } from "../helpers.js";

describe.skipIf(!hasBr)("mv between markdown and beads collections", () => {
  for (const [from, to] of [
    ["markdown", "beads"],
    ["beads", "markdown"],
    ["beads", "beads"],
  ]) {
    it(`moves multiple ids ${from} -> ${to} with JSON confirmation and a convergent retry`, async () => {
      const markdown = makeBacklog("# Backlog\n");
      const left = makeBeadsWorkspace();
      const right = makeBeadsWorkspace();
      const source: TasksContext =
        from === "markdown"
          ? markdown.ctx
          : {
              store: new BeadsStore({ path: left.path }),
              config: { backend: "beads", path: left.path, doneKeep: 10 },
            };
      const targetPath =
        to === "markdown" ? markdown.path : dirname(right.path);
      const target =
        to === "markdown"
          ? markdown.store
          : new BeadsStore({ path: right.path });
      try {
        await source.store.create({ id: "root", title: "Root" });
        await source.store.create({
          id: "work",
          title: "Work",
          deps: [{ type: "blocked-by", id: "root", reason: "wait" }],
        });
        const args = [
          "work",
          "root",
          "work",
          "--to",
          targetPath,
          ...(from === to ? [] : ["--to-backend", to]),
          "--json",
        ];
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(JSON.parse(await mvCommand(args, source))).toEqual({
            ok: true,
            action: "mv",
            ids: ["work", "root"],
            from: source.config.path,
            to: targetPath,
          });
        }
        expect((await source.store.list({})).total).toBe(0);
        expect((await target.list({})).total).toBe(2);
        expect(await target.get("work")).toMatchObject({
          deps: [{ type: "blocked-by", id: "root", reason: "wait" }],
        });
      } finally {
        markdown.cleanup();
        left.cleanup();
        right.cleanup();
      }
    }, 30_000);
  }
});
