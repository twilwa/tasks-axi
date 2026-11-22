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
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { BeadsStore } from "../../src/backends/beads.js";
import { MarkdownStore } from "../../src/backends/markdown.js";
import { hasBr, makeBeadsWorkspace } from "../beads-helpers.js";

// Cross-store moves are refused before any lock, read or write: no br call,
// no lockfile, and every byte of both stores unchanged.
const SEED =
  "# Backlog\n\n## In flight\n\n## Queued\n\n- [ ] root - Root\n- [ ] work - Work blocked-by: root\n\n## Done\n";
const EMPTY = "# Backlog\n\n## In flight\n\n## Queued\n\n## Done\n";

/** Every file under `dir` with its sha256; directories as entries too. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  const walk = (at: string) => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) {
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

function cli(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
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
        ...env,
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

type Side = "markdown" | "beads";
const CASES: {
  from: Side;
  to: Side;
  ids: string[];
  fresh?: boolean;
  freshSource?: boolean;
}[] = [
  { from: "markdown", to: "beads", ids: ["root"] },
  { from: "markdown", to: "beads", ids: ["work", "root"] },
  { from: "markdown", to: "beads", ids: ["work", "root"], fresh: true },
  { from: "beads", to: "markdown", ids: ["root"] },
  { from: "beads", to: "markdown", ids: ["work", "root"] },
  { from: "beads", to: "markdown", ids: ["root"], freshSource: true },
  { from: "beads", to: "beads", ids: ["root"] },
  { from: "beads", to: "beads", ids: ["work", "root"] },
  { from: "beads", to: "beads", ids: ["work", "root"], fresh: true },
];

describe.skipIf(!hasBr)("cross-store mv is refused", () => {
  it.each(CASES)(
    "$from -> $to with $ids (fresh destination: $fresh, fresh source: $freshSource)",
    async ({ from, to, ids, fresh, freshSource }) => {
      const home = mkdtempSync(join(tmpdir(), "tasks-axi-refuse-"));
      const workspaces: { cleanup(): void }[] = [];
      try {
        const counter = join(home, "br-count.sh");
        const calls = join(home, "br-calls");
        writeFileSync(
          counter,
          `#!/bin/sh\necho "$*" >> '${calls}'\nexec br "$@"\n`,
          { mode: 0o755 },
        );
        const makeSide = async (side: Side, role: "src" | "dst") => {
          if (side === "markdown") {
            const path = join(home, role, "backlog.md");
            const dir = join(home, role);
            mkdirSync(dir, { recursive: true });
            writeFileSync(path, role === "src" ? SEED : EMPTY);
            return { dir, file: path, arg: path };
          }
          if (role === "src" && freshSource) {
            const dir = join(home, "src-beads");
            return {
              dir,
              file: join(dir, ".beads", "beads.db"),
              arg: join(dir, ".beads"),
            };
          }
          if (role === "dst" && fresh) {
            const dir = join(home, "dst-beads");
            return {
              dir,
              file: join(dir, ".beads", "beads.db"),
              arg: join(dir, ".beads"),
            };
          }
          const ws = makeBeadsWorkspace();
          workspaces.push(ws);
          if (role === "src") {
            const store = new BeadsStore({ path: ws.path });
            await store.create({ id: "root", title: "Root" });
            await store.create({
              id: "work",
              title: "Work",
              deps: [{ type: "blocked-by", id: "root" }],
            });
          }
          return { dir: ws.dir, file: ws.path, arg: ws.path };
        };
        const src = await makeSide(from, "src");
        const dst = await makeSide(to, "dst");
        const before = [snapshot(src.dir), snapshot(dst.dir)];
        const result = cli(
          [
            "mv",
            ...ids,
            "--backend",
            from,
            "--file",
            src.arg,
            "--to",
            dst.arg,
            "--to-backend",
            to,
            "--json",
          ],
          { TASKS_AXI_BEADS_BINARY: counter },
          home,
        );
        const output = result.stdout + result.stderr;
        expect(result.status, output).not.toBe(0);
        expect(output).toContain("cross-store moves are not supported yet");
        expect(output).toContain(src.arg);
        expect(output).toContain(dst.arg);
        expect(output).toContain(from);
        expect(output).toContain(to);
        expect(existsSync(calls), "br was invoked").toBe(false);
        expect([snapshot(src.dir), snapshot(dst.dir)]).toEqual(before);
        if (fresh) expect(existsSync(dst.dir)).toBe(false);
        if (freshSource) expect(existsSync(src.dir)).toBe(false);
      } finally {
        for (const ws of workspaces) ws.cleanup();
        rmSync(home, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it("keeps markdown -> markdown moves working", () => {
    const home = mkdtempSync(join(tmpdir(), "tasks-axi-refuse-"));
    try {
      const src = join(home, "a.md");
      const dst = join(home, "b.md");
      writeFileSync(src, SEED);
      writeFileSync(dst, EMPTY);
      const result = cli(
        ["mv", "work", "root", "--file", src, "--to", dst, "--json"],
        {},
        home,
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(readFileSync(dst, "utf8")).toContain("root - Root");
      expect(readFileSync(src, "utf8")).not.toContain("root - Root");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("store-level cross-store transfers are refused", () => {
  it("MarkdownStore.transferMany refuses a beads destination without touching either side", async () => {
    const home = mkdtempSync(join(tmpdir(), "tasks-axi-refuse-"));
    try {
      const src = join(home, "backlog.md");
      writeFileSync(src, SEED);
      const markdown = new MarkdownStore({ path: src });
      const db = join(home, "dst", ".beads", "beads.db");
      const beads = new BeadsStore({ path: db });
      const before = snapshot(home);
      await expect(
        markdown.transferMany(["root"], beads),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED",
        message: expect.stringContaining(
          "cross-store moves are not supported yet",
        ),
      });
      expect(snapshot(home)).toEqual(before);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("the beads backend does not offer collection transfer", () => {
    const beads = new BeadsStore({
      path: join(tmpdir(), "tasks-axi-none", ".beads", "beads.db"),
    });
    expect(beads.capabilities().collectionTransfer).toBe(false);
    expect(beads.transferMany).toBeUndefined();
  });
});
