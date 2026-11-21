import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
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
}

export interface LockOptions {
  timeoutMs?: number;
  retryMs?: number;
  staleMs?: number;
  /**
   * Opt-in automatic recovery of a lock whose owner is gone. Without it a
   * leftover lock is only reported (markdown's behaviour). With it the owner
   * refreshes the lock's mtime every `heartbeatMs`, and a waiter takes the lock
   * over when its owner process on this host is dead, or when the lock has not
   * been refreshed for `expiryMs` (an owner on another host, a frozen owner,
   * or an unreadable lock). Takeover and release both run inside a short
   * exclusive guard, so two writers never hold the lock at once.
   */
  recover?: RecoverOptions;
}

export interface RecoverOptions {
  expiryMs?: number;
  heartbeatMs?: number;
}

export const LOCK_EXPIRY_MS = 60_000;
const LOCK_HEARTBEAT_MS = 5_000;
/** A guard is held for a few syscalls; one this old belongs to a crashed taker. */
const GUARD_STALE_MS = 5_000;
const GUARD_WAIT_MS = 10_000;
const HOST = hostname();

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

interface Observed {
  token: string;
  mtimeMs: number;
}

/** Recoverable tokens name their owner; legacy/unknown content parses to undefined. */
function recoverableToken(): string {
  lockTokenCounter += 1;
  return `tasks-axi-lock/v2 pid=${process.pid} host=${HOST} nonce=${randomNonce()} n=${lockTokenCounter}\n`;
}

function owner(token: string): { pid: number; host: string } | undefined {
  const match = /^tasks-axi-lock\/v2 pid=(\d+) host=(\S+) /.exec(token);
  return match ? { pid: Number(match[1]), host: match[2] } : undefined;
}

function observe(path: string): Observed | undefined {
  try {
    const token = readFileSync(path, "utf8");
    return { token, mtimeMs: statSync(path).mtimeMs };
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists but belongs to someone else.
    return errno(error) !== "ESRCH";
  }
}

function abandoned(observed: Observed, expiryMs: number): boolean {
  const holder = owner(observed.token);
  // A pid is only meaningful in the namespace that wrote it.
  if (holder && holder.host === HOST && !processAlive(holder.pid)) return true;
  return Date.now() - observed.mtimeMs > expiryMs;
}

/** Atomically create `path` holding `token`; false when it already exists. */
function createExclusive(path: string, token: string): boolean {
  const tmp = `${path}.${process.pid}.${randomNonce()}.tmp`;
  writeFileSync(tmp, token, "utf8");
  try {
    linkSync(tmp, path);
    return true;
  } catch (error) {
    if (errno(error) === "EEXIST" || busyOnWindows(error)) return false;
    throw error;
  } finally {
    unlinkSync(tmp);
  }
}

/** Windows reports a name whose file is still being deleted as EPERM/EACCES. */
function busyOnWindows(error: unknown): boolean {
  return (
    process.platform === "win32" && ["EPERM", "EACCES"].includes(errno(error))
  );
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Remove `path` only if it still holds exactly what was observed. */
function removeIfUnchanged(path: string, observed: Observed): void {
  const aside = `${path}.${process.pid}.${randomNonce()}.stale`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if (errno(error) === "ENOENT" || busyOnWindows(error)) return;
    throw error;
  }
  if (readFileSafe(aside) !== observed.token) {
    // Lost a race to a fresh holder: put its file back unless another exists.
    try {
      linkSync(aside, path);
    } catch (error) {
      if (errno(error) !== "EEXIST") throw error;
    }
  }
  unlinkSync(aside);
}

/**
 * Run `fn` synchronously inside the takeover guard. Every removal of a
 * recoverable lock (takeover and release) happens here, so the check that
 * decided a removal and the removal itself are one critical section.
 */
function guarded(lockPath: string, fn: () => void): boolean {
  const guardPath = `${lockPath}.guard`;
  const token = recoverableToken();
  const deadline = Date.now() + GUARD_WAIT_MS;
  while (!createExclusive(guardPath, token)) {
    const stale = observe(guardPath);
    if (stale && abandoned(stale, GUARD_STALE_MS))
      removeIfUnchanged(guardPath, stale);
    else if (Date.now() > deadline) return false;
    else sleepSync(1);
  }
  try {
    fn();
    return true;
  } finally {
    if (readFileSafe(guardPath) === token) unlinkSync(guardPath);
  }
}

function heldError(
  lockPath: string,
  waitedMs: number,
  expiryMs: number,
): AxiError {
  const observed = observe(lockPath);
  const holder = observed ? owner(observed.token) : undefined;
  const age = observed
    ? `, last refreshed ${Math.round((Date.now() - observed.mtimeMs) / 1000)}s ago`
    : "";
  return new AxiError(
    `backlog is locked by another tasks-axi process${
      holder ? ` (pid ${holder.pid} on ${holder.host}${age})` : age
    }; gave up after waiting ${Math.round(waitedMs / 1000)}s`,
    "LOCKED",
    [
      `Retry once that write finishes; a lock whose owner died is recovered automatically, and one not refreshed for ${Math.round(expiryMs / 1000)}s expires`,
    ],
  );
}

async function acquireRecoverable(
  lockPath: string,
  options: LockOptions,
  recover: RecoverOptions,
): Promise<LockHandle> {
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const expiryMs = recover.expiryMs ?? LOCK_EXPIRY_MS;
  const heartbeatMs =
    recover.heartbeatMs ?? Math.min(LOCK_HEARTBEAT_MS, expiryMs / 4);
  const started = Date.now();
  const token = recoverableToken();

  while (!createExclusive(lockPath, token)) {
    const observed = observe(lockPath);
    if (observed && abandoned(observed, expiryMs)) {
      guarded(lockPath, () => {
        const current = observe(lockPath);
        if (
          current?.token === observed.token &&
          current.mtimeMs === observed.mtimeMs &&
          abandoned(current, expiryMs)
        )
          unlinkSync(lockPath);
      });
      continue;
    }
    const remaining = started + timeoutMs - Date.now();
    if (remaining <= 0) throw heldError(lockPath, Date.now() - started, expiryMs);
    await sleep(Math.min(retryMs, remaining));
  }

  const heartbeat = setInterval(() => {
    try {
      if (readFileSafe(lockPath) === token) {
        const now = new Date();
        utimesSync(lockPath, now, now);
      }
    } catch {
      // A missed beat only shortens the time before expiry.
    }
  }, heartbeatMs);
  heartbeat.unref();
  return {
    release: () => {
      clearInterval(heartbeat);
      const released = guarded(lockPath, () => {
        if (readFileSafe(lockPath) === token) unlinkSync(lockPath);
      });
      if (!released && readFileSafe(lockPath) === token) unlinkSync(lockPath);
    },
  };
}

async function acquireLock(
  targetPath: string,
  options: LockOptions = {},
): Promise<LockHandle> {
  const lockPath = `${targetPath}.lock`;
  mkdirSync(dirname(targetPath), { recursive: true });
  if (options.recover)
    return acquireRecoverable(lockPath, options, options.recover);
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
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
    return await fn();
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
  const handles: LockHandle[] = [];
  try {
    for (const path of ordered)
      handles.push(
        await acquireLock(
          path,
          typeof options === "function" ? options(path) : options,
        ),
      );
    return await fn();
  } finally {
    for (const handle of handles.reverse()) handle.release();
  }
}

/** True when a lockfile currently exists for `path`. */
export function isLocked(path: string): boolean {
  return existsSync(`${path}.lock`);
}
