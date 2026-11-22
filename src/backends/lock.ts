import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
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
  /** Recoverable locks: where this holder records its subprocesses. */
  children?: string;
  deadline?: number;
}

/** Run `fn` with the held recoverable locks visible to `trackChild`. */
function holding<T>(handles: LockHandle[], fn: () => Promise<T> | T) {
  const files = handles.flatMap((handle) =>
    handle.children ? [handle.children] : [],
  );
  if (!files.length) return fn();
  const deadline = Math.min(
    ...handles.map((handle) => handle.deadline ?? Infinity),
    heldDeadline.getStore() ?? Infinity,
  );
  return heldDeadline.run(deadline, () =>
    heldChildren.run([...(heldChildren.getStore() ?? []), ...files], fn),
  );
}

export interface LockOptions {
  timeoutMs?: number;
  retryMs?: number;
  staleMs?: number;
  /**
   * Opt-in automatic recovery of a lock whose owner is gone. Without it a
   * leftover lock is only reported (markdown's behaviour). With it a waiter
   * removes a lock once its owner process, and every subprocess the owner
   * recorded with `trackChild`, is dead on this host and PID namespace; a
   * one-winner claim per lock instance makes that removal atomic. Locks
   * from another host or namespace are never removed automatically.
   */
  recover?: RecoverOptions;
}

/** Reserved for future recovery settings; pass `{}` to opt in. */
export type RecoverOptions = Record<string, never>;

const HOST = hostname();
/** Linux PID namespace identity; a pid is only checkable inside its own. */
const PID_NS = (() => {
  try {
    return readlinkSync("/proc/self/ns/pid");
  } catch {
    return "-";
  }
})();

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
  ino: number;
  mtimeMs: number;
}

interface Owner {
  pid: number;
  /** Process start time, when the owner's platform exposes one. */
  start?: string;
  /** False when the pid belongs to another host or PID namespace. */
  local: boolean;
  nonce?: string;
}

/**
 * A process's start time (Linux /proc, in clock ticks since boot), so a pid
 * reused by an unrelated process is not mistaken for the recorded one.
 * Undefined where the platform does not expose it.
 */
export function processStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 22; the command name in field 2 may contain spaces or parens.
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

/** Recoverable tokens name their owner, host and PID namespace. */
function recoverableToken(nonce: string): string {
  lockTokenCounter += 1;
  return `tasks-axi-lock/v2 pid=${process.pid} host=${HOST} ns=${PID_NS} nonce=${nonce} start=${processStart(process.pid) ?? "-"} n=${lockTokenCounter}\n`;
}

function owner(token: string): Owner | undefined {
  const v2 =
    /^tasks-axi-lock\/v2 pid=(\d+) host=(\S+) ns=(\S+) nonce=([a-z0-9]+) start=(\S+) /.exec(
      token,
    );
  if (v2)
    return {
      pid: Number(v2[1]),
      local: v2[2] === HOST && v2[3] === PID_NS,
      nonce: v2[4],
      ...(v2[5] !== "-" ? { start: v2[5] } : {}),
    };
  // Every earlier tasks-axi build writes "<pid>:<nonce>:<ms>:<n>" and runs on
  // the single host this backend supports; it never refreshes its lock.
  const legacy = /^(\d+):[a-z0-9]+:\d+:\d+\n?$/.exec(token);
  return legacy ? { pid: Number(legacy[1]), local: true } : undefined;
}

function observe(path: string): Observed | undefined {
  try {
    const token = readFileSync(path, "utf8");
    const stat = statSync(path);
    return { token, ino: stat.ino, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * False only when the recorded process provably no longer exists: no such
 * pid, or the pid now belongs to a process started at a different time.
 * Anything unprovable counts as alive, so the lock stays held.
 */
function processAlive(pid: number, start?: string): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
  } catch (error) {
    // EPERM: the pid exists but belongs to someone else.
    if (errno(error) === "ESRCH") return false;
  }
  if (start === undefined) return true;
  const current = processStart(pid);
  return current === undefined || current === start;
}

function childrenPath(lockPath: string, nonce: string): string {
  return `${lockPath}.children-${nonce}`;
}

/**
 * Abandoned means provably finished: the owner process (and every subprocess
 * it recorded) is dead on this host and PID namespace. A live owner is never
 * displaced, however long it holds the lock. Only content naming no owner (a
 * torn or foreign write) falls back to its age.
 */
function abandoned(lockPath: string, observed: Observed): boolean {
  const holder = owner(observed.token);
  // Unreadable or foreign content proves nothing: it stays locked.
  if (!holder) return false;
  if (!holder.local || processAlive(holder.pid, holder.start)) return false;
  if (!holder.nonce) return true;
  const children = readFileSafe(childrenPath(lockPath, holder.nonce)) ?? "";
  return !children
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      const [pid, start] = line.split(" ");
      return processAlive(Number(pid), start === "-" ? undefined : start);
    });
}

/** Atomically create `path` holding `token`; false when it already exists. */
function createExclusive(path: string, token: string): boolean {
  const tmp = `${path}.${process.pid}.${randomNonce()}.tmp`;
  writeFileSync(tmp, token, "utf8");
  try {
    linkSync(tmp, path);
    return true;
  } catch (error) {
    if (errno(error) === "EEXIST") return false;
    if (busyOnWindows(error)) {
      if (existsSync(path)) return false;
      throw new AxiError(
        `cannot create lock ${path}: this filesystem refused a hard link (${errno(error)})`,
        "UNSUPPORTED",
        ["Keep the beads database on a local NTFS or POSIX filesystem"],
      );
    }
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

function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (errno(error) !== "ENOENT") throw error;
  }
}

