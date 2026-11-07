import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  AxiError,
  partialMoveError,
  stillBlockingError,
  strandedDepError,
} from "../errors.js";
import { validateId } from "../id.js";
import type { Task, TaskInput } from "../model.js";
import type { Store } from "../store.js";
import { withLock, withLocks } from "./lock.js";
import { parseBacklog, renderTaskLines } from "./markdown-grammar.js";

// Only the two local adapters opt into this protocol. Their ordinary mutations
// reuse locks owned by this transfer's async chain, never a process-global flag.
const collections = new WeakMap<
  Store,
  { path: string; refresh?: () => Promise<unknown> }
>();
const ownedLocks = new AsyncLocalStorage<ReadonlySet<string>>();
const removal = new AsyncLocalStorage<{ store: Store; expected: Task }>();

/** Called by each adapter after its fresh locked read, before deleting. */
export function assertTransferRemoval(store: Store, actual: Task): void {
  const intent = removal.getStore();
  if (
    intent?.store === store &&
    intent.expected.id === actual.id &&
    !sameContent(intent.expected, actual)
  )
    throw new AxiError(
      `Task "${actual.id}" changed during transfer; reread before retrying`,
      "CONFLICT",
    );
}

function removeTransferredTask(store: Store, expected: Task): Promise<Task> {
  return removal.run({ store, expected }, () => store.remove(expected.id));
}

export function registerTransferStore(
  store: Store,
  path: string,
  refresh?: () => Promise<unknown>,
): void {
  collections.set(store, { path: resolve(path), refresh });
}

export function withCollectionLock<T>(
  path: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  return ownedLocks.getStore()?.has(resolve(path))
    ? Promise.resolve().then(fn)
    : withLock(path, fn);
}

function transferInput(task: Task): TaskInput {
  const input: TaskInput & { updated?: string } = {
    ...task,
    created: task.created ?? null,
  };
  delete input.updated;
  return input;
}

function sameContent(left: Task, right: Task): boolean {
  const canonical = (task: Task) =>
    JSON.parse(
      JSON.stringify({
        ...transferInput(task),
        deps: [...task.deps].sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b)),
        ),
        links: [...task.links].sort((a, b) => a.url.localeCompare(b.url)),
      }),
    ) as unknown;
  return isDeepStrictEqual(canonical(left), canonical(right));
}

function dependencyOrder(tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: Task[] = [];
  const visit = (task: Task): void => {
    if (visited.has(task.id)) return;
    if (visiting.has(task.id))
      throw new AxiError(
        "Cannot transfer a cyclic dependency set into beads",
        "VALIDATION_ERROR",
      );
    visiting.add(task.id);
    for (const dep of task.deps) {
      const parent = byId.get(dep.id);
      if (parent) visit(parent);
    }
    visiting.delete(task.id);
    visited.add(task.id);
    ordered.push(task);
  };
  tasks.forEach(visit);
  return ordered;
}

