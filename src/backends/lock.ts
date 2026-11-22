import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { AxiError } from "../errors.js";

/**
 * Advisory lockfile for reducing lost updates in the low-contention
 * single-supervisor model. Corruption-safety is guaranteed independently by
 * atomic temp-file + rename writes: readers see either the whole old file or
 * the whole new file, never a torn write.
 */

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 2_500;
const LOCK_RETRY_MS = 25;
let lockTokenCounter = 0;

export interface LockHandle {
  release(): void;
  /** Kernel locks: the locked descriptor subprocesses must inherit. */
  fd?: number;
  /** Kernel locks: the wait budget nested acquisitions share. */
  deadline?: number;
}

/** Run `fn` with held kernel locks visible to subprocesses and nested locks. */
function holding<T>(handles: LockHandle[], fn: () => Promise<T> | T) {
  const fds = handles.flatMap((handle) =>
    handle.fd === undefined ? [] : [handle.fd],
  );
  if (!fds.length) return fn();
  const deadline = Math.min(
    ...handles.map((handle) => handle.deadline ?? Infinity),
    heldDeadline.getStore() ?? Infinity,
  );
  return heldDeadline.run(deadline, () =>
    heldFds.run([...(heldFds.getStore() ?? []), ...fds], fn),
  );
}

export interface LockOptions {
  timeoutMs?: number;
  retryMs?: number;
  staleMs?: number;
  /**
   * Use the kernel-backed flock lock (beads) instead of the exclusive-create
   * lockfile (markdown, which only reports a leftover lock). See
   * `acquireKernel`.
   */
  kernel?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockToken(): string {
  lockTokenCounter += 1;
  return `${process.pid}:${randomNonce()}:${Date.now()}:${lockTokenCounter}\n`;
}

function errno(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : "UNKNOWN";
}

function randomNonce(): string {
  return `${Math.random().toString(36).slice(2)}${Math.random()
    .toString(36)
    .slice(2)}`;
}

function releaseLock(lockPath: string, token: string): void {
  let observed: string;
  try {
    observed = readFileSync(lockPath, "utf8");
  } catch (error) {
    if (errno(error) === "ENOENT") return;
    throw error;
  }
  if (observed !== token) return;

  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
}

function lockedError(lockPath: string, staleMs: number): AxiError {
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
      return new AxiError(`backlog lock looks stale: ${lockPath}`, "LOCKED", [
        `If no tasks-axi process is running, remove ${lockPath} and retry`,
      ]);
    }
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
  return new AxiError(
    "backlog is locked by another tasks-axi process",
    "LOCKED",
    ["Wait a moment and retry"],
  );
}

/** Read a file's UTF-8 contents, or undefined when it does not exist. */
export function readFileSafe(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
}

/** Resolve existing symlink ancestors too, including when the leaf is new. */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if (
      !["ENOENT", "ENOTDIR"].includes(errno(error)) ||
      dirname(absolute) === absolute
    )
      throw error;
    return join(canonicalPath(dirname(absolute)), basename(absolute));
  }
}

