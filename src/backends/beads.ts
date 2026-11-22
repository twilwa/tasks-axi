/**
 * beads_rust (br) adapter. Native ids are implementation details: external_ref
 * owns the caller's join key, and description is always the unadorned body.
 * Port of the bd Store concepts from RooseveltAdvisors/tasks-axi (MIT):
 * https://github.com/RooseveltAdvisors/tasks-axi/blob/8c6f96eb58924fd094053eb1a57dd57c64655bbd/src/backends/beads.ts
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  AxiError,
  type ErrorCode,
  isIndeterminate,
  markIndeterminate,
  unsupported,
} from "../errors.js";
import { validateId } from "../id.js";
import type {
  Dep,
  Hold,
  State,
  Task,
  TaskInput,
  TaskLink,
  TaskPatch,
  TaskQuery,
  TaskUpdateChange,
  TaskUpdateResult,
  TransitionOpts,
} from "../model.js";
import { HOLD_KINDS, STATES } from "../model.js";
import type { Capabilities, Store } from "../store.js";
import {
  deriveLinks,
  extractTags,
  leadingKind,
  parseBacklog,
  renderTaskLines,
} from "./markdown-grammar.js";
import {
  atomicWrite,
  canonicalPath,
  reservedPath,
  type LockOptions,
  readFileSafe,
  heldLockFds,
} from "./lock.js";
import { writeMarkdownMirror } from "./markdown-mirror.js";
import {
  assertTransferRemoval,
  registerTransferStore,
  transferCollection,
  withCollectionLock as withLock,
} from "./collection-transfer.js";

export interface BeadsStoreOptions {
  /** Explicit .beads workspace directory or .db file; never auto-discovered. */
  path: string;
  binary?: string;
  /** Only used when initializing a new explicit database. */
  prefix?: string;
  /** Kill an owned br child after this many milliseconds; default 30 seconds. */
  timeoutMs?: number;
  /** Wait this long for the backlog lock; default 120 seconds. */
  lockTimeoutMs?: number;
  /** Bound on show argv bytes per call; tests lower it to force batching. */
  showBatchBytes?: number;
  /** Optional one-way canonical markdown projections; never read as input. */
  mirrorPath?: string;
  mirrorArchivePath?: string;
  doneKeep?: number;
  /** Local YYYY-MM-DD clock, like MarkdownStore. */
  now?: () => string;
}

interface AdapterData {
  version: 1;
  kind?: string;
  repo?: string;
  created: string | null;
  prioritySet: boolean;
  order: number;
  closed?: string;
  meta?: Record<string, unknown>;
  deps?: SavedDep[];
  hold?: Hold;
  /** Exact native labels added by this adapter, not every kind:/repo: label. */
  mirrors?: string[];
  /** Durable caller identity while external_ref is released for native delete. */
  pendingDelete?: string;
}
/** A saved edge also names its target's native id, so a recreated id cannot pass as the old target. */
type SavedDep = Dep & { native?: string };
type Bead = Record<string, unknown>;
interface LoadedTask {
  bead: Bead;
  data: AdapterData;
  task: Task;
}

function record(value: unknown): Bead {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Bead)
    : {};
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function invalid(message: string): never {
  throw new AxiError(message, "VALIDATION_ERROR");
}
function titleValue(value: string): string {
  if (/[\r\n]/.test(value) || !value.trim())
    invalid("Task title must be a non-empty single line");
  const title = value.trim();
  if (extractTags(title).title !== title)
    invalid("Task title must not end with canonical task tags");
  return title;
}
function tagValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (/[(),\r\n]/.test(value))
    invalid(
      "Task kind/repo must be a single line without parentheses or commas",
    );
  return value.trim() || undefined;
}
function dateValue(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    invalid("Task date must be YYYY-MM-DD");
  return value;
}
function priorityValue(value: number | undefined): number | undefined {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || value < 0 || value > 4)
  )
    invalid("Task priority must be an integer 0-4");
  return value;
}
function holdValue(value: Hold | undefined): Hold | undefined {
  if (!value) return undefined;
  if (!value.reason.trim() || /[()\r\n]/.test(value.reason))
    invalid(
      "Task hold reason must be a non-empty single line without parentheses",
    );
  if (value.kind !== undefined && !HOLD_KINDS.includes(value.kind))
    invalid("Invalid task hold kind");
  return {
    reason: value.reason.trim(),
    ...(value.kind ? { kind: value.kind } : {}),
    ...(value.until !== undefined ? { until: dateValue(value.until) } : {}),
  };
}
function appendLink(title: string, link: TaskLink): string {
  const url = link.kind === "pr" ? link.url : link.url.trim();
  if (
    /[\r\n]/.test(link.url) ||
    !deriveLinks(url).some(
      (item) => item.kind === link.kind && item.url === url,
    )
  )
    invalid(`Invalid task ${link.kind} link`);
  return deriveLinks(title).some((item) => item.url === url)
    ? title
    : titleValue(`${title} ${url}`);
}
function prepareInput(input: TaskInput): TaskInput {
  input = {
    ...input,
    id: validateId(input.id),
    title: titleValue(input.title),
    kind: tagValue(input.kind),
    repo: tagValue(input.repo),
    hold: holdValue(input.hold),
    priority: priorityValue(input.priority),
  };
  workerKind(input.kind, input.public_followup);
  if (input.created !== undefined && input.created !== null)
    dateValue(input.created);
  if (input.closed !== undefined) dateValue(input.closed);
  if (input.state !== undefined && !STATES.includes(input.state))
    invalid("Invalid task state");
  for (const link of input.links ?? [])
    input.title = appendLink(input.title, link);
  return input;
}

