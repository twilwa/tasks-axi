import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