/** Write `content` atomically: temp file in the same dir, then rename over. */
export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Math.floor(
    performance.now() * 1000,
  )}`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, path);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}

/**
 * Kernel-backed lock for collections written through subprocesses (beads).
 * The lock is util-linux flock(1) on one open file description of
 * <target>.lock; every br child inherits that descriptor, so the kernel keeps
 * the lock until the last process that can still write (this CLI, br, or a
 * grandchild that kept the descriptor) has exited. Nothing infers liveness,
 * nothing is ever unlinked, and a killed writer needs no cleanup.
 */
const FLOCK_MARKER = "tasks-axi-lock/flock-v1\n";
const FLOCK_TIMEOUT_EXIT = 75;

/**
 * Why `path` must never be written as a data file, or undefined. Every
 * tasks-axi lock is `<target>.lock` and every beads ready marker is
 * `<db>.tasks-axi-ready`, whichever store owns them, and replacing one
 * (an atomic rename onto it) silently splits a live lock. `strict` reserves
 * every `.lock` name; otherwise only a file that already holds a kernel lock
 * record is, so Markdown-only paths behave exactly as before.
 */
export function reservedPath(path: string, strict = true): string | undefined {
  const name = basename(path);
  if (name.endsWith(".tasks-axi-ready")) return "a beads ready marker";
  if (!name.endsWith(".lock")) return undefined;
  if (strict) return "a tasks-axi lock file";
  try {
    const head = readFileSync(path, "utf8").slice(0, FLOCK_MARKER.length);
    return head === FLOCK_MARKER ? "a live beads lock file" : undefined;
  } catch {
    return undefined;
  }
}

/** Descriptors of kernel locks held by this async chain (passed to br). */
const heldFds = new AsyncLocalStorage<number[]>();
/** The wait budget (performance.now()) shared by nested acquisitions. */
const heldDeadline = new AsyncLocalStorage<number>();

/** Lock descriptors a subprocess must inherit to keep this chain's locks. */
export function heldLockFds(): number[] {
  return heldFds.getStore() ?? [];
}

function lockedAfter(lockPath: string, waitedMs: number): AxiError {
  return new AxiError(
    `backlog is locked by another tasks-axi process: ${lockPath}; gave up after waiting ${Math.round(waitedMs)} ms`,
    "LOCKED",
    [
      "Retry once that write finishes; the lock is released when the writer and its br subprocesses exit",
    ],
  );
}

function unsupported(lockPath: string, detail: string): AxiError {
  return new AxiError(`cannot lock ${lockPath}: ${detail}`, "UNSUPPORTED", [
    "The beads backend is refused on Windows; elsewhere it needs a working util-linux-compatible flock on PATH and a local filesystem that supports flock",
  ]);
}

/** Run util-linux flock on `fd`; true when locked, false on timeout. */
function flockFd(
  lockPath: string,
  fd: number,
  waitMs: number,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const helper = spawn(
      "flock",
      [
        "-x",
        "-E",
        String(FLOCK_TIMEOUT_EXIT),
        "-w",
        (Math.max(waitMs, 1) / 1000).toFixed(3),
        "3",
      ],
      { stdio: ["ignore", "ignore", "pipe", fd] },
    );
    helper.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    helper.on("error", (error) =>
      reject(
        errno(error) === "ENOENT"
          ? unsupported(lockPath, "util-linux flock is not on PATH")
          : error,
      ),
    );
    helper.on("close", (code) => {
      if (code === 0) resolve(true);
      else if (code === FLOCK_TIMEOUT_EXIT) resolve(false);
      else
        reject(
          unsupported(
            lockPath,
            `flock failed (exit ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""})`,
          ),
        );
    });
  });
}

function readAll(fd: number): string {
  const size = fstatSync(fd).size;
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(fd, buffer, offset, size - offset, offset);
    if (!read) break;
    offset += read;
  }
  return buffer.subarray(0, offset).toString("utf8");
}

async function acquireKernel(
  lockPath: string,
  options: LockOptions,
  outer: number,
): Promise<LockHandle> {
  if (process.platform === "win32")
    throw unsupported(lockPath, "flock is not available on Windows");
  const started = performance.now();
  const deadline = Math.min(
    started + (options.timeoutMs ?? LOCK_TIMEOUT_MS),
    outer,
  );
  for (;;) {
    // The budget is checked before every attempt, nested ones included.
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      throw lockedAfter(lockPath, performance.now() - started);
    const fd = openSync(lockPath, "a+");
    let kept = false;
    try {
      if (!(await flockFd(lockPath, fd, remaining)))
        throw lockedAfter(lockPath, performance.now() - started);
      // The lock must be on the file the name points at now; a hand removal
      // or an older build's unlink would otherwise split writers across
      // two inodes. Retry on the current file.
      const held = fstatSync(fd);
      let current;
      try {
        current = statSync(lockPath);
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
      }
      if (!current || current.ino !== held.ino || current.dev !== held.dev)
        continue;
      if (performance.now() > deadline)
        throw lockedAfter(lockPath, performance.now() - started);
      const content = readAll(fd);
      if (content === "") writeSync(fd, FLOCK_MARKER);
      else if (content !== FLOCK_MARKER)
        throw new AxiError(
          `${lockPath} holds a lock record from an older tasks-axi build; refusing to remove it automatically`,
          "LOCKED",
          [
            `Stop every older tasks-axi process and its br calls, then remove ${lockPath}; see the beads cutover notes in the README`,
          ],
        );
      kept = true;
      // Closing releases this process's reference only: a br child still
      // running holds the same open file description, and with it the lock.
      return { fd, deadline, release: () => closeSync(fd) };
    } finally {
      if (!kept) closeSync(fd);
    }
  }
}

async function acquireLock(
  targetPath: string,
  options: LockOptions = {},
  outer = heldDeadline.getStore() ?? Infinity,
): Promise<LockHandle> {
  const lockPath = `${targetPath}.lock`;
  mkdirSync(dirname(targetPath), { recursive: true });
  if (options.kernel) return acquireKernel(lockPath, options, outer);
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  // Standalone markdown keeps its own wait; inside a multi-lock acquisition
  // it is also bounded by the shared budget.
  const deadline =
    Date.now() + Math.min(timeoutMs, Math.max(0, outer - performance.now()));

  while (true) {
    // Inside a beads lock the shared budget is absolute: once it is spent, a
    // free lockfile is not taken either. Standalone (outer = Infinity) keeps
    // main's behaviour exactly: always one attempt, then its own wait.
    if (Number.isFinite(outer) && outer - performance.now() <= 0) break;
    try {
      const fd = openSync(lockPath, "wx");
      const token = lockToken();
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      return {
        release: () => releaseLock(lockPath, token),
      };
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;

      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(retryMs, remaining));
    }
  }

  throw lockedError(lockPath, staleMs);
}

/** Run `fn` while holding the advisory lock for `path`, releasing it after. */
export async function withLock<T>(
  path: string,
  fn: () => Promise<T> | T,
  options?: LockOptions,
): Promise<T> {
  const handle = await acquireLock(path, options);
  try {
    return await holding([handle], fn);
  } finally {
    handle.release();
  }
}

export async function withLocks<T>(
  paths: string[],
  fn: () => Promise<T> | T,
  options?: LockOptions | ((path: string) => LockOptions | undefined),
): Promise<T> {
  const byResolved = new Map<string, string>();
  for (const path of paths) byResolved.set(resolve(path), path);
  const ordered = [...byResolved.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, path]) => path);
  const optionsFor = (path: string) =>
    (typeof options === "function" ? options(path) : options) ?? {};
  // A set with a beads (kernel) lock shares one wait budget, the longest
  // single wait. A Markdown-only set keeps main's independent wait per lock,
  // unless it is nested inside a beads lock's budget.
  const shared = ordered.some((path) => optionsFor(path).kernel);
  const budget = Math.min(
    shared
      ? performance.now() +
          Math.max(
            ...ordered.map(
              (path) => optionsFor(path).timeoutMs ?? LOCK_TIMEOUT_MS,
            ),
          )
      : Infinity,
    heldDeadline.getStore() ?? Infinity,
  );
  const handles: LockHandle[] = [];
  try {
    for (const path of ordered)
      handles.push(await acquireLock(path, optionsFor(path), budget));
    return await holding(handles, fn);
  } finally {
    for (const handle of handles.reverse()) handle.release();
  }
}

/** True when a lockfile currently exists for `path`. */
export function isLocked(path: string): boolean {
  return existsSync(`${path}.lock`);
}
