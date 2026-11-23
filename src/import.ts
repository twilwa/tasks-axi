import { isDeepStrictEqual } from "node:util";
import { AxiError } from "./errors.js";
import type { Dep, Task } from "./model.js";
import type { Store } from "./store.js";

/**
 * The one Markdown-to-store import mapping, shared by `migrate` and by `mv`
 * receiving a Markdown outbox: graph checks, the idempotent compare, and the
 * create-then-link write order.
 */

/** An edge whose target is neither imported nor already in the destination. */
export interface UnlinkedDep {
  id: string;
  dep: Dep;
}

/** Compare persisted task values, ignoring storage-only timestamps and absent fields. */
function fields(task: Task): unknown {
  const copy: Partial<Task> = { ...task };
  delete copy.deps;
  delete copy.updated;
  return JSON.parse(JSON.stringify(copy)) as unknown;
}

/**
 * True when `existing` is `source` written so far: equal fields, and the
 * edges linked so far are a prefix of `deps` (the edges the import writes).
 */
export function compatible(
  source: Task,
  existing: Task,
  deps: Dep[] = source.deps,
): boolean {
  return (
    isDeepStrictEqual(fields(source), fields(existing)) &&
    existing.deps.every((dep, index) => isDeepStrictEqual(dep, deps[index]))
  );
}

function edge(dep: Dep): unknown {
  return JSON.parse(JSON.stringify(dep)) as unknown;
}

function hasEdge(deps: Dep[], dep: Dep): boolean {
  return deps.some((item) => isDeepStrictEqual(edge(item), edge(dep)));
}

/**
 * Receive retry check: equal fields, and every edge `existing` already has
 * is one of `source`'s. Order and missing edges are not compared, because
 * which edges are linkable can change between runs as other rows arrive.
 */
export function edgesAgree(source: Task, existing: Task): boolean {
  return (
    isDeepStrictEqual(fields(source), fields(existing)) &&
    existing.deps.every((dep) => hasEdge(source.deps, dep))
  );
}

/** Receive confirmation: equal fields, and exactly the `linked` edges. */
export function edgesReceived(
  source: Task,
  existing: Task,
  linked: Dep[],
): boolean {
  return (
    edgesAgree(source, existing) &&
    existing.deps.length === linked.length &&
    linked.every((dep) => hasEdge(existing.deps, dep))
  );
}

/**
 * Validate the import graph and return the edges that leave it. An edge is
 * written when its target is imported too or is in `present` (already in the
 * destination); any other target is unlinked. Without `present` (migration,
 * which imports a whole collection) an unlinked edge is refused instead.
 * Self edges, two edges to one target, and cycles are always refused before
 * anything is written.
 */
export function checkImportGraph(
  tasks: Task[],
  present?: ReadonlySet<string>,
): UnlinkedDep[] {
  const ids = new Set(tasks.map((task) => task.id));
  const unlinked: UnlinkedDep[] = [];
  for (const task of tasks) {
    const targets = new Set<string>();
    for (const dep of task.deps) {
      if (dep.id === task.id || (!present && !ids.has(dep.id)))
        throw new AxiError(
          `Invalid source dependency "${task.id}" -> "${dep.id}"`,
          "VALIDATION_ERROR",
        );
      if (!ids.has(dep.id) && !present?.has(dep.id)) {
        unlinked.push({ id: task.id, dep });
        continue;
      }
      if (targets.has(dep.id)) {
        throw new AxiError(
          `Beads supports only one dependency per task pair: "${task.id}" -> "${dep.id}"`,
          "VALIDATION_ERROR",
        );
      }
      targets.add(dep.id);
    }
  }
  const inner = (task: Task) => task.deps.filter((dep) => ids.has(dep.id));
  const remaining = new Map(tasks.map((task) => [task.id, inner(task).length]));
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dep of inner(task)) {
      const next = dependents.get(dep.id) ?? [];
      next.push(task.id);
      dependents.set(dep.id, next);
    }
  }
  const ready = tasks
    .filter((task) => remaining.get(task.id) === 0)
    .map((task) => task.id);
  for (let i = 0; i < ready.length; i++) {
    for (const id of dependents.get(ready[i]) ?? []) {
      const count = remaining.get(id)! - 1;
      remaining.set(id, count);
      if (count === 0) ready.push(id);
    }
  }
  if (ready.length !== tasks.length)
    throw new AxiError(
      "Source dependency cycle must be resolved before importing",
      "VALIDATION_ERROR",
    );
  return unlinked;
}

/**
 * Create every task not in `existing` (edges stripped), in an order that
 * keeps the source order within each state, then add the edges `linked`
 * selects. Every step is idempotent, so a rerun after an interruption
 * finishes the same write.
 */
export async function writeTasks(
  store: Pick<Store, "create" | "addDep">,
  tasks: Task[],
  existing: ReadonlyMap<string, Task>,
  linked: (task: Task) => Dep[] = (task) => task.deps,
): Promise<{ created: string[]; dependenciesAdded: number }> {
  const created: string[] = [];
  let dependenciesAdded = 0;
  const ordered = [
    ...tasks.filter((task) => task.state === "in_flight").reverse(),
    ...tasks.filter((task) => task.state !== "in_flight"),
  ];
  for (const task of ordered) {
    if (existing.has(task.id)) continue;
    await store.create({
      ...task,
      created: task.created ?? null,
      deps: [],
    });
    created.push(task.id);
  }
  for (const task of tasks) {
    for (const dep of linked(task)) {
      if (await store.addDep(task.id, dep)) dependenciesAdded++;
    }
  }
  return {
    created: tasks
      .filter((task) => created.includes(task.id))
      .map((task) => task.id),
    dependenciesAdded,
  };
}
