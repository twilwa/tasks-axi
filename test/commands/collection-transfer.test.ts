import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { BeadsStore } from "../../src/backends/beads.js";
import { mvCommand } from "../../src/commands/state.js";
import type { TasksContext } from "../../src/context.js";
import { hasBr, makeBeadsWorkspace, recordBr } from "../beads-helpers.js";
import { makeBacklog } from "../helpers.js";

function runMarkdownMove(
  source: string,
  target: string,
  home: string,
  env: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
      fileURLToPath(new URL("../../bin/tasks-axi.ts", import.meta.url)),
      "mv",
      "root",
      "--backend",
      "markdown",
      "--file",
      source,
      "--to",
      target,
      "--to-backend",
      "beads",
      "--json",
    ],
    {
      cwd: dirname(source),
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("TASKS_AXI_"),
          ),
        ),
        HOME: home,
        USERPROFILE: home,
        ...env,
      },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
}

describe.skipIf(!hasBr)("mv between markdown and beads collections", () => {
  it.each(["environment", "home"])(
    "resolves a markdown move's destination binary, prefix and timeout from %s settings",
    async (layer) => {
      const markdown = makeBacklog("# Backlog\n");
      const target = join(markdown.dir, "destination", ".beads", "beads.db");
      const home = join(markdown.dir, "home");
      const stall = join(markdown.dir, "stall-once");
      const recorder = recordBr(markdown.dir, target, {
        before: `if (args[2] === 'list' && fs.existsSync(${JSON.stringify(stall)})) { fs.unlinkSync(${JSON.stringify(stall)}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000); }`,
      });
      mkdirSync(join(home, ".tasks-axi"), { recursive: true });
      writeFileSync(
        join(home, ".tasks-axi", "config.toml"),
        layer === "home"
          ? `[beads]\nbinary = "${recorder.binary}"\nprefix = "home"\ntimeout_ms = 750\n`
          : '[beads]\nbinary = "missing-home-br"\nprefix = "home"\ntimeout_ms = 5000\n',
      );
      writeFileSync(
        join(markdown.dir, ".tasks.toml"),
        layer === "environment"
          ? 'backend = "markdown"\n[beads]\nbinary = "bd"\nprefix = "project"\ntimeout_ms = 5000\n'
          : 'backend = "markdown"\n',
      );
      const env: NodeJS.ProcessEnv =
        layer === "environment"
          ? {
              TASKS_AXI_BEADS_BINARY: recorder.binary,
              TASKS_AXI_BEADS_PREFIX: "env",
              TASKS_AXI_BEADS_TIMEOUT_MS: "750",
            }
          : {};
      const unusedPath = join(markdown.dir, "not-the-destination.db");
      env.TASKS_AXI_BEADS_PATH = unusedPath;
      const prefix = layer === "environment" ? "env" : "home";
      try {
        await markdown.store.create({ id: "root", title: "Root" });
        const before = markdown.read();
        writeFileSync(stall, "");
        const timedOut = runMarkdownMove(markdown.path, target, home, env);
        expect(timedOut.error).toBeUndefined();
        expect(timedOut.status).toBe(1);
        expect(timedOut.stdout + timedOut.stderr).toContain(
          "br timed out after 750ms",
        );
        expect(markdown.read()).toBe(before);
        expect((await new BeadsStore({ path: target }).list({})).total).toBe(0);
        expect(readFileSync(recorder.log, "utf8")).toContain(
          JSON.stringify([
            "--db",
            target,
            "init",
            "--prefix",
            prefix,
            "--json",
          ]),
        );
        const retry = runMarkdownMove(markdown.path, target, home, {
          ...env,
          TASKS_AXI_BEADS_TIMEOUT_MS: "5000",
        });
        expect(retry.error).toBeUndefined();
        expect(retry.status).toBe(0);
        expect(JSON.parse(retry.stdout)).toMatchObject({
          ok: true,
          action: "mv",
          id: "root",
          to: target,
        });
        expect(
          await new BeadsStore({ path: target }).get("root"),
        ).toMatchObject({
          title: "Root",
        });
        expect(await markdown.store.get("root")).toBeNull();
        expect(existsSync(unusedPath)).toBe(false);
      } finally {
        markdown.cleanup();
      }
    },
    30_000,
  );

  it("loads project destination prefix and validates its timeout before writes", async () => {
    const markdown = makeBacklog("# Backlog\n");
    const target = join(markdown.dir, "destination", ".beads", "beads.db");
    const home = join(markdown.dir, "home");
    mkdirSync(join(home, ".tasks-axi"), { recursive: true });
    writeFileSync(
      join(home, ".tasks-axi", "config.toml"),
      '[beads]\nbinary = "missing-home-br"\nprefix = "home"\ntimeout_ms = 5000\n',
    );
    const projectConfig = (timeout: number) =>
      `backend = "markdown"\n[beads]\nbinary = "br"\nprefix = "project"\ntimeout_ms = ${timeout}\n`;
    try {
      await markdown.store.create({ id: "root", title: "Root" });
      const before = markdown.read();
      writeFileSync(join(markdown.dir, ".tasks.toml"), projectConfig(0));
      const invalid = runMarkdownMove(markdown.path, target, home);
      expect(invalid.error).toBeUndefined();
      expect(invalid.status).toBe(2);
      expect(invalid.stdout + invalid.stderr).toContain(
        "beads.timeout_ms must be an integer",
      );
      expect(markdown.read()).toBe(before);
      expect(existsSync(target)).toBe(false);
      writeFileSync(join(markdown.dir, ".tasks.toml"), projectConfig(5000));
      const moved = runMarkdownMove(markdown.path, target, home);
      expect(moved.error).toBeUndefined();
      expect(moved.status).toBe(0);
      expect(JSON.parse(moved.stdout)).toMatchObject({
        ok: true,
        action: "mv",
        id: "root",
      });
      const native = spawnSync(
        "br",
        ["--db", target, "list", "--all", "--limit", "0", "--json"],
        { encoding: "utf8", timeout: 5000 },
      );
      expect(native.error).toBeUndefined();
      expect(native.status).toBe(0);
      expect(JSON.parse(native.stdout).issues).toEqual([
        expect.objectContaining({
          id: expect.stringMatching(/^project-/),
          external_ref: "tasks-axi:root",
        }),
      ]);
      expect(await markdown.store.get("root")).toBeNull();
    } finally {
      markdown.cleanup();
    }
  }, 30_000);

  it("refuses a project-configured custom destination executable without invoking it", async () => {
    const markdown = makeBacklog("# Backlog\n");
    const target = join(markdown.dir, "destination", ".beads", "beads.db");
    const home = join(markdown.dir, "home");
    const recorder = recordBr(markdown.dir, target);
    mkdirSync(home);
    writeFileSync(
      join(markdown.dir, ".tasks.toml"),
      `backend = "markdown"\n[beads]\nbinary = "${recorder.binary}"\n`,
    );
    try {
      await markdown.store.create({ id: "root", title: "Root" });
      const before = markdown.read();
      const refused = runMarkdownMove(markdown.path, target, home);
      expect(refused.error).toBeUndefined();
      expect(refused.status).toBe(2);
      expect(refused.stdout + refused.stderr).toContain(
        "project beads.binary must be the PATH name br or bd",
      );
      expect(markdown.read()).toBe(before);
      expect(existsSync(target)).toBe(false);
      expect(existsSync(recorder.log)).toBe(false);
    } finally {
      markdown.cleanup();
    }
  }, 30_000);

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
