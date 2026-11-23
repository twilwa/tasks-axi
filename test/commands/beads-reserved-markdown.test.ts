import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { BeadsStore } from "../../src/backends/beads.js";
import { hasBr } from "../beads-helpers.js";

// With a beads store configured, no Markdown write target or archive may
// resolve to a path that store owns (its database, sidecars, locks, ready
// marker or note archive), whether or not that file exists yet. Without beads
// configuration the same names are ordinary Markdown files, as on main.
const SEED =
  "# Backlog\n\n## In flight\n\n## Queued\n\n- [ ] root - Root\n\n## Done\n";

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      const stat = statSync(path, { throwIfNoEntry: false });
      if (!stat) out[path] = "dangling";
      else if (stat.isDirectory()) {
        out[path] = "dir";
        walk(path);
      } else
        out[path] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
    }
  };
  walk(dir);
  return out;
}

function cli(args: string[], cwd: string) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
      fileURLToPath(new URL("../../bin/tasks-axi.ts", import.meta.url)),
      ...args,
    ],
    {
      cwd,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("TASKS_AXI_"),
          ),
        ),
        HOME: cwd,
        USERPROFILE: cwd,
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

type Case = {
  name: string;
  markdown?: string;
  args: string[];
  symlink?: [string, string];
};
const CASES: Case[] = [
  {
    name: "[markdown] path on the beads lock",
    markdown: 'path = ".beads/beads.db.lock"',
    args: ["add", "x", "X"],
  },
  {
    name: "[markdown] path on the database (its lock is the beads lock)",
    markdown: 'path = ".beads/beads.db"',
    args: ["add", "x", "X"],
  },
  {
    name: "[markdown] archive on the beads lock",
    markdown: 'path = "backlog.md"\narchive = ".beads/beads.db.lock"',
    args: ["add", "x", "X"],
  },
  {
    name: "[markdown] archive on the ready marker",
    markdown:
      'path = "backlog.md"\narchive = ".beads/beads.db.tasks-axi-ready"',
    args: ["done", "root"],
  },
  {
    name: "--file on the ready marker",
    args: ["add", "x", "X", "--file", ".beads/beads.db.tasks-axi-ready"],
  },
  {
    name: "--file on the init lock",
    args: ["add", "x", "X", "--file", ".beads/beads.db.init.lock"],
  },
  {
    name: "--file through a symlink to the beads lock",
    args: ["add", "x", "X", "--file", "alias.md"],
    symlink: ["alias.md", ".beads/beads.db.lock"],
  },
  {
    name: "mv destination on the beads lock",
    markdown: 'path = "backlog.md"',
    args: ["mv", "root", "--to", ".beads/beads.db.lock"],
  },
  {
    name: "mv destination on the ready marker",
    markdown: 'path = "backlog.md"',
    args: ["mv", "root", "--to", ".beads/beads.db.tasks-axi-ready"],
  },
];

function workspace(beads: boolean, c: Case) {
  const dir = mkdtempSync(join(tmpdir(), "tasks-axi-mixed-"));
  writeFileSync(
    join(dir, ".tasks.toml"),
    (beads ? '[beads]\npath = ".beads"\n' : "") +
      (c.markdown ? `[markdown]\n${c.markdown}\n` : ""),
  );
  writeFileSync(join(dir, "backlog.md"), SEED);
  if (c.symlink) {
    mkdirSync(join(dir, ".beads"), { recursive: true });
    symlinkSync(join(dir, c.symlink[1]), join(dir, c.symlink[0]));
  }
  return dir;
}

describe("markdown targets cannot name a configured beads store's paths", () => {
  it.each(CASES)(
    "refuses $name, before the lock exists",
    (c) => {
      const dir = workspace(true, c);
      try {
        const before = snapshot(dir);
        const result = cli(c.args, dir);
        const output = result.stdout + result.stderr;
        expect(result.status, output).not.toBe(0);
        expect(output).toContain("reserved by the configured beads store");
        expect(snapshot(dir)).toEqual(before);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it.skipIf(!hasBr)(
    "refuses a markdown write onto a live beads lock and leaves it intact",
    async () => {
      const c = CASES[0]!;
      const dir = workspace(true, c);
      try {
        const store = new BeadsStore({ path: join(dir, ".beads", "beads.db") });
        await store.create({ id: "b", title: "B" });
        const lock = join(dir, ".beads", "beads.db.lock");
        expect(existsSync(lock)).toBe(true);
        const before = snapshot(dir);
        const result = cli(c.args, dir);
        expect(result.status).not.toBe(0);
        expect(result.stdout + result.stderr).toContain(
          "reserved by the configured beads store",
        );
        expect(snapshot(dir)).toEqual(before);
        expect((await store.list({})).items.map((t) => t.id)).toEqual(["b"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it.each(CASES.filter((c) => !c.symlink))(
    "without beads configured, $name is an ordinary markdown file, as on main",
    (c) => {
      const dir = workspace(false, c);
      try {
        const result = cli(c.args, dir);
        expect(result.status, result.stdout + result.stderr).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