/** Copy first, remove second; compensate a refused removal like mv's fallback. */
export async function transferCollection(
  source: Store,
  ids: string[],
  target: Store,
): Promise<Task[]> {
  const sourceCollection = collections.get(source);
  const targetCollection = collections.get(target);
  if (!sourceCollection || !targetCollection)
    throw new AxiError(
      `Cannot transfer into the "${target.capabilities().backend}" backend`,
      "UNSUPPORTED",
    );
  const sourcePath = sourceCollection.path;
  const targetPath = targetCollection.path;
  if (sourcePath === targetPath)
    throw new AxiError(
      "--to resolves to the current collection",
      "VALIDATION_ERROR",
    );
  const uniqueIds = [...new Set(ids.map((id) => validateId(id)))];
  // Validate output paths only: beads-to-beads can retain metadata that the
  // markdown import row validator intentionally refuses.
  source.validateImport?.([], [targetPath]);
  target.validateImport?.([], [sourcePath]);
  return withLocks([sourcePath, targetPath], () =>
    ownedLocks.run(new Set([sourcePath, targetPath]), async () => {
      const remaining = (await source.list({})).items;
      const destination = (await target.list({})).items;
      const moved = new Set(uniqueIds);
      const tasks: Task[] = [];
      for (const id of uniqueIds) {
        const original = remaining.find((task) => task.id === id);
        const existing = destination.find((task) => task.id === id);
        const task = original ?? existing;
        if (!task) throw new AxiError(`Task "${id}" not found`, "NOT_FOUND");
        if (original && existing && !sameContent(original, existing))
          throw new AxiError(
            `Task "${id}" already exists in the destination backlog with different content`,
            "CONFLICT",
          );
        if (task.public_followup || task.kind === "public-followup")
          throw new AxiError(
            `Task "${id}" carries a public obligation; beads transfers cannot relocate public obligations`,
            "UNSUPPORTED",
          );
        const stranded = remaining.filter(
          (item) =>
            !moved.has(item.id) &&
            item.state !== "done" &&
            item.deps.some((dep) => dep.type === "blocked-by" && dep.id === id),
        );
        if (stranded.length)
          throw stillBlockingError(
            id,
            stranded.map((task) => task.id),
          );
        for (const dep of task.deps) {
          if (
            !moved.has(dep.id) &&
            !destination.some((task) => task.id === dep.id)
          )
            throw strandedDepError(id, dep);
        }
        if (target.capabilities().backend === "markdown") {
          const heading = {
            queued: "Queued",
            in_flight: "In flight",
            done: "Done",
          }[task.state];
          const doc = parseBacklog(
            `## ${heading}\n${renderTaskLines(task).join("\n")}\n`,
          );
          const entry = doc.sections[0]?.entries.find(
            (entry) => entry.kind === "task",
          );
          if (!entry || entry.kind !== "task" || !sameContent(task, entry.task))
            throw new AxiError(
              `Markdown cannot preserve every field of task "${id}"`,
              "VALIDATION_ERROR",
            );
        }
        tasks.push(task);
      }
      const ordered = dependencyOrder(tasks);
      const copied: Task[] = [];
      try {
        // Build the entire destination graph before removing any source task.
        for (const task of ordered) {
          if (destination.some((item) => item.id === task.id)) continue;
          copied.push(task);
          await target.create(transferInput(task));
          const persisted = await target.get(task.id);
          if (!persisted || !sameContent(task, persisted))
            throw new AxiError(
              `Destination did not preserve task "${task.id}"`,
              "CONFLICT",
            );
        }
        // A markdown destination may have been hand-edited while later tasks
        // were staged. Recheck the complete graph before removing any source.
        const landed = (await target.list({})).items;
        for (const task of tasks) {
          const persisted = landed.find((item) => item.id === task.id);
          if (!persisted || !sameContent(task, persisted))
            throw new AxiError(
              `Destination task "${task.id}" changed during transfer`,
              "CONFLICT",
            );
        }
        for (const task of [...ordered].reverse()) {
          if (remaining.some((item) => item.id === task.id))
            await removeTransferredTask(source, task);
        }
      } catch (error) {
        try {
          // Restore deleted source tasks first; never remove their last copy.
          for (const task of ordered) {
            if (
              remaining.some((item) => item.id === task.id) &&
              !(await source.get(task.id))
            )
              await source.create(transferInput(task));
          }
          for (const task of [...copied].reverse()) {
            if (await target.get(task.id))
              await removeTransferredTask(target, task);
          }
        } catch (rollbackError) {
          throw partialMoveError(
            uniqueIds.join(", "),
            error,
            rollbackError,
            targetPath,
            true,
          );
        }
        throw error;
      }
      // Even a completed retry is a mutation: repair derived projections under
      // both locks. A refresh failure must not undo an already completed move.
      await sourceCollection.refresh?.();
      await targetCollection.refresh?.();
      return tasks;
    }),
  );
}
