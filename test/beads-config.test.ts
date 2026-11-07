import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";

let dir: string;
let home: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tasks-axi-beads-config-"));
  home = join(dir, "home");
  mkdirSync(join(home, ".tasks-axi"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("beads database addressing", () => {
  it("resolves project settings over home settings and env over project", () => {
    writeFileSync(
      join(home, ".tasks-axi", "config.toml"),
      'backend = "beads"\n[beads]\npath = "home.db"\nbinary = "home-br"\n',
    );
    writeFileSync(
      join(dir, ".tasks.toml"),
      'backend = "beads"\n[beads]\npath = ".beads/beads.db"\nbinary = "project-br"\nprefix = "work"\n',
    );
    expect(resolveConfig({ cwd: dir, home, env: {} })).toMatchObject({
      backend: "beads",
      path: join(dir, ".beads/beads.db"),
      beadsBinary: "project-br",
      beadsPrefix: "work",
    });
    expect(
      resolveConfig({
        cwd: dir,
        home,
        env: {
          TASKS_AXI_BEADS_PATH: "env.db",
          TASKS_AXI_BEADS_BINARY: "env-br",
          TASKS_AXI_BEADS_PREFIX: "env",
        },
      }),
    ).toMatchObject({
      path: join(dir, "env.db"),
      beadsBinary: "env-br",
      beadsPrefix: "env",
    });
    expect(
      resolveConfig({
        cwd: dir,
        home,
        backend: "beads",
        file: "flag.db",
        env: {
          TASKS_AXI_FILE: "file.db",
          TASKS_AXI_BEADS_PATH: "env.db",
        },
      }),
    ).toMatchObject({ path: join(dir, "flag.db") });
  });
  it.each(["", "   "])(
    "rejects empty beads paths and binary settings (%j)",
    (value) => {
      expect(() =>
        resolveConfig({
          cwd: dir,
          home,
          env: {
            TASKS_AXI_BACKEND: "beads",
            TASKS_AXI_BEADS_PATH: value,
          },
        }),
      ).toThrow(/TASKS_AXI_BEADS_PATH/);
      expect(() =>
        resolveConfig({
          cwd: dir,
          home,
          file: "explicit.db",
          env: {
            TASKS_AXI_BACKEND: "beads",
            TASKS_AXI_BEADS_BINARY: value,
          },
        }),
      ).toThrow(/beads.binary/);
    },
  );

  it("defaults to br, supports the generic file env and ignores markdown path", () => {
    writeFileSync(
      join(dir, ".tasks.toml"),
      '[markdown]\npath = "backlog.md"\n',
    );
    const config = resolveConfig({
      cwd: dir,
      home,
      env: {
        TASKS_AXI_BACKEND: "beads",
        TASKS_AXI_FILE: "selected.db",
      },
    });
    expect(config).toMatchObject({
      backend: "beads",
      path: join(dir, "selected.db"),
      beadsBinary: "br",
    });
    expect(() =>
      resolveConfig({ cwd: dir, home, env: { TASKS_AXI_BACKEND: "beads" } }),
    ).toThrow(/beads.path.*required/);
  });

  it("resolves relative binary paths from the config cwd, keeping bare names on PATH", () => {
    expect(
      resolveConfig({
        cwd: dir,
        home,
        file: "selected.db",
        backend: "beads",
        env: {
          TASKS_AXI_BEADS_BINARY: "./tools/br",
        },
      }).beadsBinary,
    ).toBe(join(dir, "tools", "br"));
  });

  it("requires an explicit database instead of discovering a parent workspace", () => {
    expect(() =>
      resolveConfig({ cwd: dir, home, env: {}, backend: "beads" }),
    ).toThrow(/beads.path.*required/);
  });
});
