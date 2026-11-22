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

  it("never removes a lock whose owner cannot be identified, however old", async () => {
    const target = join(dir, "beads.db");
    writeFileSync(target + ".lock", "unknown-holder\n");
    const old = new Date(Date.now() - 600_000);
    utimesSync(target + ".lock", old, old);
    await expect(
      withLock(target, () => "never", {
        timeoutMs: 100,
        retryMs: 5,
        recover: {},
      }),
    ).rejects.toMatchObject({
      code: "LOCKED",
      message: expect.stringContaining(target + ".lock"),
      suggestions: [expect.stringContaining("remove " + target + ".lock")],
    });
    expect(readFileSync(target + ".lock", "utf8")).toBe("unknown-holder\n");
  });

  it("never takes over a live holder, however long it holds the lock", async () => {
    const target = join(dir, "beads.db");
    const options = {
      timeoutMs: 1_500,
      retryMs: 20,
      recover: {},
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
    const old = new Date(Date.now() - 600_000);
    utimesSync(target + ".lock", old, old);
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

  it("keeps admitting one writer at a time across repeated crashes and takeovers", async () => {
    const target = join(dir, "beads.db");
    const log = join(dir, "log");
    for (let round = 0; round < 4; round++) {
      expect(await child(target, "crash", recover)).toBe(7);
      const codes = await Promise.all(
        Array.from({ length: 6 }, () => child(target, "work", recover, log)),
      );
      expect(codes).toEqual(Array(6).fill(0));
    }
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toEqual(Array(24).fill(["enter", "exit"]).flat());
    expect(isLocked(target)).toBe(false);
  }, 120_000);

  it("treats a pre-recovery tasks-axi lock as owned while its process lives", async () => {
    const target = join(dir, "beads.db");
    const sleeper = spawn(process.execPath, [
      "-e",
      "setTimeout(() => {}, 60000)",
    ]);
    try {
      // The token format every earlier tasks-axi build writes.
      const legacy = sleeper.pid + ":abc123:" + Date.now() + ":1\n";
      writeFileSync(target + ".lock", legacy);
      const old = new Date(Date.now() - 600_000);
      utimesSync(target + ".lock", old, old);
      const options = {
        timeoutMs: 400,
        retryMs: 20,
        recover: {},
      };
      await expect(
        withLock(target, () => "stolen", options),
      ).rejects.toMatchObject({ code: "LOCKED" });
      expect(readFileSync(target + ".lock", "utf8")).toBe(legacy);
      sleeper.kill();
      await new Promise((r) => sleeper.on("close", r));
      await expect(withLock(target, () => "ok", options)).resolves.toBe("ok");
    } finally {
      sleeper.kill();
    }
  }, 30_000);

  it("waits for a crashed owner's still-running subprocess before taking over", async () => {
    const target = join(dir, "beads.db");
    const script = join(dir, "spawner.mts");
    writeFileSync(
      script,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        "import { trackChild, withLock } from " +
          JSON.stringify(lockModule) +
          ";",
        "const [target, pidFile] = process.argv.slice(2);",
        "await withLock(target, () => {",
        '  const sub = spawn(process.execPath, ["-e", "setTimeout(() => {}, 2500)"], { detached: true, stdio: "ignore" });',
        "  trackChild(sub.pid);",
        "  writeFileSync(pidFile, String(sub.pid));",
        "  process.exit(7);",
        "}, { recover: {} });",
      ].join("\n"),
    );
    const pidFile = join(dir, "sub.pid");
    const code = await new Promise((done) =>
      spawn(process.execPath, ["--import", "tsx", script, target, pidFile], {
        stdio: "inherit",
      }).on("close", done),
    );
    expect(code).toBe(7);
    const sub = Number(readFileSync(pidFile, "utf8"));
    const alive = () => {
      try {
        process.kill(sub, 0);
        return true;
      } catch {
        return false;
      }
    };
    expect(alive()).toBe(true);
    await expect(
      withLock(target, () => alive(), { timeoutMs: 20_000, recover: {} }),
    ).resolves.toBe(false);
  }, 30_000);

  it("never takes over a lock from another host or PID namespace, and gives up on time", async () => {
    const target = join(dir, "beads.db");
    const foreign =
      "tasks-axi-lock/v2 pid=1 host=elsewhere ns=pid:[1] nonce=x start=- n=1\n";
    writeFileSync(target + ".lock", foreign);
    const old = new Date(Date.now() - 600_000);
    utimesSync(target + ".lock", old, old);
    const started = Date.now();
    await expect(
      withLock(target, () => "stolen", {
        timeoutMs: 300,
        retryMs: 20,
        recover: {},
      }),
    ).rejects.toMatchObject({
      code: "LOCKED",
      suggestions: [expect.stringContaining(target + ".lock")],
    });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(readFileSync(target + ".lock", "utf8")).toBe(foreign);
  });

  it("bounds a nested acquisition by the outer lock's remaining deadline", async () => {
    const outer = join(dir, "a.db");
    const inner = join(dir, "b.db");
    let release!: () => void;
    let holding!: () => void;
    const held = new Promise<void>((r) => (holding = r));
    const holder = withLock(
      inner,
      () => {
        holding();
        return new Promise<void>((r) => (release = r));
      },
      { recover: {} },
    );
    await held;
    const started = performance.now();
    await expect(
      withLock(
        outer,
        () =>
          withLock(inner, () => "stolen", { timeoutMs: 20_000, recover: {} }),
        { timeoutMs: 300, retryMs: 20, recover: {} },
      ),
    ).rejects.toMatchObject({
      code: "LOCKED",
      message: expect.stringMatching(
        new RegExp(
          inner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
            "\\.lock; gave up after waiting \\d+ ms",
        ),
      ),
    });
    expect(performance.now() - started).toBeLessThan(2_000);
    release();
    await holder;
  });
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
