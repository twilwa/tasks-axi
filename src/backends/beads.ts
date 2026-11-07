/**
 * beads_rust (br) adapter. Native ids are implementation details: external_ref
 * owns the caller's join key, and description is always the unadorned body.
 * Port of the bd Store concepts from RooseveltAdvisors/tasks-axi (MIT):
 * https://github.com/RooseveltAdvisors/tasks-axi/blob/8c6f96eb58924fd094053eb1a57dd57c64655bbd/src/backends/beads.ts
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AxiError, type ErrorCode, unsupported } from "../errors.js";
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
import { atomicWrite, canonicalPath, readFileSafe } from "./lock.js";
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
  deps?: Dep[];
  hold?: Hold;
  /** Exact native labels added by this adapter, not every kind:/repo: label. */
  mirrors?: string[];
  /** Durable caller identity while external_ref is released for native delete. */
  pendingDelete?: string;
}
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
          (edge.reason !== undefined && typeof edge.reason !== "string")
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
/** Stream both pipes: large backlogs must not hit execFile's 1 MiB limit. */
function runBr(
  binary: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin.destroy();
      child.kill("SIGKILL"); // Only the ChildProcess we spawned, never a process-group/PID search.
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new BrFailure(
            "TIMEOUT",
            `br timed out after ${timeoutMs}ms; reread before retrying`,
          ),
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
    child.stdin.end(input);
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
    this.binary = options.binary ?? "br";
    this.prefix = options.prefix ?? "tasks";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 2147483647
    )
      invalid("beads.timeout_ms must be an integer between 1 and 2147483647");
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
    }
    this.doneKeep = options.doneKeep ?? 10;
    if (!Number.isSafeInteger(this.doneKeep) || this.doneKeep < 0)
      invalid("markdown.done_keep must be a non-negative integer");
    registerTransferStore(this, this.path);
  }

  private writePaths(): string[] {
    return [
      this.path,
      `${this.path}-wal`,
      `${this.path}-shm`,
      `${this.path}-journal`,
      `${this.path}.lock`,
      `${this.path}.init.lock`,
      this.noteArchivePath,
    ].map(canonicalPath);
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    return withLock(this.path, async () => {
      const result = await operation();
      if (this.mirrorPath && this.mirrorArchivePath) {
        try {
          const tasks = (await this.load()).map((item) => item.task);
          writeMarkdownMirror(
            tasks,
            this.mirrorPath,
            this.mirrorArchivePath,
            this.doneKeep,
          );
        } catch (error) {
          throw new AxiError(
            `Beads write succeeded, but markdown mirror refresh failed: ${error instanceof Error ? error.message : String(error)}`,
            "UNKNOWN",
            [
              "The database remains authoritative; fix the mirror path and run tasks-axi render --backend beads",
            ],
          );
        }
      }
      return result;
    });
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

  private async call(args: string[], input?: string): Promise<unknown> {
    try {
      if (!existsSync(this.path)) {
        await withLock(`${this.path}.init`, async () => {
          if (existsSync(this.path)) return;
          mkdirSync(dirname(this.path), { recursive: true });
          await runBr(
            this.binary,
            ["--db", this.path, "init", "--prefix", this.prefix, "--json"],
            this.cwd,
            this.timeoutMs,
          );
        });
      }
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
      throw new AxiError(message, code);
    }
  }

  private async load(): Promise<LoadedTask[]> {
    const raw = record(await this.call(["list", "--all", "--limit", "0"]));
    if (!Array.isArray(raw.issues))
      throw new AxiError("br list returned invalid issues", "UNKNOWN");
    const result: LoadedTask[] = [];
    for (const value of raw.issues) {
      const bead = record(value);
      const ref = text(bead.external_ref);
      if (bead.status === "tombstone") continue;
      let callerId = ref?.startsWith("tasks-axi:")
        ? ref.slice("tasks-axi:".length)
        : undefined;
      if (callerId === undefined && ref === undefined) {
        // A failed/interrupted delete must remain addressable, not look absent.
        try {
          callerId = text(nativeData(bead).pendingDelete);
        } catch {
          continue;
        }
      }
      if (callerId === undefined) continue;
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
      result.push({ bead, data, task });
    }
    if (new Set(result.map((item) => item.task.id)).size !== result.length) {
      throw new AxiError(
        "Duplicate tasks-axi external references in beads",
        "CONFLICT",
      );
    }
    if (result.length) {
      // Bound both ID count and UTF-8 bytes, well below platform argv limits.
      const batches: string[][] = [];
      let batch: string[] = [];
      let bytes = 0;
      for (const item of result) {
        const id = String(item.bead.id);
        const size = Buffer.byteLength(id) + 1;
        if (batch.length && (batch.length >= 64 || bytes + size > 8192)) {
          batches.push(batch);
          batch = [];
          bytes = 0;
        }
        batch.push(id);
        bytes += size;
      }
      if (batch.length) batches.push(batch);
      const shown: unknown[] = [];
      for (const ids of batches) {
        const details = await this.call(["show", ...ids]);
        if (!Array.isArray(details))
          throw new AxiError("br show returned invalid issues", "UNKNOWN");
        shown.push(...details);
      }
      const shownIds = new Set(shown.map((item) => record(item).id));
      if (result.some((item) => !shownIds.has(item.bead.id)))
        throw new AxiError(
          "Beads graph changed while reading; retry",
          "CONFLICT",
        );
      const byNative = new Map(result.map((item) => [item.bead.id, item]));
      for (const value of shown) {
        const detail = record(value);
        const loaded = byNative.get(detail.id);
        if (!loaded) continue;
        if (loaded.bead.updated_at !== detail.updated_at)
          throw new AxiError(
            "Beads task changed while reading; retry",
            "CONFLICT",
          );
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
    }
    const states: State[] = ["in_flight", "queued", "done"];
    return result.sort(
      (a, b) =>
        states.indexOf(a.task.state) - states.indexOf(b.task.state) ||
        a.data.order - b.data.order,
    );
  }

  async isEmpty(): Promise<boolean> {
    const raw = record(await this.call(["list", "--all", "--limit", "0"]));
    if (!Array.isArray(raw.issues))
      throw new AxiError("br list returned invalid issues", "UNKNOWN");
    return raw.issues.every((value) => record(value).status === "tombstone");
  }

  async get(id: string): Promise<Task | null> {
    return (
      (await this.load()).find((item) => item.task.id === id)?.task ?? null
    );
  }
  async list(query: TaskQuery): Promise<{ items: Task[]; total: number }> {
    let items = (await this.load()).map((item) => item.task);
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
    return this.mutate(async () => {
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
        deps,
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
      await this.verifyTask(task);
      return task;
    });
  }
  private required(all: LoadedTask[], id: string): LoadedTask {
    const found = all.find((item) => item.task.id === id);
    if (!found) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
    return found;
  }

  private dependency(all: LoadedTask[], id: string): LoadedTask {
    const found = all.find((item) => item.task.id === id);
    if (!found) invalid(`Dependency "${id}" not found`);
    return found;
  }

  /** Verify persistence, but return computed mutations to retain markdown's immediate-result dates. */
  private async verifyTask(expected: Task): Promise<void> {
    const actual = this.required(await this.load(), expected.id).task;
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
    return this.mutate(async () => {
      const found = this.required(await this.load(), id);
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
      if (!changed.length) return { task: found.task, changed };
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
        await withLock(this.noteArchivePath, () => {
          const existing = readFileSafe(this.noteArchivePath) ?? "";
          const lines = renderTaskLines(found.task).join("\n");
          if (!existing.includes(`\n${lines}\n`))
            atomicWrite(
              this.noteArchivePath,
              `${existing}\n## Archived ${this.now()}\n${lines}\n`,
            );
        });
        mark("archive");
      }
      await this.call(
        args,
        changed.includes("body") ? (task.body ?? "") : undefined,
      );
      task.links = deriveLinks(task.title);
      task.updated = this.now();
      await this.verifyTask(task);
      return { task, changed };
    });
  }
  async remove(id: string): Promise<Task> {
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
    return this.mutate(async () => {
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
      await this.verifyTask(task);
      return task;
    });
  }
  async addDep(id: string, dep: Dep): Promise<boolean> {
    const checked = checkedDep(id, dep);
    return this.mutate(async () => {
      const all = await this.load();
      const found = this.required(all, id);
      if (
        found.task.deps.some(
          (edge) => edge.type === checked.type && edge.id === checked.id,
        )
      )
        return false;
      const target = this.dependency(all, checked.id);
      if (found.task.deps.some((edge) => edge.id === checked.id))
        invalid("Beads supports only one dependency per task pair");
      // Persist the reason before adding the edge. A retry can finish an
      // absent native edge; it must never mistake an edge with a lost reason
      // for a complete operation. Unattached metadata is invisible to reads.
      const data = { ...found.data, deps: [...found.task.deps, checked] };
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
      await this.verifyTask({ ...found.task, deps: data.deps });
      return true;
    });
  }
  async removeDep(id: string, dep: Dep): Promise<boolean> {
    const checked = checkedDep(id, dep);
    return this.mutate(async () => {
      const all = await this.load();
      const found = this.required(all, id);
      if (
        !found.task.deps.some(
          (edge) => edge.type === checked.type && edge.id === checked.id,
        )
      )
        return false;
      const target = this.required(all, checked.id);
      await this.call([
        "dep",
        "remove",
        String(found.bead.id),
        String(target.bead.id),
      ]);
      const data = {
        ...found.data,
        deps: found.task.deps.filter(
          (edge) => edge.type !== checked.type || edge.id !== checked.id,
        ),
      };
      await this.call([
        "update",
        String(found.bead.id),
        "--force",
        "--agent-context",
        this.context(found.bead, data),
      ]);
      await this.verifyTask({ ...found.task, deps: data.deps });
      return true;
    });
  }
  async render(): Promise<number> {
    if (!this.mirrorPath)
      throw unsupported("render without beads.mirror", "beads");
    return this.mutate(async () => (await this.load()).length);
  }

  async updatePublicFollowup(): Promise<Task> {
    throw unsupported("public followups", "beads");
  }
}
