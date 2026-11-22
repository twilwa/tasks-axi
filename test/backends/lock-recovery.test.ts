import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withLock, withLocks } from "../../src/backends/lock.js";
import { MarkdownStore } from "../../src/backends/markdown.js";
import { hasFlock } from "../beads-helpers.js";

const lockModule = pathToFileURL(resolve("src/backends/lock.ts")).href;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tasks-axi-lock-recovery-"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function run(script: string, args: string[]): Promise<number | null> {
  return new Promise((done, fail) => {
    const proc = spawn(process.execPath, ["--import", "tsx", script, ...args], {
      stdio: "inherit",
    });
    proc.on("error", fail);
    proc.on("close", done);
  });
}

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
  return run(script, [target, mode, log, JSON.stringify(options)]);
}

/** Hold \`path\` in this process until the returned release is called. */
async function hold(path: string, options: Record<string, unknown>) {
  let release!: () => void;
  let holding!: () => void;
  const held = new Promise<void>((r) => (holding = r));
  const done = withLock(
    path,
    () => {
      holding();
      return new Promise<void>((r) => (release = r));
    },
    options,
  );
  await held;
  return { release: () => release(), done };
}

/** Alive and not a zombie: something that can still write. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
    return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return false;
  }
}

const kernel = { timeoutMs: 20_000, kernel: true };

describe.skipIf(!hasFlock)("kernel (flock) locks", () => {
  it("frees a crashed owner's lock at once, with no cleanup", async () => {
    const target = join(dir, "beads.db");
    expect(await child(target, "crash", kernel)).toBe(7);
    const started = performance.now();
    await expect(withLock(target, () => "ok", kernel)).resolves.toBe("ok");
    expect(performance.now() - started).toBeLessThan(5_000);
    // The lock file is never removed; it only ever holds the marker.
    expect(readFileSync(target + ".lock", "utf8")).toBe(
      "tasks-axi-lock/flock-v1\n",
    );
  }, 30_000);

  it("admits one writer at a time across repeated crashes", async () => {
    const target = join(dir, "beads.db");
    const log = join(dir, "log");
    for (let round = 0; round < 3; round++) {
      expect(await child(target, "crash", kernel)).toBe(7);
      const codes = await Promise.all(
        Array.from({ length: 8 }, () => child(target, "work", kernel, log)),
      );
      expect(codes).toEqual(Array(8).fill(0));
    }
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines).toEqual(Array(24).fill(["enter", "exit"]).flat());
  }, 120_000);

  it("never admits a second writer while a live owner holds the lock, and names the path and wait", async () => {
    const target = join(dir, "beads.db");
    const owner = await hold(target, kernel);
    await expect(
      withLock(target, () => "stolen", { timeoutMs: 300, kernel: true }),
    ).rejects.toMatchObject({
      code: "LOCKED",
      message: expect.stringMatching(
        /beads\.db\.lock; gave up after waiting \d+ ms/,
      ),
    });
    owner.release();
    await owner.done;
  });

  it.each([
    ["a direct subprocess", "sleep 2.5"],
    [
      "a grandchild behind a shell wrapper that was itself killed",
      'sleep 2.5 & echo $! > "$1"; wait',
    ],
  ])(
    "keeps a crashed owner's lock while %s that inherited it still runs",
    async (_name, command) => {
      const target = join(dir, "beads.db");
      const pidFile = join(dir, "writer.pid");
      const script = join(dir, "spawner.mts");
      writeFileSync(
        script,
        [
          'import { spawn } from "node:child_process";',
          'import { writeFileSync } from "node:fs";',
          "import { heldLockFds, withLock } from " +
            JSON.stringify(lockModule) +
            ";",
          "const [target, pidFile, command] = process.argv.slice(2);",
          "await withLock(target, async () => {",
          '  const sub = spawn("/bin/sh", ["-c", command, "sh", pidFile + ".grand"], { detached: true, stdio: ["ignore", "ignore", "ignore", ...heldLockFds()] });',
          "  writeFileSync(pidFile, String(sub.pid));",
          "  await new Promise((r) => setTimeout(r, 300));",
          "  process.exit(7);",
          "}, { timeoutMs: 20000, kernel: true });",
        ].join("\n"),
      );
      expect(await run(script, [target, pidFile, command])).toBe(7);
      const sub = Number(readFileSync(pidFile, "utf8"));
      let writer = sub;
      if (existsSync(pidFile + ".grand")) {
        writer = Number(readFileSync(pidFile + ".grand", "utf8"));
        process.kill(sub, "SIGKILL"); // the wrapper dies; its grandchild lives
      }
      expect(running(writer)).toBe(true);
      await expect(
        withLock(target, () => running(writer), kernel),
      ).resolves.toBe(false);
    },
    30_000,
  );

  it.each([
    ["an older tasks-axi build", "4242:abc123:1795000000000:1\n"],
    [
      "an interim recovery build",
      "tasks-axi-lock/v2 pid=4242 host=h ns=pid:[1] nonce=x start=1 n=1\n",
    ],
  ])("never removes a lock record left by %s", async (_name, record) => {
    const target = join(dir, "beads.db");
    writeFileSync(target + ".lock", record);
    await expect(
      withLock(target, () => "stolen", { timeoutMs: 300, kernel: true }),
    ).rejects.toMatchObject({
      code: "LOCKED",
      message: expect.stringContaining("older tasks-axi build"),
      suggestions: [expect.stringContaining("remove " + target + ".lock")],
    });
    expect(readFileSync(target + ".lock", "utf8")).toBe(record);
  });

  it("bounds a nested acquisition by the outer lock's remaining budget", async () => {
    const outer = join(dir, "a.db");
    const inner = join(dir, "b.db");
    const owner = await hold(inner, kernel);
    const started = performance.now();
    await expect(
      withLock(outer, () => withLock(inner, () => "stolen", kernel), {
        timeoutMs: 300,
        kernel: true,
      }),
    ).rejects.toMatchObject({ code: "LOCKED" });
    expect(performance.now() - started).toBeLessThan(2_000);
    owner.release();
    await owner.done;
  });

  it("refuses even a free nested lock once the outer budget is spent", async () => {
    const outer = join(dir, "a.db");
    const inner = join(dir, "b.db");
    await expect(
      withLock(
        outer,
        async () => {
          await new Promise((r) => setTimeout(r, 300));
          return withLock(inner, () => "late", kernel);
        },
        { timeoutMs: 200, kernel: true },
      ),
    ).rejects.toMatchObject({ code: "LOCKED" });
  });

  it("refuses a free markdown lock once the beads budget it is nested in is spent", async () => {
    const outer = join(dir, "a.db");
    const md = join(dir, "b.md");
    await expect(
      withLock(
        outer,
        async () => {
          await new Promise((r) => setTimeout(r, 300));
          return withLock(md, () => "late");
        },
        { timeoutMs: 200, kernel: true },
      ),
    ).rejects.toMatchObject({ code: "LOCKED" });
    expect(existsSync(md + ".lock")).toBe(false);
  });

  it("bounds several locks taken together by one budget", async () => {
    const first = join(dir, "a.db");
    const second = join(dir, "b.db");
    const a = await hold(first, kernel);
    const b = await hold(second, kernel);
    setTimeout(() => a.release(), 600);
    const started = performance.now();
    await expect(
      withLocks([first, second], () => "stolen", {
        timeoutMs: 800,
        kernel: true,
      }),
    ).rejects.toMatchObject({ code: "LOCKED" });
    // One 800 ms budget for both, not 800 ms each (~1,400 ms).
    expect(performance.now() - started).toBeLessThan(1_150);
    b.release();
    await Promise.all([a.done, b.done]);
  }, 15_000);

  it("gives a mixed markdown and kernel set one budget", async () => {
    const md = join(dir, "a.md");
    const db = join(dir, "b.db");
    const mdOwner = await hold(md, {});
    const dbOwner = await hold(db, kernel);
    setTimeout(() => mdOwner.release(), 1_500);
    const started = performance.now();
    await expect(
      withLocks(
        [md, db],
        () => "stolen",
        (path) => (path === md ? {} : { timeoutMs: 2_000, kernel: true }),
      ),
    ).rejects.toMatchObject({ code: "LOCKED" });
    // Budget is the longest single wait (markdown's 2.5 s), not 1.5 + 2 s.
    expect(performance.now() - started).toBeLessThan(3_100);
    dbOwner.release();
    await Promise.all([mdOwner.done, dbOwner.done]);
  }, 15_000);

  it("fails closed with UNSUPPORTED when util-linux flock is missing", async () => {
    vi.stubEnv("PATH", dir);
    await expect(
      withLock(join(dir, "beads.db"), () => "ok", kernel),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringContaining("flock"),
    });
  });
});

describe("markdown lock behaviour is unchanged", () => {
  it("gives each markdown lock in a set its own wait, as on main", async () => {
    // Staggered contention: the second file frees 3.5 s in, after a shared
    // 2.5 s budget would have expired but within its own 2.5 s wait.
    const first = join(dir, "a.md");
    const second = join(dir, "b.md");
    writeFileSync(first + ".lock", "held-by-test");
    writeFileSync(second + ".lock", "held-by-test");
    setTimeout(() => rmSync(first + ".lock"), 1_500);
    setTimeout(() => rmSync(second + ".lock"), 3_500);
    const started = Date.now();
    await expect(withLocks([first, second], () => "entered")).resolves.toBe(
      "entered",
    );
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(3_400);
    expect(waited).toBeLessThan(4_200);
  }, 15_000);

  it("still refuses a second markdown file busy past its own wait", async () => {
    const first = join(dir, "a.md");
    const second = join(dir, "b.md");
    writeFileSync(first + ".lock", "held-by-test");
    writeFileSync(second + ".lock", "held-by-test");
    setTimeout(() => rmSync(first + ".lock"), 1_000);
    const started = Date.now();
    await expect(
      withLocks([first, second], () => "entered"),
    ).rejects.toMatchObject({ code: "LOCKED" });
    // 1 s on the first, then the second's full 2.5 s.
    expect(Date.now() - started).toBeGreaterThanOrEqual(3_400);
  }, 15_000);

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
