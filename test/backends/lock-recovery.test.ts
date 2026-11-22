import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isLocked,
  takeOver,
  withLock,
  withLocks,
} from "../../src/backends/lock.js";
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
    // A zombie (exited, awaiting its reaper) can no longer write.
    const alive = () => {
      try {
        process.kill(sub, 0);
      } catch {
        return false;
      }
      try {
        const stat = readFileSync("/proc/" + sub + "/stat", "utf8");
        return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
      } catch {
        return process.platform !== "linux";
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

  it("bounds several locks taken together by one deadline", async () => {
    const first = join(dir, "a.db");
    const second = join(dir, "b.db");
    const hold = async (path: string, ms: number) => {
      let holding!: () => void;
      const held = new Promise<void>((r) => (holding = r));
      const done = withLock(
        path,
        async () => {
          holding();
          await new Promise((r) => setTimeout(r, ms));
        },
        { recover: {} },
      );
      await held;
      return { done };
    };
    // The first lock costs ~600 ms of the budget; the second is never free.
    const a = await hold(first, 600);
    const b = await hold(second, 4_000);
    const started = performance.now();
    await expect(
      withLocks([first, second], () => "stolen", {
        timeoutMs: 800,
        retryMs: 20,
        recover: {},
      }),
    ).rejects.toMatchObject({ code: "LOCKED" });
    // One 800 ms budget for both, not 800 ms each (which would be ~1,400 ms).
    expect(performance.now() - started).toBeLessThan(1_150);
    await Promise.all([a.done, b.done]);
  }, 15_000);

  it("a late contender for an already-recovered lock leaves its successor alone", async () => {
    const target = join(dir, "beads.db");
    expect(await child(target, "crash", recover)).toBe(7);
    const lock = target + ".lock";
    // Contender A observed the abandoned instance, then stalled.
    const stat = statSync(lock);
    const stale = {
      token: readFileSync(lock, "utf8"),
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
    };
    let release!: () => void;
    let holding!: () => void;
    const held = new Promise<void>((r) => (holding = r));
    // Contender B recovered the lock and now holds a fresh one.
    const successor = withLock(
      target,
      () => {
        holding();
        return new Promise<void>((r) => (release = r));
      },
      recover,
    );
    await held;
    const fresh = readFileSync(lock, "utf8");
    // A resumes with its stale observation; it must not remove B's lock.
    takeOver(lock, stale);
    expect(readFileSync(lock, "utf8")).toBe(fresh);
    await expect(
      withLock(target, () => "stolen", {
        timeoutMs: 200,
        retryMs: 20,
        recover: {},
      }),
    ).rejects.toMatchObject({ code: "LOCKED" });
    release();
    await successor;
  }, 30_000);

  it.skipIf(process.platform !== "linux")(
    "takes over from an exited owner its parent has not reaped yet",
    async () => {
      const target = join(dir, "beads.db");
      const crash = join(dir, "crash.mts");
      writeFileSync(
        crash,
        [
          'import { writeFileSync } from "node:fs";',
          "import { withLock } from " + JSON.stringify(lockModule) + ";",
          "await withLock(process.argv[2], () => {",
          "  writeFileSync(process.argv[3], String(process.pid));",
          "  process.exit(7);",
          "}, { recover: {} });",
        ].join("\n"),
      );
      const pidFile = join(dir, "owner.pid");
      // The parent blocks its event loop, so it never reaps the dead owner.
      const parent = spawn(
        process.execPath,
        [
          "-e",
          [
            "const { spawn } = require('node:child_process');",
            "const fs = require('node:fs');",
            "spawn(process.execPath, ['--import', 'tsx', " +
              JSON.stringify(crash) +
              ", " +
              JSON.stringify(target) +
              ", " +
              JSON.stringify(pidFile) +
              "], { stdio: 'ignore' });",
            "const until = Date.now() + 15000;",
            "while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);",
          ].join("\n"),
        ],
        { stdio: "ignore", cwd: resolve(".") },
      );
      try {
        const zombie = () => {
          if (!existsSync(pidFile)) return false;
          const pid = readFileSync(pidFile, "utf8");
          try {
            const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
            return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
          } catch {
            return false;
          }
        };
        const deadline = Date.now() + 10_000;
        while (!zombie()) {
          if (Date.now() > deadline)
            throw new Error("owner never became a zombie");
          await new Promise((r) => setTimeout(r, 20));
        }
        await expect(
          withLock(target, () => "ok", { timeoutMs: 2_000, recover: {} }),
        ).resolves.toBe("ok");
        expect(zombie()).toBe(true);
      } finally {
        parent.kill("SIGKILL");
      }
    },
    30_000,
  );

  it.skipIf(process.platform !== "linux")(
    "takes over when the owner's pid now belongs to a different process",
    async () => {
      const target = join(dir, "beads.db");
      // A live pid (this test runner) with a start time it never had.
      const reused =
        "tasks-axi-lock/v2 pid=" +
        process.ppid +
        " host=" +
        hostname() +
        " ns=" +
        readlinkSync("/proc/self/ns/pid") +
        " nonce=reused start=1 n=1\n";
      writeFileSync(target + ".lock", reused);
      await expect(
        withLock(target, () => "ok", { timeoutMs: 2_000, recover: {} }),
      ).resolves.toBe("ok");
    },
  );
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