function sameInstance(a: Observed, b: Observed): boolean {
  return a.token === b.token && a.ino === b.ino && a.mtimeMs === b.mtimeMs;
}

/**
 * Remove one abandoned lock instance. Each instance has its own claim name, so
 * exactly one contender can win the right to remove it; every other path that
 * changes the lock (its owner's release, a fresh create) needs either a live
 * owner or an absent file, neither of which an abandoned instance allows. The
 * winner rechecks the instance and unlinks it; a late winner of an
 * already-removed instance sees a different instance and does nothing. A
 * claimant that crashes is itself an abandoned owner, recovered the same way.
 */
function takeOver(lockPath: string, observed: Observed, depth = 0): void {
  const id = createHash("sha256")
    .update(`${observed.token}\0${observed.ino}\0${observed.mtimeMs}`)
    .digest("hex")
    .slice(0, 24);
  const claim = `${lockPath}.claim-${id}`;
  const nonce = randomNonce();
  if (!createExclusive(claim, recoverableToken(nonce))) {
    const rival = observe(claim);
    if (rival && depth < 8 && abandoned(claim, rival))
      takeOver(claim, rival, depth + 1);
    return;
  }
  try {
    const current = observe(lockPath);
    if (current && sameInstance(current, observed)) {
      unlinkIfPresent(lockPath);
      const holder = owner(observed.token);
      if (holder?.nonce) unlinkIfPresent(childrenPath(lockPath, holder.nonce));
    }
  } finally {
    unlinkIfPresent(claim);
  }
}

function heldError(lockPath: string, waitedMs: number): AxiError {
  waitedMs = Math.round(waitedMs);
  const observed = observe(lockPath);
  const holder = observed ? owner(observed.token) : undefined;
  const where = holder
    ? holder.local
      ? ` (pid ${holder.pid} or a br subprocess it started is still running)`
      : ` (pid ${holder.pid} on another host or PID namespace)`
    : observed
      ? " (its owner cannot be identified)"
      : "";
  return new AxiError(
    `backlog is locked by another tasks-axi process${where}: ${lockPath}; gave up after waiting ${waitedMs} ms`,
    "LOCKED",
    observed && !holder?.local
      ? [
          `tasks-axi cannot check that owner; remove ${lockPath} only after confirming it is not running`,
        ]
      : [
          "Retry once that write finishes; a lock whose owner and its br subprocesses have exited is recovered automatically",
        ],
  );
}

/** Subprocess pids recorded against recoverable locks held by this async chain. */
const heldChildren = new AsyncLocalStorage<string[]>();
/** The outermost recoverable acquisition's deadline (performance.now()). */
const heldDeadline = new AsyncLocalStorage<number>();

/**
 * Record a subprocess started while holding recoverable locks, so a waiter
 * does not take over after this process dies until that subprocess has also
 * exited. Returns a function that forgets it once it exits.
 */
export function trackChild(pid: number | undefined): () => void {
  const files = heldChildren.getStore() ?? [];
  if (pid === undefined || !files.length) return () => undefined;
  const line = `${pid} ${processStart(pid) ?? "-"}`;
  for (const file of files) appendFileSync(file, `${line}\n`);
  return () => {
    for (const file of files) {
      const kept = (readFileSafe(file) ?? "")
        .split("\n")
        .filter((kept) => kept && kept !== line);
      if (kept.length) atomicWrite(file, kept.join("\n") + "\n");
      else unlinkIfPresent(file);
    }
  };
}

async function acquireRecoverable(
  lockPath: string,
  options: LockOptions,
): Promise<LockHandle> {
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? LOCK_RETRY_MS;
  const started = performance.now();
  // One monotonic budget: nested acquisitions never outlive the outermost.
  const deadline = Math.min(
    started + timeoutMs,
    heldDeadline.getStore() ?? Infinity,
  );
  const nonce = randomNonce();
  const token = recoverableToken(nonce);

  while (!createExclusive(lockPath, token)) {
    const observed = observe(lockPath);
    if (observed && abandoned(lockPath, observed)) takeOver(lockPath, observed);
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw heldError(lockPath, performance.now() - started);
    if (observe(lockPath)) await sleep(Math.min(retryMs, remaining));
  }
  const children = childrenPath(lockPath, nonce);
  return {
    children,
    deadline,
    // Only a live owner releases, and nobody displaces a live owner, so the
    // token check cannot race a successor.
    release: () => {
      if (readFileSafe(lockPath) === token) unlinkIfPresent(lockPath);
      unlinkIfPresent(children);
    },
  };
}

async function acquireLock(
  targetPath: string,
  options: LockOptions = {},
): Promise<LockHandle> {
  const lockPath = `${targetPath}.lock`;
  mkdirSync(dirname(targetPath), { recursive: true });
  if (options.recover) return acquireRecoverable(lockPath, options);
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
  const handles: LockHandle[] = [];
  try {
    for (const path of ordered)
      handles.push(
        await acquireLock(
          path,
          typeof options === "function" ? options(path) : options,
        ),
      );
    return await holding(handles, fn);
  } finally {
    for (const handle of handles.reverse()) handle.release();
  }
}

/** True when a lockfile currently exists for `path`. */
export function isLocked(path: string): boolean {
  return existsSync(`${path}.lock`);
}
