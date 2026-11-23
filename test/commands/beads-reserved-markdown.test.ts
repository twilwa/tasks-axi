import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
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
      if (lstatSync(path).isSymbolicLink()) {
        out[path] = "link:" + readlinkSync(path);
        continue;
      }
      const stat = statSync(path);
      if (stat.isDirectory()) {
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
  /** [markdown] lines; {dir} is the workspace's absolute path. */
  markdown?: string;
  args: string[];
  symlink?: [string, string];
  /** [beads] path (default ".beads"). */
  beads?: string;
  /** Static fixtures: directories, files, and links (name, target as written). */
  dirs?: string[];
  files?: [string, string][];
  links?: [string, string][];
  /** Mixed-config only: no Markdown-only control. */
  noControl?: boolean;
};
const CASES: Case[] = [
  {
    name: "[markdown] archive on the beads note-archive lock",
    markdown: 'path = "backlog.md"\narchive = ".beads/note-archive.md.lock"',
    args: ["add", "x", "X"],
  },
  {
    name: "[markdown] archive on a beads lock that is itself a symlink",
    markdown: 'path = "backlog.md"\narchive = ".beads/beads.db.lock"',
    args: ["add", "x", "X"],
    dirs: [".beads", "elsewhere"],
    files: [["elsewhere/real.lock", "tasks-axi-lock/flock-v1\n"]],
    links: [[".beads/beads.db.lock", "../elsewhere/real.lock"]],
    noControl: true,
  },
  {
    name: "[markdown] archive on the file a symlinked beads lock reaches",
    markdown: 'path = "backlog.md"\narchive = "elsewhere/real.lock"',
    args: ["add", "x", "X"],
    dirs: [".beads", "elsewhere"],
    files: [["elsewhere/real.lock", "tasks-axi-lock/flock-v1\n"]],
    links: [[".beads/beads.db.lock", "../elsewhere/real.lock"]],
    noControl: true,
  },
  {
    name: "a backlog beside a symlinked database, sharing its note archive",
    beads: ".beads/alias.db",
    markdown: 'path = ".beads/backlog.md"',
    args: ["add", "x", "X"],
    dirs: [".beads", "real"],
    links: [[".beads/alias.db", "../real/beads.db"]],
    noControl: true,
  },
  {
    name: "a backlog whose own .lock is a symlink to the missing beads lock",
    markdown: 'path = "backlog.md"',
    args: ["add", "x", "X"],
    dirs: [".beads"],
    links: [["backlog.md.lock", ".beads/beads.db.lock"]],
    noControl: true,
  },
  {
    name: "an absolute archive that reaches the beads lock through symlink/..",
    markdown: 'path = "backlog.md"\narchive = "{dir}/link/../beads.db.lock"',
    args: ["add", "x", "X"],
    dirs: [".beads/sub"],
    links: [["link", ".beads/sub"]],
    noControl: true,
  },
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
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tasks-axi-mixed-")));
  writeFileSync(
    join(dir, ".tasks.toml"),
    (beads ? `[beads]\npath = "${c.beads ?? ".beads"}"\n` : "") +
      (c.markdown
        ? `[markdown]\n${c.markdown.replaceAll("{dir}", dir)}\n`
        : ""),
  );
  writeFileSync(join(dir, "backlog.md"), SEED);
  for (const sub of c.dirs ?? [])
    mkdirSync(join(dir, sub), { recursive: true });
  for (const [name, content] of c.files ?? [])
    writeFileSync(join(dir, name), content);
  for (const [name, target] of c.links ?? [])
    symlinkSync(target, join(dir, name));
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
      const c = CASES.find(
        (item) => item.name === "[markdown] path on the beads lock",
      )!;
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

  it("does not refuse a backlog symlink outside the beads directory", () => {
    // The Markdown writer replaces outside.md and locks outside.md.lock; it
    // never touches the missing <db>.init the link names.
    const c: Case = {
      name: "outside link",
      args: ["add", "x", "X", "--file", "outside.md"],
      dirs: [".beads"],
      links: [["outside.md", ".beads/beads.db.init"]],
    };
    const dir = workspace(true, c);
    try {
      const result = cli(c.args, dir);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(existsSync(join(dir, ".beads", "beads.db.init"))).toBe(false);
      expect(readFileSync(join(dir, "outside.md"), "utf8")).toContain("x - X");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(CASES.filter((c) => !c.symlink && !c.noControl))(
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