function workerKind(kind: string | undefined, publicData?: unknown): void {
  if (kind === "public-followup" || publicData !== undefined)
    throw unsupported("public followups", "beads");
}
const DEP_TYPES = {
  "blocked-by": "blocks",
  parent: "parent-child",
  "discovered-from": "discovered-from",
} as const;
function checkedDep(id: string, dep: Dep): Dep {
  const target = validateId(dep.id);
  if (target === id)
    throw new AxiError(
      `Task "${id}" cannot depend on itself`,
      "VALIDATION_ERROR",
    );
  if (!Object.hasOwn(DEP_TYPES, dep.type))
    throw new AxiError("Unknown dependency type", "VALIDATION_ERROR");
  if (
    dep.reason !== undefined &&
    (/[\r\n]/.test(dep.reason) ||
      /(?:^|\s)(?:blocked-by|parent|discovered-from):\s/.test(dep.reason))
  )
    invalid(
      "Dependency reason must be a single line without dependency markers",
    );
  return {
    type: dep.type,
    id: target,
    ...(dep.reason?.trim() ? { reason: dep.reason.trim() } : {}),
  };
}
function nativeData(bead: Bead): Bead {
  const context =
    typeof bead.agent_context === "string"
      ? (JSON.parse(bead.agent_context) as unknown)
      : bead.agent_context;
  return record(record(context).tasks_axi);
}
function adapterData(bead: Bead, id: string): AdapterData {
  try {
    const data = nativeData(bead);
    if (
      data.version !== 1 ||
      typeof data.prioritySet !== "boolean" ||
      typeof data.order !== "number" ||
      !Number.isFinite(data.order)
    )
      throw new Error("Invalid schema");
    if (data.pendingDelete !== undefined && data.pendingDelete !== id)
      throw new Error("Invalid pending deletion identity");
    for (const key of ["kind", "repo"] as const) {
      const value = data[key];
      if (
        value !== undefined &&
        (typeof value !== "string" || tagValue(value) !== value)
      )
        throw new Error("Invalid tag");
    }
    if (data.created !== null && typeof data.created !== "string")
      throw new Error("Invalid created date");
    if (typeof data.created === "string") dateValue(data.created);
    if (data.closed !== undefined) {
      if (typeof data.closed !== "string")
        throw new Error("Invalid closed date");
      dateValue(data.closed);
    }
    if (
      data.meta !== undefined &&
      (data.meta === null ||
        typeof data.meta !== "object" ||
        Array.isArray(data.meta))
    )
      throw new Error("Invalid meta");
    if (data.hold !== undefined) {
      const hold = record(data.hold);
      if (
        typeof hold.reason !== "string" ||
        (hold.until !== undefined && typeof hold.until !== "string")
      )
        throw new Error("Invalid hold");
      holdValue(hold as unknown as Hold);
    }
    if (
      data.mirrors !== undefined &&
      (!Array.isArray(data.mirrors) ||
        !data.mirrors.every((label) => typeof label === "string"))
    )
      throw new Error("Invalid mirrors");
    if (data.deps !== undefined) {
      if (!Array.isArray(data.deps)) throw new Error("Invalid deps");
      for (const dep of data.deps) {
        const edge = record(dep);
        if (
          typeof edge.id !== "string" ||
          typeof edge.type !== "string" ||
          (edge.reason !== undefined && typeof edge.reason !== "string") ||
          (edge.native !== undefined && typeof edge.native !== "string")
        )
          throw new Error("Invalid edge");
        checkedDep(id, edge as unknown as Dep);
      }
    }
    return data as unknown as AdapterData;
  } catch {
    throw new AxiError(
      `Invalid tasks-axi metadata for "${id}"`,
      "VALIDATION_ERROR",
    );
  }
}
function mirrorLabels(task: Pick<Task, "kind" | "repo" | "hold">): string[] {
  return [
    task.kind ? `kind:${task.kind}` : undefined,
    task.repo ? `repo:${task.repo}` : undefined,
    task.hold?.kind === "captain" ? "hold:captain" : undefined,
  ]
    .filter((label): label is string => label !== undefined)
    .map((label) => Array.from(label).slice(0, 50).join(""));
}
function mirrorArgs(
  bead: Bead,
  owned: string[],
  task: Task,
): { args: string[]; owned: string[] } {
  const before = Array.isArray(bead.labels)
    ? bead.labels.filter((label): label is string => typeof label === "string")
    : [];
  const after = mirrorLabels(task);
  const args: string[] = [];
  for (const label of owned) {
    if (before.includes(label) && !after.includes(label))
      args.push("--remove-label", label);
  }
  for (const label of after)
    if (!before.includes(label)) args.push("--add-label", label);
  return {
    args,
    owned: after.filter(
      (label) => owned.includes(label) || !before.includes(label),
    ),
  };
}
const DEFAULT_LOCK_TIMEOUT_MS = 120_000;
const SHOW_ARGV_BYTES = 8192;

function stateOf(value: unknown): State {
  return value === "in_progress"
    ? "in_flight"
    : value === "closed"
      ? "done"
      : "queued";
}

class BrFailure extends Error {
  constructor(
    readonly nativeCode: string,
    message: string,
  ) {
    super(message);
  }
}
function brFailure(output: string): BrFailure {
  try {
    const error = record(record(JSON.parse(output) as unknown).error);
    return new BrFailure(
      text(error.code) ?? "UNKNOWN",
      text(error.message) ?? "br command failed",
    );
  } catch {
    return new BrFailure("UNKNOWN", output.trim() || "br command failed");
  }
}
/**
 * Stream both pipes: large backlogs must not hit execFile's 1 MiB limit.
 * br inherits the descriptors of every kernel lock this chain holds, so the
 * lock outlives this process for as long as br (or anything it runs that
 * keeps the descriptor) can still write. The call settles only once br has
 * exited, so no caller unwinds, releases or rolls back under a live br.
 */
function runBr(
  binary: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  input?: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      ...(env ? { env } : {}),
      stdio: ["pipe", "pipe", "pipe", ...heldLockFds()],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    let timedOut = false;
    let failure: Error | undefined;
    const stop = () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      child.kill("SIGKILL"); // Only the ChildProcess we spawned, never a process-group/PID search.
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    child.on("error", (error) => {
      if (child.pid === undefined) {
        // Never started: nothing can still write.
        clearTimeout(timer);
        reject(error);
        return;
      }
      // Started, then failed: stop it and settle on its exit.
      failure ??= error;
      stop();
    });
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") return;
      failure ??= error;
      stop();
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) {
        reject(markIndeterminate(failure));
        return;
      }
      if (timedOut) {
        reject(
          markIndeterminate(
            new BrFailure(
              "TIMEOUT",
              `br timed out after ${timeoutMs}ms; reread before retrying`,
            ),
          ),
        );
        return;
      }
      if (signal !== null) {
        // Killed from outside: whatever it started may still be finishing.
        reject(
          markIndeterminate(new BrFailure("KILLED", `br killed by ${signal}`)),
        );
        return;
      }
      const out = Buffer.concat(stdout).toString("utf8");
      if (code === 0) resolve(out);
      else
        reject(
          brFailure(
            out.trim() ||
              Buffer.concat(stderr).toString("utf8").trim() ||
              `br exited ${signal ?? code}`,
          ),
        );
    });
    child.stdin?.end(input);
  });
}

