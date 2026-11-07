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
import { deriveLinks, extractTags, leadingKind } from "./markdown-grammar.js";
import { withLock } from "./lock.js";

export interface BeadsStoreOptions {
  /** Explicit .beads workspace directory or .db file; never auto-discovered. */
  path: string;
  binary?: string;
  /** Only used when initializing a new explicit database. */
  prefix?: string;
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
  if (/[()\r\n]/.test(value))
    invalid("Task kind/repo must be a single line without parentheses");
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
function adapterData(bead: Bead, id: string): AdapterData {
  try {
    const context =
      typeof bead.agent_context === "string"
        ? (JSON.parse(bead.agent_context) as unknown)
        : bead.agent_context;
    const data = record(record(context).tasks_axi);
    if (
      data.version !== 1 ||
      typeof data.prioritySet !== "boolean" ||
      typeof data.order !== "number" ||
      !Number.isFinite(data.order)
    )
      throw new Error("Invalid schema");
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
function mirrorArgs(bead: Bead, task: Task): string[] {
  const before = Array.isArray(bead.labels)
    ? bead.labels.filter((label): label is string => typeof label === "string")
    : [];
  const after = mirrorLabels(task);
  const args: string[] = [];
  for (const label of before) {
    if (
      (label.startsWith("kind:") ||
        label.startsWith("repo:") ||
        label === "hold:captain") &&
      !after.includes(label)
    )
      args.push("--remove-label", label);
  }
  for (const label of after)
    if (!before.includes(label)) args.push("--add-label", label);
  return args;
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
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("close", (code, signal) => {
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
  private readonly cwd: string;
  private readonly prefix: string;
  private readonly now: () => string;
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
    this.binary = options.binary ?? "br";
    this.prefix = options.prefix ?? "tasks";
    this.now = options.now ?? today;
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
      publicFollowups: false,
    };
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
          );
        });
      }
      // Every subprocess, reads included, is pinned to this exact database.
      const out = await runBr(
        this.binary,
        ["--db", this.path, ...args, "--json"],
        this.cwd,
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
      if (!ref?.startsWith("tasks-axi:") || bead.status === "tombstone")
        continue;
      const id = validateId(ref.slice("tasks-axi:".length));
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
      if (data.prioritySet && typeof bead.priority === "number")
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
      // list omits edge data. Exactly one batched show hydrates the entire graph.
      const shown = await this.call([
        "show",
        ...result.map((item) => String(item.bead.id)),
      ]);
      if (!Array.isArray(shown))
        throw new AxiError("br show returned invalid issues", "UNKNOWN");
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
          if (!target)
            throw new AxiError(
              `Task "${loaded.task.id}" has a dependency outside tasks-axi`,
              "VALIDATION_ERROR",
            );
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
  async create(input: TaskInput): Promise<Task> {
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
    return withLock(this.path, async () => {
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
        kind: input.kind ?? leadingKind(input.title),
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
      const mirrors = mirrorLabels({ ...input, kind: data.kind });
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
          state === "in_flight" ? "in_progress" : "open",
          "--description-file",
          "-",
          "--priority",
          String(input.priority ?? 2),
          "--agent-context",
          JSON.stringify({ tasks_axi: data }),
        ],
        input.body ?? "",
      );
      const nativeId = this.required(await this.load(), id).bead.id;
      if (state === "done") {
        if (typeof nativeId !== "string")
          throw new AxiError(`br create did not persist "${id}"`, "UNKNOWN");
        await this.call(["close", nativeId, "--force"]);
      }
      const task: Task = {
        id,
        title: input.title,
        state,
        links: deriveLinks(input.title),
        deps,
      };
      if (input.kind) task.kind = input.kind;
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
    return withLock(this.path, async () => {
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
      if (
        patch.kind !== undefined &&
        task.kind !== (patch.kind.trim() || undefined)
      ) {
        task.kind = patch.kind.trim() || undefined;
        mark("kind");
      }
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
      const data: AdapterData = {
        ...found.data,
        kind: task.kind,
        repo: task.repo,
        meta: task.meta,
        hold: task.hold,
        prioritySet: task.priority !== undefined,
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
      args.push(...mirrorArgs(found.bead, task));
      // Archive before replacement: a failed replacement cannot lose the prior notes.
      if (
        patch.archiveBody &&
        patch.body !== undefined &&
        oldBody !== (patch.body || undefined) &&
        oldBody !== undefined
      ) {
        await this.call(
          ["comments", "add", String(found.bead.id), "-f", "-"],
          oldBody,
        );
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
    return withLock(this.path, async () => {
      const all = await this.load();
      const found = this.required(all, id);
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
      // Tombstones retain unique external_ref values unless explicitly released.
      await this.call([
        "update",
        String(found.bead.id),
        "--force",
        "--external-ref",
        "",
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
    return withLock(this.path, async () => {
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
          to === "in_flight"
            ? (found.task.created ?? date)
            : (found.task.created ?? null),
        closed: to === "done" ? date : undefined,
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
      const body = opts.note
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
    return withLock(this.path, async () => {
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
      await this.call([
        "dep",
        "add",
        String(found.bead.id),
        String(target.bead.id),
        "--type",
        DEP_TYPES[checked.type],
      ]);
      const data = { ...found.data, deps: [...found.task.deps, checked] };
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
  async removeDep(id: string, dep: Dep): Promise<boolean> {
    const checked = checkedDep(id, dep);
    return withLock(this.path, async () => {
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
  async updatePublicFollowup(): Promise<Task> {
    throw unsupported("public followups", "beads");
  }
}
