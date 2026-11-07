import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { resolveTasksContext } from "../src/context.js";
import { listCommand, showCommand } from "../src/commands/crud.js";
import { readyCommand } from "../src/commands/state.js";
import { hasBr, makeBeadsWorkspace, recordBr } from "./beads-helpers.js";
import { MarkdownStore } from "../src/backends/markdown.js";
import { BeadsStore } from "../src/backends/beads.js";

const source = readFileSync(
  new URL("./fixtures/migration-backlog.md", import.meta.url),
  "utf8",
);
const archive = readFileSync(
  new URL("./fixtures/migration-archive.md", import.meta.url),
  "utf8",
);
const savedCwd = process.cwd();
let ws: ReturnType<typeof makeBeadsWorkspace>;

async function cli(...argv: string[]) {
  let output = "";
  process.exitCode = undefined;
  await main({
    argv,
    stdout: { write: (chunk: string) => void (output += chunk) },
  });
  return output;
}

describe.skipIf(!hasBr)("markdown to beads migration", () => {
  beforeEach(() => {
    ws = makeBeadsWorkspace();
    process.chdir(ws.dir);
    vi.stubEnv("HOME", ws.dir);
    vi.stubEnv("USERPROFILE", ws.dir);
    vi.stubEnv("TASKS_AXI_BEADS_BINARY", "br");
    vi.stubEnv("TASKS_AXI_FILE", "");
    delete process.env.TASKS_AXI_FILE;
    vi.stubEnv("TASKS_AXI_BACKEND", "markdown");
    vi.stubEnv("TASKS_AXI_BEADS_PATH", ws.path);
    writeFileSync(join(ws.dir, "backlog.md"), source);
    writeFileSync(join(ws.dir, "done-archive.md"), archive);
    writeFileSync(
      join(ws.dir, ".tasks.toml"),
      '[markdown]\npath = "backlog.md"\narchive = "done-archive.md"\n[beads]\npath = ".beads/beads.db"\n',
    );
  });
  afterEach(() => {
    process.chdir(savedCwd);
    vi.unstubAllEnvs();
    process.exitCode = undefined;
    ws.cleanup();
  });

  it("imports backlog and Done archive without changing either source, preserving public reads and mirrors", async () => {
    const configPath = join(ws.dir, ".tasks.toml");
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8") + '\nmirror = "mirror/backlog.md"\n',
    );
    const output = await cli("migrate", "--from", "markdown", "--to", "beads");
    expect(process.exitCode, output).toBeFalsy();
    expect(decode(output)).toMatchObject({
      ok: "migrate markdown -> beads (8 tasks)",
      counts: { in_flight: 2, queued: 3, done: 3 },
      created: 8,
      existing: 0,
    });
    const markdown = resolveTasksContext({ backend: "markdown" });
    const beads = resolveTasksContext({ backend: "beads" });
    expect(await listCommand(["--state", "queued"], beads)).toBe(
      await listCommand(["--state", "queued"], markdown),
    );
    expect(await readyCommand(["--include-held"], beads)).toBe(
      await readyCommand(["--include-held"], markdown),
    );
    for (const id of [
      "build-a1",
      "inspect-a2",
      "held-q1",
      "blocked-q2",
      "ready-q3",
      "latest-d1",
    ]) {
      expect(await showCommand([id, "--full"], beads)).toBe(
        await showCommand([id, "--full"], markdown),
      );
    }
    const expected = [
      ...(await markdown.store.list({})).items,
      ...(
        await new MarkdownStore({
          path: join(ws.dir, "done-archive.md"),
          archived: true,
        }).list({})
      ).items,
    ];
    expect((await beads.store.list({})).items).toEqual(expected);
    expect(
      (
        await new MarkdownStore({
          path: join(ws.dir, "mirror/backlog.md"),
        }).list({})
      ).items,
    ).toEqual(expected);
    expect(await beads.store.get("old-d2")).toMatchObject({
      id: "old-d2",
      state: "done",
      kind: "scout",
      repo: "example",
      closed: "2026-01-30",
      body: "Old notes.",
    });
    expect((await beads.store.list({})).items.map((task) => task.id)).toEqual([
      "build-a1",
      "inspect-a2",
      "held-q1",
      "blocked-q2",
      "ready-q3",
      "latest-d1",
      "old-d2",
      "oldest-d3",
    ]);
    expect(readFileSync(join(ws.dir, "backlog.md"), "utf8")).toBe(source);
    expect(readFileSync(join(ws.dir, "done-archive.md"), "utf8")).toBe(archive);
  }, 30_000);

  it.each(["backlog.md", "done-archive.md", "default archive"])(
    "refuses a mirror that would overwrite migration source: %s",
    async (collision) => {
      const configPath = join(ws.dir, ".tasks.toml");
      writeFileSync(
        configPath,
        readFileSync(configPath, "utf8") +
          (collision === "default archive"
            ? '\nmirror = "projection.md"\n'
            : `\nmirror = "${collision}"\nmirror_archive = "projection-archive.md"\n`),
      );
      const output = await cli(
        "migrate",
        "--from",
        "markdown",
        "--to",
        "beads",
      );
      expect(process.exitCode, output).toBe(2);
      expect(output).toContain("source");
      expect(readFileSync(join(ws.dir, "backlog.md"), "utf8")).toBe(source);
      expect(readFileSync(join(ws.dir, "done-archive.md"), "utf8")).toBe(
        archive,
      );
      expect(
        (await resolveTasksContext({ backend: "beads" }).store.list({})).total,
      ).toBe(0);
    },
    30_000,
  );

  it("rejects mirror aliases of source files before importing", async () => {
    symlinkSync(ws.dir, join(ws.dir, "source-alias"), "junction");
    const configPath = join(ws.dir, ".tasks.toml");
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8") +
        '\nmirror = "source-alias/backlog.md"\n',
    );
    expect(
      await cli("migrate", "--from", "markdown", "--to", "beads"),
    ).toContain("must not overwrite a source markdown file");
    expect(
      (await resolveTasksContext({ backend: "beads" }).store.list({})).total,
    ).toBe(0);
    expect(readFileSync(join(ws.dir, "backlog.md"), "utf8")).toBe(source);
    expect(readFileSync(join(ws.dir, "done-archive.md"), "utf8")).toBe(archive);
  }, 30_000);

  it("preserves absent dates and honors explicit source/destination overrides", async () => {
    const selectedSource = join(ws.dir, "selected.md");
    const selectedDatabase = join(ws.dir, "selected/beads.db");
    writeFileSync(
      selectedSource,
      "## In flight\n- [ ] active-a1 - Active without date\n## Queued\n- [ ] queued-q1 - Queued without date\n",
    );
    writeFileSync(
      join(ws.dir, "done-archive.md"),
      "## Archived 2025-01-01\n- [x] undated-d1 - Done without date\n",
    );
    const expected = [
      ...(await new MarkdownStore({ path: selectedSource }).list({})).items,
      ...(
        await new MarkdownStore({
          path: join(ws.dir, "done-archive.md"),
          archived: true,
        }).list({})
      ).items,
    ];
    const output = await cli(
      "migrate",
      "--from",
      "markdown",
      "--to",
      "beads",
      "--from-file",
      selectedSource,
      "--to-file",
      selectedDatabase,
      "--json",
    );
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      created: 3,
      counts: { in_flight: 1, queued: 1, done: 1 },
    });
    expect(
      (await new BeadsStore({ path: selectedDatabase }).list({})).items,
    ).toEqual(expected);
    expect((await new BeadsStore({ path: ws.path }).list({})).total).toBe(0);
    expect(readFileSync(join(ws.dir, "backlog.md"), "utf8")).toBe(source);
  }, 30_000);

  it("preflights every source record before writing any destination tasks", async () => {
    writeFileSync(
      join(ws.dir, "backlog.md"),
      "## Queued\n- [ ] valid-q1 - Valid task\n- [ ] invalid-q2 - Invalid for beads (repo: alpha,beta)\n",
    );
    writeFileSync(join(ws.dir, "done-archive.md"), "");
    const output = await cli("migrate", "--from", "markdown", "--to", "beads");
    expect(process.exitCode, output).toBe(2);
    expect(
      (await resolveTasksContext({ backend: "beads" }).store.list({})).total,
    ).toBe(0);
  }, 30_000);

  it.each([
    [
      "duplicate",
      "- [ ] first-q1 - First\n- [ ] first-q1 - Duplicate",
      "Duplicate source id",
    ],
    [
      "dangling",
      "- [ ] first-q1 - First blocked-by: absent-q2",
      "Invalid source dependency",
    ],
    [
      "self",
      "- [ ] first-q1 - First blocked-by: first-q1",
      "Invalid source dependency",
    ],
    [
      "pair",
      "- [ ] first-q1 - First blocked-by: second-q2 parent: second-q2\n- [ ] second-q2 - Second",
      "one dependency per task pair",
    ],
    [
      "cycle",
      "- [ ] first-q1 - First blocked-by: second-q2\n- [ ] second-q2 - Second blocked-by: first-q1",
      "dependency cycle",
    ],
  ])(
    "refuses invalid source graph (%s) before writing",
    async (_name, entries, message) => {
      writeFileSync(join(ws.dir, "backlog.md"), `## Queued\n${entries}\n`);
      writeFileSync(join(ws.dir, "done-archive.md"), "");
      const output = await cli(
        "migrate",
        "--from",
        "markdown",
        "--to",
        "beads",
      );
      expect(output).toContain(message);
      expect(process.exitCode).toBeTruthy();
      expect(
        (await resolveTasksContext({ backend: "beads" }).store.list({})).total,
      ).toBe(0);
    },
    30_000,
  );

  it("refuses conflicting existing fields before importing earlier source rows", async () => {
    const destination = resolveTasksContext({ backend: "beads" }).store;
    await destination.create({
      id: "oldest-d3",
      title: "different content",
      state: "done",
      created: null,
      closed: "2025-12-01",
    });
    const before = (await destination.list({})).items;
    const output = await cli(
      "migrate",
      "--from",
      "markdown",
      "--to",
      "beads",
      "--allow-existing",
    );
    expect(decode(output)).toMatchObject({
      error:
        'Destination task "oldest-d3" conflicts with the source; no tasks were imported',
      code: "CONFLICT",
    });
    expect((await destination.list({})).items).toEqual(before);
  }, 30_000);

  it("refuses conflicting dependency reasons without modifying existing rows", async () => {
    writeFileSync(
      join(ws.dir, "backlog.md"),
      "## Queued\n- [ ] first-q1 - First blocked-by: second-q2 - original reason\n- [ ] second-q2 - Second\n",
    );
    writeFileSync(join(ws.dir, "done-archive.md"), "");
    const destination = resolveTasksContext({ backend: "beads" }).store;
    for (const task of (
      await resolveTasksContext({ backend: "markdown" }).store.list({})
    ).items)
      await destination.create({ ...task, created: null, deps: [] });
    await destination.addDep("first-q1", {
      type: "blocked-by",
      id: "second-q2",
      reason: "different reason",
    });
    const before = (await destination.list({})).items;
    expect(
      decode(
        await cli(
          "migrate",
          "--from",
          "markdown",
          "--to",
          "beads",
          "--allow-existing",
        ),
      ),
    ).toMatchObject({ code: "CONFLICT" });
    expect((await destination.list({})).items).toEqual(before);
  }, 30_000);

  it("refuses an existing import order that cannot converge without reordering", async () => {
    writeFileSync(
      join(ws.dir, "backlog.md"),
      "## Queued\n- [ ] first-q1 - First\n- [ ] second-q2 - Second\n",
    );
    writeFileSync(join(ws.dir, "done-archive.md"), "");
    const destination = resolveTasksContext({ backend: "beads" }).store;
    await destination.create({
      id: "second-q2",
      title: "Second",
      created: null,
    });
    const output = await cli(
      "migrate",
      "--from",
      "markdown",
      "--to",
      "beads",
      "--allow-existing",
    );
    expect(output).toContain("Destination task order conflicts");
    expect((await destination.list({})).items.map((task) => task.id)).toEqual([
      "second-q2",
    ]);
  }, 30_000);

  it("refreshes opted-in mirrors when every task already exists and there are no dependencies", async () => {
    writeFileSync(
      join(ws.dir, "backlog.md"),
      "## Queued\n- [ ] first-q1 - First\n",
    );
    writeFileSync(join(ws.dir, "done-archive.md"), "");
    const configPath = join(ws.dir, ".tasks.toml");
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8") + '\nmirror = "mirror/backlog.md"\n',
    );
    const destination = resolveTasksContext({ backend: "beads" }).store;
    // Seed through the same public Store without enabling its output projection.
    await new BeadsStore({ path: ws.path }).create({
      id: "first-q1",
      title: "First",
      created: null,
    });
    const output = await cli(
      "migrate",
      "--from",
      "markdown",
      "--to",
      "beads",
      "--allow-existing",
      "--json",
    );
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      already: true,
      created: 0,
      existing: 1,
    });
    expect(
      await new MarkdownStore({ path: join(ws.dir, "mirror/backlog.md") }).get(
        "first-q1",
      ),
    ).toEqual(await destination.get("first-q1"));
  }, 30_000);

  it("refuses a destination containing unmanaged native tasks without permission", async () => {
    ws.br(["create", "--title", "native task"]);
    const output = await cli("migrate", "--from", "markdown", "--to", "beads");
    expect(output).toContain("destination is not empty");
    expect(
      (await resolveTasksContext({ backend: "beads" }).store.list({})).total,
    ).toBe(0);
  }, 30_000);

  it.each(["create", "dep"])(
    "recovers an interrupted %s without duplicates, and requires explicit existing-destination permission",
    async (boundary) => {
      const configPath = join(ws.dir, ".tasks.toml");
      writeFileSync(
        configPath,
        readFileSync(configPath, "utf8") + '\nmirror = "mirror/backlog.md"\n',
      );
      const marker = join(ws.dir, "interrupted");
      const recorder = recordBr(ws.dir, ws.path, {
        after: `if (args[2] === ${JSON.stringify(boundary)} && !fs.existsSync(${JSON.stringify(marker)})) {
        fs.writeFileSync(${JSON.stringify(marker)}, 'once'); process.exit(1);
      }`,
      });
      vi.stubEnv("TASKS_AXI_BEADS_BINARY", recorder.binary);
      await cli("migrate", "--from", "markdown", "--to", "beads");
      expect(process.exitCode).toBe(1);
      const incomplete = resolveTasksContext({ backend: "beads" });
      const before = (await incomplete.store.list({})).items;
      expect(before.length).toBeGreaterThan(0);
      const refused = await cli(
        "migrate",
        "--from",
        "markdown",
        "--to",
        "beads",
      );
      expect(refused).toContain("destination is not empty");
      expect((await incomplete.store.list({})).items).toEqual(before);

      const output = await cli(
        "migrate",
        "--from",
        "markdown",
        "--to",
        "beads",
        "--allow-existing",
        "--json",
      );
      expect(process.exitCode, output).toBeFalsy();
      expect(JSON.parse(output)).toMatchObject({
        ok: true,
        counts: { in_flight: 2, queued: 3, done: 3 },
      });
      expect(
        (await incomplete.store.list({})).items.map((task) => task.id),
      ).toEqual([
        "build-a1",
        "inspect-a2",
        "held-q1",
        "blocked-q2",
        "ready-q3",
        "latest-d1",
        "old-d2",
        "oldest-d3",
      ]);
      expect((await incomplete.store.get("blocked-q2"))?.deps).toEqual([
        {
          type: "blocked-by",
          id: "build-a1",
          reason: "needs the adapter first",
        },
      ]);
      expect((await incomplete.store.get("ready-q3"))?.deps).toEqual([
        {
          type: "parent",
          id: "inspect-a2",
          reason: "tracks the investigation",
        },
        {
          type: "discovered-from",
          id: "old-d2",
          reason: "followup from the prior release",
        },
      ]);
      const again = JSON.parse(
        await cli(
          "migrate",
          "--from",
          "markdown",
          "--to",
          "beads",
          "--allow-existing",
          "--json",
        ),
      );
      expect(again).toMatchObject({
        ok: true,
        already: true,
        created: 0,
        existing: 8,
      });
      expect(
        (
          await new MarkdownStore({
            path: join(ws.dir, "mirror/backlog.md"),
          }).list({})
        ).items,
      ).toEqual((await incomplete.store.list({})).items);
      expect(readFileSync(join(ws.dir, "backlog.md"), "utf8")).toBe(source);
      expect(readFileSync(join(ws.dir, "done-archive.md"), "utf8")).toBe(
        archive,
      );
    },
    30_000,
  );
});
