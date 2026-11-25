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
      'backend = "beads"\n[beads]\npath = ".beads/beads.db"\nbinary = "bd"\nprefix = "work"\n',
    );
    expect(resolveConfig({ cwd: dir, home, env: {} })).toMatchObject({
      backend: "beads",
      path: join(dir, ".beads/beads.db"),
      beadsBinary: "bd",
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

  it.each(["./bin/br", "/bin/sh", "node", "../br"])(
    "rejects untrusted project executable %j but permits trusted overrides",
    (binary) => {
      writeFileSync(
        join(dir, ".tasks.toml"),
        `backend = "beads"\n[beads]\npath = "selected.db"\nbinary = "${binary}"\n`,
      );
      expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(
        /project.*beads.binary.*br or bd/,
      );
      expect(
        resolveConfig({
          cwd: dir,
          home,
          env: { TASKS_AXI_BEADS_BINARY: "./trusted-br" },
        }).beadsBinary,
      ).toBe(join(dir, "trusted-br"));
      writeFileSync(join(dir, ".tasks.toml"), 'backend = "beads"\n');
      writeFileSync(
        join(home, ".tasks-axi", "config.toml"),
        '[beads]\npath = "selected.db"\nbinary = "./trusted-home-br"\n',
      );
      expect(resolveConfig({ cwd: dir, home, env: {} }).beadsBinary).toBe(
        join(dir, "trusted-home-br"),
      );
    },
  );

  it("configures a bounded br timeout from TOML or environment", () => {
    writeFileSync(
      join(dir, ".tasks.toml"),
      'backend = "beads"\n[beads]\npath = "selected.db"\ntimeout_ms = 750\n',
    );
    expect(resolveConfig({ cwd: dir, home, env: {} }).beadsTimeoutMs).toBe(750);
    expect(
      resolveConfig({
        cwd: dir,
        home,
        env: { TASKS_AXI_BEADS_TIMEOUT_MS: "500" },
      }).beadsTimeoutMs,
    ).toBe(500);
    for (const value of ["", "0", "-1", "1.5", "not-a-number", "2147483648"])
      expect(() =>
        resolveConfig({
          cwd: dir,
          home,
          env: { TASKS_AXI_BEADS_TIMEOUT_MS: value },
        }),
      ).toThrow(/beads.timeout_ms/);
  });

  it("configures a bounded beads lock wait from TOML or environment", () => {
    writeFileSync(
      join(dir, ".tasks.toml"),
      'backend = "beads"\n[beads]\npath = "selected.db"\nlock_timeout_ms = 9000\n',
    );
    expect(resolveConfig({ cwd: dir, home, env: {} }).beadsLockTimeoutMs).toBe(
      9000,
    );
    expect(
      resolveConfig({
        cwd: dir,
        home,
        env: { TASKS_AXI_BEADS_LOCK_TIMEOUT_MS: "4000" },
      }).beadsLockTimeoutMs,
    ).toBe(4000);
    for (const value of ["", "0", "-1", "1.5", "soon", "2147483648"])
      expect(() =>
        resolveConfig({
          cwd: dir,
          home,
          env: { TASKS_AXI_BEADS_LOCK_TIMEOUT_MS: value },
        }),
      ).toThrow(/beads.lock_timeout_ms/);
  });

  it("ignores a leftover beads lock_timeout_ms in a markdown-only workspace, as main does", () => {
    for (const value of ['"disabled"', "disabled", "0", "1.5"]) {
      writeFileSync(
        join(dir, ".tasks.toml"),
        `[beads]\nlock_timeout_ms = ${value}\n[markdown]\npath = "backlog.md"\n`,
      );
      const config = resolveConfig({ cwd: dir, home, env: {} });
      expect(config).toMatchObject({
        backend: "markdown",
        path: join(dir, "backlog.md"),
      });
      expect(config.beadsLockTimeoutMs).toBeUndefined();
    }
  });

  it("still validates beads lock_timeout_ms when beads is selected", () => {
    for (const value of ['"disabled"', "disabled", "0", "1.5", "2147483648"]) {
      writeFileSync(
        join(dir, ".tasks.toml"),
        `backend = "beads"\n[beads]\npath = "selected.db"\nlock_timeout_ms = ${value}\n`,
      );
      expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(
        /beads.lock_timeout_ms/,
      );
    }
  });

  it("resolves opt-in mirror paths with project-over-home precedence and shared Done retention", () => {
    writeFileSync(
      join(home, ".tasks-axi", "config.toml"),
      '[beads]\nmirror = "home-mirror/backlog.md"\nmirror_archive = "home-mirror/archive.md"\n',
    );
    writeFileSync(
      join(dir, ".tasks.toml"),
      'backend = "beads"\n[markdown]\ndone_keep = 0\n[beads]\npath = "selected.db"\nmirror = "project-mirror/backlog.md"\n',
    );
    expect(resolveConfig({ cwd: dir, home, env: {} })).toMatchObject({
      doneKeep: 0,
      beadsMirrorPath: join(dir, "project-mirror/backlog.md"),
      beadsMirrorArchivePath: join(dir, "home-mirror/archive.md"),
    });
  });

  it("resolves env mirror paths over project and home TOML, relative to cwd", () => {
    writeFileSync(
      join(home, ".tasks-axi", "config.toml"),
      '[beads]\nmirror = "home-mirror/backlog.md"\nmirror_archive = "home-mirror/archive.md"\n',
    );
    writeFileSync(
      join(dir, ".tasks.toml"),
      'backend = "beads"\n[beads]\npath = "selected.db"\nmirror = "project-mirror/backlog.md"\nmirror_archive = "project-mirror/archive.md"\n',
    );
    expect(
      resolveConfig({
        cwd: dir,
        home,
        env: {
          TASKS_AXI_BEADS_MIRROR: "env-mirror/backlog.md",
          TASKS_AXI_BEADS_MIRROR_ARCHIVE: "env-mirror/archive.md",
        },
      }),
    ).toMatchObject({
      beadsMirrorPath: join(dir, "env-mirror/backlog.md"),
      beadsMirrorArchivePath: join(dir, "env-mirror/archive.md"),
    });
  });

  it.each([
    ["TASKS_AXI_BEADS_MIRROR", ""],
    ["TASKS_AXI_BEADS_MIRROR", "   "],
    ["TASKS_AXI_BEADS_MIRROR_ARCHIVE", ""],
    ["TASKS_AXI_BEADS_MIRROR_ARCHIVE", "   "],
  ])(
    "rejects an empty %s (%j) instead of falling back to TOML",
    (name, value) => {
      writeFileSync(
        join(dir, ".tasks.toml"),
        'backend = "beads"\n[beads]\npath = "selected.db"\nmirror = "m.md"\nmirror_archive = "a.md"\n',
      );
      expect(() =>
        resolveConfig({ cwd: dir, home, env: { [name]: value } }),
      ).toThrow(new RegExp(`${name} must not be empty`));
    },
  );

  it("attaches env mirrors only to the env-configured database, not a --file or mv --to peer", () => {
    const env = {
      TASKS_AXI_BACKEND: "beads",
      TASKS_AXI_BEADS_PATH: ".beads",
      TASKS_AXI_BEADS_MIRROR: "data/backlog.md",
      TASKS_AXI_BEADS_MIRROR_ARCHIVE: "data/done-archive.md",
    };
    expect(resolveConfig({ cwd: dir, home, env })).toMatchObject({
      path: join(dir, ".beads"),
      beadsMirrorPath: join(dir, "data/backlog.md"),
      beadsMirrorArchivePath: join(dir, "data/done-archive.md"),
    });
    expect(
      resolveConfig({ cwd: dir, home, env, file: ".beads/beads.db" }),
    ).toMatchObject({ beadsMirrorPath: join(dir, "data/backlog.md") });
    // mv --to resolves its destination through resolveConfig({ backend, file }).
    const peer = resolveConfig({
      cwd: dir,
      home,
      env,
      backend: "beads",
      file: "peer.db",
    });
    expect(peer.path).toBe(join(dir, "peer.db"));
    expect(peer.beadsMirrorPath).toBeUndefined();
    expect(peer.beadsMirrorArchivePath).toBeUndefined();
  });

  it.each(["mirror", "mirror_archive"])(
    "rejects empty or non-string beads.%s",
    (key) => {
      for (const value of ['""', '"   "', "42"]) {
        writeFileSync(
          join(dir, ".tasks.toml"),
          `backend = "beads"\n[beads]\npath = "selected.db"\n${key} = ${value}\n`,
        );
        expect(() => resolveConfig({ cwd: dir, home, env: {} })).toThrow(
          new RegExp(`beads.${key}`),
        );
      }
    },
  );

  it("requires an explicit database instead of discovering a parent workspace", () => {
    expect(() =>
      resolveConfig({ cwd: dir, home, env: {}, backend: "beads" }),
    ).toThrow(/beads.path.*required/);
  });
});
