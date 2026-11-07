import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BeadsStore } from "../src/backends/beads.js";
import {
  addCommand,
  listCommand,
  rmCommand,
  showCommand,
  updateCommand,
} from "../src/commands/crud.js";
import {
  blockCommand,
  doneCommand,
  holdCommand,
  readyCommand,
  reopenCommand,
  startCommand,
  unblockCommand,
  unholdCommand,
} from "../src/commands/state.js";
import type { TasksContext } from "../src/context.js";
import { makeBacklog } from "./helpers.js";
import { hasBr, makeBeadsWorkspace } from "./beads-helpers.js";

let workspace: ReturnType<typeof makeBeadsWorkspace>;
let markdown: ReturnType<typeof makeBacklog>;
let beads: TasksContext;
type Command = (args: string[], ctx?: TasksContext) => Promise<string>;

async function same(command: Command, args: string[]) {
  const expected = await command(args, markdown.ctx);
  expect(await command(args, beads)).toBe(expected);
}

describe.skipIf(!hasBr)("markdown / br TOON parity", () => {
  beforeEach(() => {
    workspace = makeBeadsWorkspace();
    markdown = makeBacklog("", "2026-07-01");
    beads = {
      store: new BeadsStore({ path: workspace.path, now: () => "2026-07-01" }),
      config: { backend: "beads", path: workspace.path, doneKeep: 10 },
    };
  });
  afterEach(() => {
    workspace?.cleanup();
    markdown?.cleanup();
  });

  it("returns identical JSON success confirmations and removes by caller id", async () => {
    await same(addCommand, ["machine-task", "Machine readable", "--json"]);
    await same(updateCommand, [
      "machine-task",
      "--body",
      "Current notes",
      "--json",
    ]);
    await same(startCommand, ["machine-task", "--json"]);
    await same(doneCommand, ["machine-task", "--no-prune", "--json"]);
    await same(rmCommand, ["machine-task", "--json"]);
    await same(listCommand, []);
  }, 30_000);

  it("matches structured holds, hold filters, and readiness including expired holds", async () => {
    await same(addCommand, ["held-task", "Wait for review"]);
    await same(holdCommand, [
      "held-task",
      "--reason",
      "Await review",
      "--kind",
      "captain",
      "--until",
      "2099-01-01",
    ]);
    await same(holdCommand, [
      "held-task",
      "--reason",
      "Await review",
      "--kind",
      "captain",
      "--until",
      "2099-01-01",
    ]);
    await same(showCommand, ["held-task"]);
    await same(listCommand, ["--state", "held"]);
    await same(readyCommand, ["--include-held"]);
    await same(holdCommand, [
      "held-task",
      "--reason",
      "Past gate",
      "--until",
      "2020-01-01",
    ]);
    await same(readyCommand, []);
    await same(unholdCommand, ["held-task"]);
    await same(unholdCommand, ["held-task"]);
  }, 30_000);

  it("hydrates bare dependency edges and derives identical blocked/ready output", async () => {
    await same(addCommand, ["blocker", "Fix prerequisite"]);
    await same(addCommand, ["dependent", "Deliver", "--blocked-by", "blocker"]);
    await same(blockCommand, ["dependent", "--by", "blocker"]);
    await same(showCommand, ["dependent", "--full"]);
    await same(listCommand, ["--blocked"]);
    await same(readyCommand, []);
    await same(doneCommand, ["blocker", "--no-prune"]);
    await same(readyCommand, []);
    await same(unblockCommand, ["dependent", "--by", "blocker"]);
    await same(unblockCommand, ["dependent", "--by", "blocker"]);
  }, 30_000);

  it("matches start, close, close-backfill, reopen and lifecycle ordering", async () => {
    await same(addCommand, ["lifecycle", "Deliver", "--body", "Initial"]);
    await same(addCommand, ["queued-tail", "Later"]);
    await same(startCommand, ["lifecycle"]);
    await same(startCommand, ["lifecycle"]);
    await same(doneCommand, [
      "lifecycle",
      "--no-prune",
      "--pr",
      "https://github.com/example/project/pull/1",
      "--note",
      "Shipped",
    ]);
    await same(doneCommand, [
      "lifecycle",
      "--no-prune",
      "--report",
      "data/lifecycle/report.md",
      "--note",
      "Shipped",
    ]);
    await same(showCommand, ["lifecycle", "--full"]);
    await same(listCommand, ["--state", "done"]);
    await same(reopenCommand, ["lifecycle"]);
    await same(reopenCommand, ["lifecycle"]);
    await same(listCommand, []);
  }, 30_000);

  it("replaces and archives bodies, records links, and reports idempotent updates identically", async () => {
    await same(addCommand, [
      "notes",
      "Investigate",
      "--body",
      "Original notes with enough text to exercise the shrink guard",
    ]);
    const patch = [
      "notes",
      "--title",
      "Curated",
      "--body",
      "Short",
      "--archive-body",
      "--kind",
      "scout",
      "--repo",
      "example",
      "--priority",
      "3",
      "--pr",
      "https://github.com/example/project/pull/1",
      "--report",
      "data/notes/report.md",
    ];
    await same(updateCommand, patch);
    await same(updateCommand, patch);
    await same(showCommand, ["notes", "--full"]);
  }, 30_000);

  it("emits identical create/show/list output, including optional fields and section order", async () => {
    await same(addCommand, [
      "older",
      "SHIP investigate",
      "--body",
      "First line\n\nLast line",
    ]);
    await same(addCommand, [
      "newer",
      "Deliver",
      "--kind",
      "ship",
      "--repo",
      "example",
      "--priority",
      "1",
    ]);
    await same(addCommand, ["active", "In progress", "--start"]);
    await same(addCommand, ["active-next", "Next in progress", "--start"]);
    await same(showCommand, ["older", "--full"]);
    await same(listCommand, [
      "--fields",
      "body,created,closed,priority,deps,held",
    ]);
  }, 30_000);
});
