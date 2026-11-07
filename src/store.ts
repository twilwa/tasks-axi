import type { PublicFollowupMutation } from "./public-followup.js";
import type {
  Dep,
  State,
  Task,
  TaskInput,
  TaskPatch,
  TaskUpdateResult,
  TaskQuery,
  TransitionOpts,
} from "./model.js";

/**
 * Backend capability descriptor (report §8). Optional capabilities degrade
 * gracefully: the CLI computes a missing capability from the core verbs, or
 * returns a structured error naming the capability — never a raw backend error.
 */
export interface Capabilities {
  /** Backend identifier, e.g. "markdown". */
  backend: string;
  deps: boolean;
  prune: boolean;
  comments: boolean;
  fullTextSearch: boolean;
  realtimeSync: boolean;
  /** Can it represent backend-specific states beyond queued/in_flight/done? */
  customStates: boolean;
  /** Does the server assign its own ids (remote trackers)? */
  serverMintsIds: boolean;
  /** Can it move a connected set while preserving dependencies and safe recovery? */
  collectionTransfer: boolean;
  /** Supports the durable, receipt-gated public-followup state machine. */
  publicFollowups: boolean;
}

export interface PruneOptions {
  state: State;
  keep: number;
  archive: boolean;
}

export interface PruneResult {
  archived: number;
  ids: string[];
}

/**
 * The single narrow seam every backend implements (report §8). The CLI layer
 * (arg parsing, TOON rendering, suggestions, help) never knows which backend
 * is active. `ready`/`blocked`/`held` are derived in the CLI from `list`, the
 * dependency graph, structured hold tags, and public-followup state, so every
 * backend gets them for free.
 *
 * The core contract is create/get/update/remove/list/transition/addDep/
 * removeDep/updatePublicFollowup. `transferMany`, `prune` and `render` are
 * optional and capability-gated.
 */
export interface Store {
  capabilities(): Capabilities;
  /** True only if the destination has no live records, including unmanaged ones. */
  isEmpty?(): Promise<boolean>;
  /** Read-only preflight: reject lossy rows or writes overlapping import sources. */
  validateImport?(tasks: Task[], readOnlyPaths?: string[]): void;

  // CRUD
  create(input: TaskInput): Promise<Task>;
  get(id: string): Promise<Task | null>;
  /** Apply a patch and report which fields actually changed. */
  update(id: string, patch: TaskPatch): Promise<TaskUpdateResult>;
  remove(id: string): Promise<Task>;

  // query
  list(query: TaskQuery): Promise<{ items: Task[]; total: number }>;

  // state + dependencies
  transition(id: string, to: State, opts?: TransitionOpts): Promise<Task>;
  addDep(id: string, dep: Dep): Promise<boolean>;
  removeDep(id: string, dep: Dep): Promise<boolean>;

  /** Atomically replace one typed obligation revision and optionally complete it. */
  updatePublicFollowup(
    id: string,
    mutation: PublicFollowupMutation,
  ): Promise<Task>;

  /**
   * Move a connected set into `destination`, gated on `collectionTransfer`.
   * The adapter owns collision, dependency and obligation validation. Markdown
   * retains its two-file transaction; transfers involving beads copy the whole
   * destination graph first, then remove the source with best-effort rollback.
   * Those transfers can leave crash duplicates, never missing tasks, and retry
   * the same intent by recognizing identical destination copies. Adapters that
   * cannot preserve this contract omit it; the CLI offers only a single-id
   * copy-then-remove fallback.
   */
  transferMany?(ids: string[], destination: Store): Promise<Task[]>;

  // maintenance (optional, capability-gated)
  prune?(options: PruneOptions): Promise<PruneResult>;
  /** Normalize the persisted view (markdown: rewrite every item canonically). */
  render?(): Promise<number>;
}