export class BeadsStore implements Store {
  private readonly path: string;
  private readonly binary: string;
  private readonly noteArchivePath: string;
  private readonly cwd: string;
  private readonly prefix: string;
  private readonly now: () => string;
  private readonly timeoutMs: number;
  private readonly lockOptions: LockOptions;
  /** Canonical database path: aliases of one database share one lock. */
  private readonly lockKey: string;
  private readonly readyMarker: string;
  private readonly showBatchBytes: number;
  /** Identity of the database file this instance last verified. */
  private verified?: string;
  private readonly mirrorPath?: string;
  private readonly mirrorArchivePath?: string;
  private readonly doneKeep: number;
  /** Error translation only, never a task/read cache. */
  private readonly ids = new Map<string, string>();

  constructor(options: BeadsStoreOptions) {
    if (!options.path?.trim())
      throw new AxiError(
        "An explicit beads database path is required",
        "VALIDATION_ERROR",
      );
    const selected = resolve(options.path);
    this.path =
      extname(selected) === ".db" ? selected : join(selected, "beads.db");
    // init creates .beads relative to cwd, so never run it inside .beads itself.
    this.cwd =
      basename(dirname(this.path)) === ".beads"
        ? dirname(dirname(this.path))
        : dirname(this.path);
    this.noteArchivePath = join(dirname(this.path), "note-archive.md");
    this.lockKey = canonicalPath(this.path);
    this.readyMarker = `${this.lockKey}.tasks-axi-ready`;
    this.showBatchBytes = options.showBatchBytes ?? SHOW_ARGV_BYTES;
    this.binary = options.binary ?? "br";
    this.prefix = options.prefix ?? "tasks";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 2147483647
    )
      invalid("beads.timeout_ms must be an integer between 1 and 2147483647");
    const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(lockTimeoutMs) ||
      lockTimeoutMs < 1 ||
      lockTimeoutMs > 2147483647
    )
      invalid(
        "beads.lock_timeout_ms must be an integer between 1 and 2147483647",
      );
    // Writers queue behind each other, so wait long enough for several
    // complete writes; an abandoned lock is recovered instead of waited out.
    this.lockOptions = { timeoutMs: lockTimeoutMs, kernel: true };
    this.now = options.now ?? today;
    if (
      options.mirrorArchivePath !== undefined &&
      options.mirrorPath === undefined
    )
      invalid("beads.mirror_archive requires beads.mirror");
    for (const path of [options.mirrorPath, options.mirrorArchivePath]) {
      if (path !== undefined && !path.trim())
        invalid("beads mirror paths must not be empty");
    }
    this.mirrorPath = options.mirrorPath
      ? resolve(options.mirrorPath)
      : undefined;
    this.mirrorArchivePath = this.mirrorPath
      ? resolve(
          options.mirrorArchivePath ??
            join(dirname(this.mirrorPath), "done-archive.md"),
        )
      : undefined;
    if (this.mirrorPath && this.mirrorArchivePath) {
      const outputs = [this.mirrorPath, this.mirrorArchivePath].map(
        canonicalPath,
      );
      const protectedPaths = this.writePaths();
      if (
        outputs[0] === outputs[1] ||
        outputs.some((path) => protectedPaths.includes(path))
      )
        invalid(
          "beads mirror paths must be distinct and must not overwrite the database, sidecars, locks or note archive",
        );
      // Another store's lock or marker is just as live as this one's.
      for (const output of outputs) {
        const reason = reservedPath(output);
        if (reason)
          invalid(
            `beads mirror path ${output} names ${reason}; choose a different file`,
          );
      }
    }
    this.doneKeep = options.doneKeep ?? 10;
    if (!Number.isSafeInteger(this.doneKeep) || this.doneKeep < 0)
      invalid("markdown.done_keep must be a non-negative integer");
    registerTransferStore(
      this,
      this.lockKey,
      this.mirrorPath ? () => this.mutate(async () => undefined) : undefined,
      this.lockOptions,
    );
  }

  private writePaths(): string[] {
    return [
      this.path,
      `${this.path}-wal`,
      `${this.path}-shm`,
      `${this.path}-journal`,
      `${this.path}.lock`,
      `${this.path}.init.lock`,
      this.readyMarker,
      this.noteArchivePath,
    ].map(canonicalPath);
  }

  /**
   * Run a write under the backlog lock, then refresh the mirror. An operation
   * that ends holding the post-write graph passes it to `settle`, so the
   * mirror renders from it instead of re-reading every row from br.
   */
  private async mutate<T>(
    operation: (settle: (tasks: LoadedTask[]) => void) => Promise<T>,
  ): Promise<T> {
    return withLock(
      this.lockKey,
      async () => {
        let settled: LoadedTask[] | undefined;
        const result = await operation((tasks) => {
          settled = tasks;
        });
        if (this.mirrorPath && this.mirrorArchivePath) {
          try {
            const tasks = (settled ?? (await this.load())).map(
              (item) => item.task,
            );
            writeMarkdownMirror(
              tasks,
              this.mirrorPath,
              this.mirrorArchivePath,
              this.doneKeep,
            );
          } catch (error) {
            const failure = new AxiError(
              `Beads write succeeded, but markdown mirror refresh failed: ${error instanceof Error ? error.message : String(error)}`,
              "UNKNOWN",
              [
                "The database remains authoritative; fix the mirror path and run tasks-axi render --backend beads",
              ],
            );
            throw isIndeterminate(error) ? markIndeterminate(failure) : failure;
          }
        }
        return result;
      },
      this.lockOptions,
    );
  }

  capabilities(): Capabilities {
    return {
      backend: "beads",
      deps: true,
      prune: false,
      comments: true,
      fullTextSearch: false,
      realtimeSync: false,
      customStates: true,
      serverMintsIds: true,
      collectionTransfer: true,
      publicFollowups: false,
    };
  }

  async transferMany(ids: string[], destination: Store): Promise<Task[]> {
    return transferCollection(this, ids, destination);
  }

  /**
   * A database file existing does not prove `br init` finished, so first use
   * confirms it under the init lock and leaves a marker beside the database.
   */
  /**
   * The database file's identity. Inode numbers are reused after deletion,
   * so the birth time is part of it.
   */
  private identity(): string {
    const stat = statSync(this.path, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}\n`;
  }

  /** True when the ready marker certifies the database file present now. */
  private markerMatches(): boolean {
    const marker = readFileSafe(this.readyMarker);
    if (!marker) return false;
    try {
      return marker === this.identity();
    } catch {
      return false;
    }
  }

  /**
   * First use confirms the database was fully initialized, under the init
   * lock, and binds a ready marker to that database file's identity.
   * br 0.7.6 `init` ignores `--db` and initializes `BEADS_DIR` or
   * `<cwd>/.beads` (and `BEADS_CACHE_DIR` can move the file), so tasks-axi
   * only initializes `<dir>/beads.db`, with `BEADS_DIR` set to that
   * directory and the overrides removed, and verifies where it landed.
   */
  private async ensureInitialized(): Promise<void> {
    // Recheck on every br call: a database replaced or removed under a warm
    // instance must earn the marker again, never inherit the old verdict.
    let current: string | undefined;
    try {
      current = this.identity();
    } catch {
      current = undefined;
    }
    if (current !== undefined && current === this.verified) return;
    this.verified = undefined;
    if (current !== undefined && this.markerMatches()) {
      this.verified = current;
      return;
    }
    await withLock(
      `${this.lockKey}.init`,
      async () => {
        if (this.markerMatches()) return;
        const beadsDir = dirname(this.path);
        // br initializes <BEADS_DIR>/beads.db; no other name can be created.
        const standard = basename(this.path) === "beads.db";
        const init = async (force: boolean) => {
          if (!standard)
            throw new AxiError(
              `tasks-axi can only initialize a beads database named beads.db; initialize ${this.path} with br first`,
              "VALIDATION_ERROR",
            );
          mkdirSync(beadsDir, { recursive: true });
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            BEADS_DIR: beadsDir,
          };
          delete env.BEADS_CACHE_DIR;
          delete env.BEADS_DB;
          await runBr(
            this.binary,
            [
              "--db",
              this.path,
              "init",
              ...(force ? ["--force"] : []),
              "--prefix",
              this.prefix,
              "--json",
            ],
            dirname(beadsDir),
            this.timeoutMs,
            undefined,
            env,
          );
        };
        const verify = async (): Promise<string> => {
          if (!existsSync(this.path) || statSync(this.path).size === 0)
            return "missing";
          const info = record(
            JSON.parse(
              await runBr(
                this.binary,
                ["--db", this.path, "info", "--json"],
                this.cwd,
                this.timeoutMs,
              ),
            ) as unknown,
          );
          const at = text(info.database_path);
          if (!at || canonicalPath(at) !== this.lockKey) return "elsewhere";
          const empty = info.issue_count === 0;
          if (!text(record(info.config).issue_prefix))
            return empty ? "incomplete" : "no prefix, but has issues";
          if (
            standard &&
            empty &&
            !["metadata.json", "config.yaml"].every((name) =>
              existsSync(join(beadsDir, name)),
            )
          )
            return "incomplete";
          return "ok";
        };
        let state = await verify();
        if (state === "missing" || state === "incomplete") {
          await init(existsSync(this.path));
          state = await verify();
        }
        if (state !== "ok")
          throw new AxiError(
            `Beads database ${this.path} is not usable (${state}); repair it with br before using tasks-axi`,
            "UNKNOWN",
          );
        atomicWrite(this.readyMarker, this.identity());
      },
      this.lockOptions,
    );
    this.verified = this.identity();
  }

  private async call(args: string[], input?: string): Promise<unknown> {
    try {
      await this.ensureInitialized();
      // Every subprocess, reads included, is pinned to this exact database.
      const out = await runBr(
        this.binary,
        ["--db", this.path, ...args, "--json"],
        this.cwd,
        this.timeoutMs,
        input,
      );
      return JSON.parse(out || "null") as unknown;
    } catch (error) {
      if (error instanceof AxiError) throw error;
      let message =
        error instanceof Error ? error.message : "br command failed";
      for (const [native, id] of [...this.ids].sort(
        (a, b) => b[0].length - a[0].length,
      ))
        message = message.replaceAll(native, id);
      let code: ErrorCode = "UNKNOWN";
      if (error instanceof BrFailure) {
        if (/CYCLE|INVALID|VALIDATION|SELF/.test(error.nativeCode))
          code = "VALIDATION_ERROR";
        else if (/NOT_FOUND/.test(error.nativeCode)) code = "NOT_FOUND";
        else if (/CONFLICT|ALREADY_EXISTS|DUPLICATE/.test(error.nativeCode))
          code = "CONFLICT";
        else if (/LOCK|BUSY/.test(error.nativeCode)) code = "LOCKED";
      }
      const failure = new AxiError(message, code);
      throw isIndeterminate(error) ? markIndeterminate(failure) : failure;
    }
  }

  /** Project one native record; undefined for rows tasks-axi does not own. */
  private project(value: unknown): LoadedTask | undefined {
    const bead = record(value);
    const ref = text(bead.external_ref);
    if (bead.status === "tombstone") return undefined;
    let callerId = ref?.startsWith("tasks-axi:")
      ? ref.slice("tasks-axi:".length)
      : undefined;
    if (callerId === undefined && ref === undefined) {
      // A failed/interrupted delete must remain addressable, not look absent.
      try {
        callerId = text(nativeData(bead).pendingDelete);
      } catch {
        return undefined;
      }
    }
    if (callerId === undefined) return undefined;
    const id = validateId(callerId);
    if (typeof bead.id !== "string") invalid(`Invalid native id for "${id}"`);
    this.ids.set(bead.id, id);
    const data = adapterData(bead, id);
    workerKind(data.kind);
    const title = text(bead.title) ?? id;
    const task: Task = {
      id,
      title,
      state: stateOf(bead.status),
      links: deriveLinks(title),
      deps: [],
    };
    const kind = data.kind ?? leadingKind(title);
    if (kind) task.kind = kind;
    if (data.repo) task.repo = data.repo;
    if (data.meta) task.meta = data.meta;
    if (data.hold) task.hold = { ...data.hold };
    if (text(bead.description)) task.body = text(bead.description);
    // Match markdown's read projection: Done renders only its closed stamp.
    if (data.created && task.state !== "done") task.created = data.created;
    // Hide only br's implicit default, never a non-default native priority.
    if (
      (data.prioritySet || bead.priority !== 2) &&
      typeof bead.priority === "number"
    )
      task.priority = bead.priority;
    if (task.state === "done" && data.closed) task.closed = data.closed;
    return { bead, data, task };
  }

  /** Native edges are authoritative; saved reasons and order decorate them. */
  private attachDeps(
    loaded: LoadedTask,
    detail: Bead,
    byNative: Map<unknown, LoadedTask>,
  ): void {
    const deps: Dep[] = [];
    for (const value of Array.isArray(detail.dependencies)
      ? detail.dependencies
      : []) {
      const edge = record(value);
      const type = (Object.keys(DEP_TYPES) as Dep["type"][]).find(
        (key) => DEP_TYPES[key] === edge.dependency_type,
      );
      if (!type) continue;
      const target = byNative.get(edge.id);
      // The Store graph contains caller-owned tasks only. Native-only
      // relationships are left untouched, but cannot expose native ids here.
      if (!target) continue;
      const saved = loaded.data.deps?.find(
        (dep) => dep.type === type && dep.id === target.task.id,
      );
      deps.push({
        type,
        id: target.task.id,
        ...(saved?.reason ? { reason: saved.reason } : {}),
      });
    }
    const order = (dep: Dep) =>
      loaded.data.deps?.findIndex(
        (saved) => saved.type === dep.type && saved.id === dep.id,
      ) ?? -1;
    loaded.task.deps = deps.sort((a, b) => order(a) - order(b));
  }

  private async show(ids: string[]): Promise<Bead[]> {
    // Bound UTF-8 argv bytes, well below platform (Windows) command-line limits.
    const batches: string[][] = [];
    let batch: string[] = [];
    let bytes = 0;
    for (const id of ids) {
      const size = Buffer.byteLength(id) + 1;
      if (batch.length && bytes + size > this.showBatchBytes) {
        batches.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(id);
      bytes += size;
    }
    if (batch.length) batches.push(batch);
    const shown: Bead[] = [];
    for (const ids of batches) {
      const details = await this.call(["show", ...ids]);
      if (!Array.isArray(details))
        throw new AxiError("br show returned invalid issues", "UNKNOWN");
      shown.push(...details.map(record));
    }
    return shown;
  }

  private sorted(result: LoadedTask[]): LoadedTask[] {
    if (new Set(result.map((item) => item.task.id)).size !== result.length) {
      throw new AxiError(
        "Duplicate tasks-axi external references in beads",
        "CONFLICT",
      );
    }
    const states: State[] = ["in_flight", "queued", "done"];
    return result.sort(
      (a, b) =>
        states.indexOf(a.task.state) - states.indexOf(b.task.state) ||
        a.data.order - b.data.order,
    );
  }

  /**
   * One `list` for every row, plus `show` only for rows whose native edge
   * count disagrees with the edges the adapter saved (`list` reports the
   * count but not the edges).
   */
  private async load(): Promise<LoadedTask[]> {
    const raw = record(await this.call(["list", "--all", "--limit", "0"]));
    if (!Array.isArray(raw.issues))
      throw new AxiError("br list returned invalid issues", "UNKNOWN");
    const result: LoadedTask[] = [];
    for (const value of raw.issues) {
      const loaded = this.project(value);
      if (loaded) result.push(loaded);
    }
    this.sorted(result);
    const byId = new Map(result.map((item) => [item.task.id, item]));
    const linked: LoadedTask[] = [];
    for (const item of result) {
      const count = item.bead.dependency_count;
      if (count === 0) continue;
      // The adapter saves every edge it writes. While br's own edge count
      // agrees and every saved target is managed, the saved list is the native
      // edge set; any native add, remove, deleted target or unmanaged edge
      // changes the count and sends that row to an authoritative show.
      const saved = item.data.deps ?? [];
      if (
        count === saved.length &&
        saved.every(
          (dep) =>
            dep.native !== undefined &&
            byId.get(dep.id)?.bead.id === dep.native,
        )
      ) {
        item.task.deps = saved.map((dep) => ({
          type: dep.type,
          id: dep.id,
          ...(dep.reason ? { reason: dep.reason } : {}),
        }));
        continue;
      }
      linked.push(item);
    }
    if (linked.length) {
      const shown = await this.show(linked.map((item) => String(item.bead.id)));
      const shownIds = new Set(shown.map((item) => item.id));
      if (linked.some((item) => !shownIds.has(item.bead.id)))
        throw new AxiError(
          "Beads graph changed while reading; retry",
          "CONFLICT",
        );
      const byNative = new Map(result.map((item) => [item.bead.id, item]));
      for (const detail of shown) {
        const loaded = byNative.get(detail.id);
        if (!loaded) continue;
        if (loaded.bead.updated_at !== detail.updated_at)
          throw new AxiError(
            "Beads task changed while reading; retry",
            "CONFLICT",
          );
        this.attachDeps(loaded, detail, byNative);
      }
    }
    return result;
  }

  /**
   * The locked snapshot with one row re-read from br. Each adapter write
   * changes only its own row's fields and edges (an edge lives on the
   * dependent), so this equals a full reload without re-reading every row.
   */
  private async reread(
    all: LoadedTask[],
    nativeId: string,
  ): Promise<LoadedTask[]> {
    const [detail] = await this.show([nativeId]);
    const others = all.filter((item) => item.bead.id !== nativeId);
    const loaded = detail?.id === nativeId ? this.project(detail) : undefined;
    if (!loaded) return others;
    const byNative = new Map(
      [...others, loaded].map((item) => [item.bead.id, item]),
    );
    this.attachDeps(loaded, detail, byNative);
    return this.sorted([...others, loaded]);
  }

  /**
   * Public reads hold the same lock as writes: one br list is not a snapshot
   * (br reads rows and edge counts separately), so an unlocked read could see
   * a row from before a write with counts from after it.
   */
  private locked<T>(read: () => Promise<T>): Promise<T> {
    return withLock(this.lockKey, read, this.lockOptions);
  }

  async isEmpty(): Promise<boolean> {
    const raw = record(
      await this.locked(() => this.call(["list", "--all", "--limit", "0"])),
    );
    if (!Array.isArray(raw.issues))
      throw new AxiError("br list returned invalid issues", "UNKNOWN");
    return raw.issues.every((value) => record(value).status === "tombstone");
  }

  async get(id: string): Promise<Task | null> {
    return (
      (await this.locked(() => this.load())).find((item) => item.task.id === id)
        ?.task ?? null
    );
  }
  async list(query: TaskQuery): Promise<{ items: Task[]; total: number }> {
    let items = (await this.locked(() => this.load())).map((item) => item.task);
    if (query.state) items = items.filter((task) => task.state === query.state);
    if (query.repo) items = items.filter((task) => task.repo === query.repo);
    if (query.kind) items = items.filter((task) => task.kind === query.kind);
    const total = items.length;
    if (query.limit !== undefined && query.limit >= 0)
      items = items.slice(0, query.limit);
    return { items, total };
  }
  validateImport(tasks: Task[], readOnlyPaths: string[] = []): void {
    const outputs = this.writePaths();
    for (const path of [this.mirrorPath, this.mirrorArchivePath])
      if (path) outputs.push(canonicalPath(path));
    if (readOnlyPaths.map(canonicalPath).some((path) => outputs.includes(path)))
      invalid(
        "Migration destination and mirrors must not overwrite a source markdown file",
      );
    for (const task of tasks) {
      const input = prepareInput(task);
      const normalized: Task = {
        ...task,
        ...input,
        state: task.state,
        created: input.created ?? undefined,
        links: deriveLinks(input.title),
        deps: task.deps.map((dep) => checkedDep(task.id, dep)),
      };
      const label = { in_flight: "In flight", queued: "Queued", done: "Done" }[
        task.state
      ];
      const parsed = parseBacklog(
        `## ${label}\n${renderTaskLines(normalized).join("\n")}\n`,
      );
      const entry = parsed.sections[0]?.entries.find(
        (entry) => entry.kind === "task",
      );
      if (
        entry?.kind !== "task" ||
        !isDeepStrictEqual(
          JSON.parse(JSON.stringify(task)),
          JSON.parse(JSON.stringify(entry.task)),
        )
      )
        invalid(
          `Source task "${task.id}" cannot be imported without normalizing its fields`,
        );
    }
  }

  async create(input: TaskInput): Promise<Task> {
    input = prepareInput(input);
    return this.mutate(async (settle) => {
      const id = validateId(input.id);
      const all = await this.load();
      if (all.some((item) => item.task.id === id))
        throw new AxiError(`Task "${id}" already exists`, "CONFLICT");
      const deps = (input.deps ?? []).map((dep) => checkedDep(id, dep));
      const nativeDeps: string[] = [];
      const targets = new Set<string>();
      for (const dep of deps) {
        if (targets.has(dep.id))
          invalid("Beads supports only one dependency per task pair");
        targets.add(dep.id);
        nativeDeps.push(
          `${DEP_TYPES[dep.type]}:${String(this.dependency(all, dep.id).bead.id)}`,
        );
      }
      const state = input.state ?? "queued";
      const positions = all
        .filter((item) => item.task.state === state)
        .map((item) => item.data.order);
      const data: AdapterData = {
        version: 1,
        kind: input.kind,
        repo: input.repo,
        created:
          input.created !== undefined
            ? input.created
            : state === "done"
              ? null
              : dateValue(this.now()),
        prioritySet: input.priority !== undefined,
        closed: input.closed,
        deps: this.saved(all, deps),
        hold: input.hold,
        meta: input.meta,
        order:
          state === "in_flight"
            ? Math.min(0, ...positions) - 1
            : Math.max(0, ...positions) + 1,
      };
      const kind = input.kind ?? leadingKind(input.title);
      const mirrors = mirrorLabels({ ...input, kind });
      data.mirrors = mirrors;
      const created = record(
        await this.call(
          [
            "create",
            ...(nativeDeps.length ? ["--deps", nativeDeps.join(",")] : []),
            ...(mirrors.length ? ["--labels", mirrors.join(",")] : []),
            ...(input.hold?.until ? ["--defer", input.hold.until] : []),
            "--title",
            input.title,
            "--slug",
            id,
            "--external-ref",
            `tasks-axi:${id}`,
            "--type",
            "task",
            "--status",
            state === "done"
              ? "closed"
              : state === "in_flight"
                ? "in_progress"
                : "open",
            "--description-file",
            "-",
            "--priority",
            String(input.priority ?? 2),
            "--agent-context",
            JSON.stringify({ tasks_axi: data }),
          ],
          input.body ?? "",
        ),
      );
      const task: Task = {
        id,
        title: input.title,
        state,
        links: deriveLinks(input.title),
        deps,
      };
      if (kind) task.kind = kind;
      if (input.repo) task.repo = input.repo;
      if (input.body) task.body = input.body;
      if (input.hold) task.hold = input.hold;
      if (input.priority !== undefined) task.priority = input.priority;
      if (data.created) task.created = data.created;
      if (input.closed) task.closed = input.closed;
      if (input.meta) task.meta = input.meta;
      if (typeof created.id !== "string")
        throw new AxiError("br create returned no issue id", "UNKNOWN");
      settle(await this.verifyTask(task, all, created.id));
      return task;
    });
  }
  private required(all: LoadedTask[], id: string): LoadedTask {
    const found = all.find((item) => item.task.id === id);
    if (!found) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    return found;
  }

  /** Edges to save in adapter metadata, each with its target's native id. */
  private saved(all: LoadedTask[], deps: Dep[]): SavedDep[] {
    return deps.map((dep) => {
      const target = all.find((item) => item.task.id === dep.id);
      return target ? { ...dep, native: String(target.bead.id) } : dep;
    });
  }

  private dependency(all: LoadedTask[], id: string): LoadedTask {
    const found = all.find((item) => item.task.id === id);
    if (!found) invalid(`Dependency "${id}" not found`);
    return found;
  }

  /** Verify persistence, but return computed mutations to retain markdown's immediate-result dates. */
  private async verifyTask(
    expected: Task,
    all: LoadedTask[],
    nativeId: string,
  ): Promise<LoadedTask[]> {
    const after = await this.reread(all, nativeId);
    const actual = this.required(after, expected.id).task;
    const wanted = {
      ...expected,
      kind: expected.kind ?? leadingKind(expected.title),
    };
    delete wanted.updated;
    if (wanted.state === "done") delete wanted.created;
    else delete wanted.closed;
    for (const [field, value] of Object.entries(wanted)) {
      const serialized =
        value === undefined
          ? undefined
          : (JSON.parse(JSON.stringify(value)) as unknown);
      if (!isDeepStrictEqual(actual[field as keyof Task], serialized))
        throw new AxiError(
          `Beads did not persist ${field} for "${expected.id}"; reread before retrying`,
          "CONFLICT",
        );
    }
    return after;
  }

  private context(bead: Bead, data: AdapterData): string {
    const context =
      typeof bead.agent_context === "string"
        ? (JSON.parse(bead.agent_context) as unknown)
        : bead.agent_context;
    return JSON.stringify({ ...record(context), tasks_axi: data });
  }

  async update(id: string, patch: TaskPatch): Promise<TaskUpdateResult> {
    patch = {
      ...patch,
      ...(patch.title !== undefined ? { title: titleValue(patch.title) } : {}),
      ...(patch.repo !== undefined ? { repo: tagValue(patch.repo) ?? "" } : {}),
      ...(patch.kind !== undefined ? { kind: tagValue(patch.kind) ?? "" } : {}),
      ...(patch.hold !== undefined
        ? { hold: holdValue(patch.hold ?? undefined) ?? null }
        : {}),
      priority: priorityValue(patch.priority),
    };
    workerKind(patch.kind);
    return this.mutate(async (settle) => {
      const all = await this.load();
      const found = this.required(all, id);
      const task = { ...found.task };
      const changed: TaskUpdateChange[] = [];
      const mark = (field: TaskUpdateChange) => {
        if (!changed.includes(field)) changed.push(field);
      };
      if (patch.title !== undefined && task.title !== patch.title.trim()) {
        task.title = patch.title.trim();
        mark("title");
      }
      const oldBody = task.body;
      if (patch.body !== undefined && task.body !== (patch.body || undefined)) {
        task.body = patch.body || undefined;
        mark("body");
      }
      for (const line of patch.addBodyLines ?? []) {
        if (line !== "" && !task.body?.split("\n").includes(line)) {
          task.body = task.body ? `${task.body}\n${line}` : line;
          mark("body");
        }
      }
      if (
        patch.repo !== undefined &&
        task.repo !== (patch.repo.trim() || undefined)
      ) {
        task.repo = patch.repo.trim() || undefined;
        mark("repo");
      }
      const explicitKind =
        patch.kind !== undefined ? patch.kind || undefined : found.data.kind;
      if (
        patch.kind !== undefined &&
        (found.data.kind !== explicitKind ||
          task.kind !== (explicitKind ?? leadingKind(task.title)))
      )
        mark("kind");
      task.kind = explicitKind ?? leadingKind(task.title);
      if (
        patch.hold !== undefined &&
        JSON.stringify(task.hold) !== JSON.stringify(patch.hold ?? undefined)
      ) {
        task.hold = patch.hold ?? undefined;
        mark("hold");
      }
      if (patch.priority !== undefined && task.priority !== patch.priority) {
        task.priority = patch.priority;
        mark("priority");
      }
      if (patch.meta) {
        const meta = { ...task.meta, ...patch.meta };
        if (JSON.stringify(meta) !== JSON.stringify(task.meta)) {
          task.meta = meta;
          mark("meta");
        }
      }
      for (const link of patch.addLinks ?? []) {
        const title = appendLink(task.title, link);
        if (title !== task.title) {
          task.title = title;
          mark("links");
        }
      }
      if (!changed.length) {
        settle(all);
        return { task: found.task, changed };
      }
      const mirrors = mirrorArgs(
        found.bead,
        found.data.mirrors ?? mirrorLabels(found.task),
        task,
      );
      const data: AdapterData = {
        ...found.data,
        mirrors: mirrors.owned,
        kind: explicitKind,
        repo: task.repo,
        meta: task.meta,
        hold: task.hold,
        prioritySet: found.data.prioritySet || patch.priority !== undefined,
      };
      const args = [
        "update",
        String(found.bead.id),
        "--force",
        "--agent-context",
        this.context(found.bead, data),
      ];
      if (changed.includes("title") || changed.includes("links"))
        args.push("--title", task.title);
      if (changed.includes("body")) args.push("--description-file", "-");
      if (changed.includes("priority"))
        args.push("--priority", String(task.priority));
      if (changed.includes("hold"))
        args.push("--defer", task.hold?.until ?? "");
      args.push(...mirrors.args);
      // Archive before replacement: a failed replacement cannot lose the prior notes.
      if (
        patch.archiveBody &&
        patch.body !== undefined &&
        oldBody !== (patch.body || undefined) &&
        oldBody !== undefined
      ) {
        const comments = await this.call([
          "comments",
          "list",
          String(found.bead.id),
        ]);
        if (!Array.isArray(comments))
          throw new AxiError("br comments returned invalid records", "UNKNOWN");
        if (!comments.some((comment) => record(comment).text === oldBody))
          await this.call(
            ["comments", "add", String(found.bead.id), "-f", "-"],
            oldBody,
          );
        await withLock(
          canonicalPath(this.noteArchivePath),
          () => {
            const existing = readFileSafe(this.noteArchivePath) ?? "";
            const lines = renderTaskLines(found.task).join("\n");
            if (!existing.includes(`\n${lines}\n`))
              atomicWrite(
                this.noteArchivePath,
                `${existing}\n## Archived ${this.now()}\n${lines}\n`,
              );
          },
          this.lockOptions,
        );
        mark("archive");
      }
      await this.call(
        args,
        changed.includes("body") ? (task.body ?? "") : undefined,
      );
      task.links = deriveLinks(task.title);
      task.updated = this.now();
      settle(await this.verifyTask(task, all, String(found.bead.id)));
      return { task, changed };
    });
  }
  async remove(id: string): Promise<Task> {
    // A delete can change other rows' visible edges: let mutate reload.
    return this.mutate(async () => {
      const all = await this.load();
      const found = this.required(all, id);
      assertTransferRemoval(this, found.task);
      const dependents = all.filter(
        (item) =>
          item.task.state !== "done" &&
          item.task.deps.some(
            (dep) => dep.type === "blocked-by" && dep.id === id,
          ),
      );
      if (dependents.length)
        throw new AxiError(
          `Task "${id}" is still blocking active tasks: ${dependents.map((item) => item.task.id).join(", ")}`,
          "VALIDATION_ERROR",
        );
      // Release uniqueness and record recovery identity in the SAME native write.
      // Even if deletion and compensation both fail, load() can find this task.
      await this.call([
        "update",
        String(found.bead.id),
        "--force",
        "--external-ref",
        "",
        "--agent-context",
        this.context(found.bead, { ...found.data, pendingDelete: id }),
      ]);
      try {
        await this.call(["delete", String(found.bead.id), "--force"]);
      } catch (error) {
        // The delete may still land: issue nothing more against this row.
        // pendingDelete keeps it addressable, so a retry can finish it.
        if (isIndeterminate(error)) throw error;
        await this.call([
          "update",
          String(found.bead.id),
          "--force",
          "--external-ref",
          `tasks-axi:${id}`,
          "--agent-context",
          this.context(found.bead, { ...found.data, pendingDelete: undefined }),
        ]);
        throw error;
      }
      return found.task;
    });
  }
  async transition(
    id: string,
    to: State,
    opts: TransitionOpts = {},
  ): Promise<Task> {
    return this.mutate(async (settle) => {
      const all = await this.load();
      const found = this.required(all, id);
      if (!STATES.includes(to)) invalid("Invalid task state");
      const date = dateValue(opts.date ?? this.now());
      let title = found.task.title;
      if (opts.pr !== undefined)
        title = appendLink(title, { kind: "pr", url: opts.pr });
      if (opts.report !== undefined)
        title = appendLink(title, { kind: "report", url: opts.report });
      const positions = all
        .filter((item) => item.task.state === to)
        .map((item) => item.data.order);
      const data: AdapterData = {
        ...found.data,
        created:
          found.data.created ??
          (to === "in_flight" || (found.task.state === "done" && to !== "done")
            ? date
            : null),
        closed: to === "done" ? (found.data.closed ?? date) : undefined,
        order:
          to === "queued"
            ? Math.max(0, ...positions) + 1
            : Math.min(0, ...positions) - 1,
      };
      const args = [
        "update",
        String(found.bead.id),
        "--force",
        "--title",
        title,
        "--agent-context",
        this.context(found.bead, data),
      ];
      if (to !== "done")
        args.push("--status", to === "in_flight" ? "in_progress" : "open");
      const body =
        opts.note &&
        !`\n${found.task.body ?? ""}\n`.includes(`\n${opts.note}\n`)
          ? found.task.body
            ? `${found.task.body}\n${opts.note}`
            : opts.note
          : undefined;
      if (body !== undefined) args.push("--description-file", "-");
      await this.call(args, body);
      if (to === "done")
        await this.call(["close", String(found.bead.id), "--force"]);
      const task: Task = {
        ...found.task,
        title,
        links: deriveLinks(title),
        state: to,
        body: body ?? found.task.body,
        created: data.created ?? undefined,
        closed: data.closed,
        updated: this.now(),
      };
      settle(await this.verifyTask(task, all, String(found.bead.id)));
      return task;
    });
  }
  async addDep(id: string, dep: Dep): Promise<boolean> {
    const checked = checkedDep(id, dep);
    return this.mutate(async (settle) => {
      const all = await this.load();
      const found = this.required(all, id);
      if (
        found.task.deps.some(
          (edge) => edge.type === checked.type && edge.id === checked.id,
        )
      ) {
        settle(all);
        return false;
      }
      const target = this.dependency(all, checked.id);
      if (found.task.deps.some((edge) => edge.id === checked.id))
        invalid("Beads supports only one dependency per task pair");
      // Persist the reason before adding the edge. A retry can finish an
      // absent native edge; it must never mistake an edge with a lost reason
      // for a complete operation. Unattached metadata is invisible to reads.
      const deps = [...found.task.deps, checked];
      const data = { ...found.data, deps: this.saved(all, deps) };
      await this.call([
        "update",
        String(found.bead.id),
        "--force",
        "--agent-context",
        this.context(found.bead, data),
      ]);
      await this.call([
        "dep",
        "add",
        String(found.bead.id),
        String(target.bead.id),
        "--type",
        DEP_TYPES[checked.type],
      ]);
      settle(
        await this.verifyTask(
          { ...found.task, deps },
          all,
          String(found.bead.id),
        ),
      );
      return true;
    });
  }
  async removeDep(id: string, dep: Dep): Promise<boolean> {
    const checked = checkedDep(id, dep);
    return this.mutate(async (settle) => {
      const all = await this.load();
      const found = this.required(all, id);
      if (
        !found.task.deps.some(
          (edge) => edge.type === checked.type && edge.id === checked.id,
        )
      ) {
        settle(all);
        return false;
      }
      const target = this.required(all, checked.id);
      await this.call([
        "dep",
        "remove",
        String(found.bead.id),
        String(target.bead.id),
      ]);
      const deps = found.task.deps.filter(
        (edge) => edge.type !== checked.type || edge.id !== checked.id,
      );
      const data = { ...found.data, deps: this.saved(all, deps) };
      await this.call([
        "update",
        String(found.bead.id),
        "--force",
        "--agent-context",
        this.context(found.bead, data),
      ]);
      settle(
        await this.verifyTask(
          { ...found.task, deps },
          all,
          String(found.bead.id),
        ),
      );
      return true;
    });
  }
  async render(): Promise<number> {
    if (!this.mirrorPath)
      throw unsupported("render without beads.mirror", "beads");
    return this.mutate(async (settle) => {
      const all = await this.load();
      settle(all);
      return all.length;
    });
  }

  async updatePublicFollowup(): Promise<Task> {
    throw unsupported("public followups", "beads");
  }
}
