import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLocked, withLock } from "../../src/backends/lock.js";
import { MarkdownStore } from "../../src/backends/markdown.js";

const lockModule = pathToFileURL(resolve("src/backends/lock.ts")).href;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tasks-axi-lock-recovery-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A real separate process that takes the lock, then crashes or works. */
function child(
  target: string,
  mode: "crash" | "work",
  options: Record<string, unknown>,
  log = join(dir, "log"),
): Promise<number | null> {
  const script = join(dir, "holder.mts");
  writeFileSync(
    script,
    [
      'import { appendFileSync } from "node:fs";',
      "import { withLock } from " + JSON.stringify(lockModule) + ";",
      "const [target, mode, log, options] = process.argv.slice(2);",
      "await withLock(target, async () => {",
      '  if (mode === "crash") process.exit(7);',
      '  appendFileSync(log, "enter\\n");',
      "  await new Promise((r) => setTimeout(r, 40));",
      '  appendFileSync(log, "exit\\n");',
      "}, JSON.parse(options));",
    ].join("\n"),
  );
  return new Promise((done, fail) => {
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", script, target, mode, log, JSON.stringify(options)],
      { stdio: "inherit" },
    );
    proc.on("error", fail);
    proc.on("close", done);
  });
}

const recover = { timeoutMs: 20_000, recover: {} };

describe("recoverable locks", () => {
  it("recovers a lock left by a crashed owner without hand cleanup", async () => {
    const target = join(dir, "beads.db");
    expect(await child(target, "crash", recover)).toBe(7);
    expect(isLocked(target)).toBe(true);

    const started = Date.now();
    await expect(withLock(target, () => "ok", recover)).resolves.toBe("ok");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(isLocked(target)).toBe(false);
  }, 30_000);

  it("admits one writer at a time when many contend to take over a crashed lock", async () => {
    const target = join(dir, "beads.db");
    expect(await child(target, "crash", recover)).toBe(7);
    const log = join(dir, "log");
    const codes = await Promise.all(
      Array.from({ length: 8 }, () => child(target, "work", recover, log)),
    );
    expect(codes).toEqual(Array(8).fill(0));
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toEqual(Array(8).fill(["enter", "exit"]).flat());
    expect(isLocked(target)).toBe(false);
  }, 60_000);

  it("expires a lock whose owner cannot be identified once it has not been refreshed", async () => {
    const target = join(dir, "beads.db");
    writeFileSync(target + ".lock", "unknown-holder\n");
    const options = {
      timeoutMs: 100,
      retryMs: 5,
      recover: { expiryMs: 1_000 },
    };
    await expect(
      withLock(target, () => "never", options),
    ).rejects.toMatchObject({ code: "LOCKED" });
    const old = new Date(Date.now() - 5_000);
    utimesSync(target + ".lock", old, old);
    await expect(withLock(target, () => "ok", options)).resolves.toBe("ok");
  });

  it("keeps a live holder's lock past the expiry by refreshing it", async () => {
    const target = join(dir, "beads.db");
    const options = {
      timeoutMs: 1_500,
      retryMs: 20,
      recover: { expiryMs: 1_000, heartbeatMs: 100 },
    };
    let release!: () => void;
    let holding!: () => void;
    const held = new Promise<void>((r) => (holding = r));
    const first = withLock(
      target,
      () => {
        holding();
        return new Promise<void>((r) => (release = r));
      },
      options,
    );
    await held;
    await new Promise((r) => setTimeout(r, 2_500));
    await expect(
      withLock(target, () => "stolen", options),
    ).rejects.toMatchObject({
      code: "LOCKED",
      message: expect.stringContaining("pid " + process.pid),
    });
    release();
    await first;
    await expect(withLock(target, () => "next", options)).resolves.toBe("next");
  }, 15_000);
});

describe("markdown lock behaviour is unchanged", () => {
  it("still refuses a crashed owner's lock after the 2.5 s default wait, without removing it", async () => {
    const path = join(dir, "backlog.md");
    writeFileSync(path, "# Backlog\n\n## Queued\n");
    expect(await child(path, "crash", {})).toBe(7);
    const before = readFileSync(path + ".lock", "utf8");
    const started = Date.now();
    await expect(
      new MarkdownStore({ path }).create({ id: "a", title: "A" }),
    ).rejects.toMatchObject({ code: "LOCKED" });
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(2_400);
    expect(waited).toBeLessThan(10_000);
    expect(existsSync(path + ".lock")).toBe(true);
    expect(readFileSync(path + ".lock", "utf8")).toBe(before);
  }, 30_000);
});
