import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

// Resolve the real executable once; recorder children never search PATH again.
const brBinary = (process.env.PATH ?? "")
  .split(delimiter)
  .flatMap((dir) =>
    process.platform === "win32"
      ? [join(dir, "br.exe"), join(dir, "br")]
      : [join(dir, "br")],
  )
  .find((path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
const realBr = brBinary ? realpathSync(resolve(brBinary)) : undefined;

// Even the availability probe has an explicit throwaway database address.
const probeDir = mkdtempSync(join(tmpdir(), "tasks-axi-br-probe-"));
const probe = spawnSync(
  realBr ?? "br",
  ["--db", join(probeDir, "probe.db"), "--version"],
  { encoding: "utf8" },
);
rmSync(probeDir, { recursive: true, force: true });
export const hasBr = realBr !== undefined && probe.status === 0;

/** Per-instance real-br recorder with contained process-boundary fault hooks. */
export function recordBr(
  dir: string,
  db: string,
  hooks: { before?: string; after?: string } = {},
) {
  if (!realBr) throw new Error("br executable is unavailable");
  const binary = join(dir, "record-br.cjs");
  const log = join(dir, "commands.jsonl");
  writeFileSync(
    binary,
    `#!${process.execPath}
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
if (process.env.TASKS_AXI_BR_RECORDER) throw new Error('recursive br recorder');
const args = process.argv.slice(2);
if (args[0] !== '--db' || args[1] !== ${JSON.stringify(db)}) process.exit(99);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
${hooks.before ?? ""}
const result = spawnSync(${JSON.stringify(realBr)}, args, {input:fs.readFileSync(0), stdio:['pipe', 'inherit', 'inherit'], env:{...process.env, TASKS_AXI_BR_RECORDER:'1'}});
${hooks.after ?? ""}
process.exit(result.status ?? 1);
`,
    { mode: 0o700 },
  );
  const header =
    process.platform === "win32"
      ? readFileSync(binary, "utf8").split("\n").slice(0, 2).join("\n")
      : execFileSync("head", ["-n2", binary], { encoding: "utf8" }).trimEnd();
  if (header !== `#!${process.execPath}\nconst fs = require('node:fs');`)
    throw new Error("Invalid br recorder header");
  return { binary, log };
}

export function makeBeadsWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "tasks-axi-br-"));
  const path = join(dir, ".beads", "beads.db");
  mkdirSync(join(dir, ".beads"));
  const br = (args: string[], input?: string): unknown =>
    JSON.parse(
      execFileSync(realBr ?? "br", ["--db", path, ...args, "--json"], {
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
