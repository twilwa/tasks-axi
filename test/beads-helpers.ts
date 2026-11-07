import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Even the availability probe has an explicit throwaway database address.
const probeDir = mkdtempSync(join(tmpdir(), "tasks-axi-br-probe-"));
const probe = spawnSync(
  "br",
  ["--db", join(probeDir, "probe.db"), "--version"],
  { encoding: "utf8" },
);
rmSync(probeDir, { recursive: true, force: true });
export const hasBr = probe.error?.code !== "ENOENT";

/** Per-instance real-br recorder with contained process-boundary fault hooks. */
export function recordBr(
  dir: string,
  db: string,
  hooks: { before?: string; after?: string } = {},
) {
  const binary = join(dir, "record-br.cjs");
  const log = join(dir, "commands.jsonl");
  writeFileSync(
    binary,
    `#!${process.execPath}
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] !== '--db' || args[1] !== ${JSON.stringify(db)}) process.exit(99);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
${hooks.before ?? ""}
const result = spawnSync('br', args, {input:fs.readFileSync(0), stdio:['pipe', 'inherit', 'inherit']});
${hooks.after ?? ""}
process.exit(result.status ?? 1);
`,
    { mode: 0o700 },
  );
  return { binary, log };
}

export function makeBeadsWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "tasks-axi-br-"));
  const path = join(dir, ".beads", "beads.db");
  mkdirSync(join(dir, ".beads"));
  const br = (args: string[], input?: string): unknown =>
    JSON.parse(
      execFileSync("br", ["--db", path, ...args, "--json"], {
        cwd: dir,
        encoding: "utf8",
        input,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
  br(["init", "--prefix", "test"]);
  return {
    dir,
    path,
    br,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
