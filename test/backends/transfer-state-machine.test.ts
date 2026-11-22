import { AsyncResource } from "node:async_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertTransferRemoval,
  registerTransferStore,
  transferCollection,
} from "../../src/backends/collection-transfer.js";
import {
  AxiError,
  isIndeterminate,
  markIndeterminate,
} from "../../src/errors.js";
import { withLock } from "../../src/backends/lock.js";
import type { Task } from "../../src/model.js";
import type { Store } from "../../src/store.js";

// Exhaustive walk of docs/collection-transfer.md: every native call on either
// side, crossed with each failure kind, with and without a writer between the
// failed run and the retry.
type Fault =
  | "error" // determinate: refused before any effect
  | "timeout-applied" // indeterminate: effect landed before the timeout
  | "timeout-lost" // indeterminate: effect never landed
  | "kill-late"; // indeterminate: a surviving descendant applies it later
const FAULTS: Fault[] = [
  "error",
  "timeout-applied",
  "timeout-lost",
  "kill-late",
];

const dir = mkdtempSync(join(tmpdir(), "transfer-sm-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let serial = 0;

class FakeStore {
  tasks = new Map<string, Task>();
  calls = 0;
  fault?: { at: number; kind: Fault };
  late: (() => void)[] = [];
  /** Outcomes of a concurrent tasks-axi writer probing each side mid-fault. */
  probes: string[] = [];
  peers: FakeStore[] = [];
  readonly path: string;
  constructor(readonly name: string) {
    this.path = join(dir, name + "-" + serial++ + ".md");
    registerTransferStore(this as unknown as Store, this.path);
  }
  /** A concurrent writer, outside the transfer's async chain, on each side. */
  private probe(): Promise<void> {
    return Promise.all(
      [this, ...this.peers].map((store) =>
        noChain(() =>
          withLock(store.path, () => "entered", { timeoutMs: 30 }).then(
            (v) => v,
            (e: AxiError) => e.code,
          ),
        ),
      ),
    ).then((codes) => void this.probes.push(...codes));
  }
  capabilities() {
    return { backend: "beads" } as ReturnType<Store["capabilities"]>;
  }
  private async step<T>(effect: () => T): Promise<T> {
    const at = this.calls++;
    const fault = this.fault?.at === at ? this.fault.kind : undefined;
    if (!fault) return effect();
    await this.probe();
    const fail = (message: string) =>
      markIndeterminate(new AxiError(this.name + ": " + message, "UNKNOWN"));
    if (fault === "error")
      throw new AxiError(this.name + ": br refused", "UNKNOWN");
    if (fault === "timeout-applied") {
      effect();
      throw fail("br timed out");
    }
    if (fault === "kill-late") this.late.push(() => void effect());
    throw fail(fault === "kill-late" ? "br killed by SIGKILL" : "br timed out");
  }
  async list() {
    return this.step(() => {
      const items = [...this.tasks.values()].map((t) => structuredClone(t));
      return { items, total: items.length };
    });
  }
  async get(id: string) {
    return this.step(() => structuredClone(this.tasks.get(id)));
  }
  async create(input: Task) {
    return this.step(() => {
      const task = structuredClone(input);
      this.tasks.set(task.id, task);
      return task;
    });
  }
  async remove(id: string) {
    const actual = this.tasks.get(id);
    if (actual) assertTransferRemoval(this as unknown as Store, actual);
    return this.step(() => {
      if (!actual) throw new AxiError("missing " + id, "NOT_FOUND");
      this.tasks.delete(id);
      return actual;
    });
  }
}

// Run outside the transfer's async context, as another process would.
const root = new AsyncResource("probe-root");
const noChain = <T>(fn: () => Promise<T>) => root.runInAsyncScope(fn);

const task = (id: string, deps: Task["deps"] = []): Task =>
  ({
    id,
    title: "Task " + id,
    state: "queued",
    deps,
    links: [],
    created: null,
  }) as unknown as Task;
const IDS = ["a", "b"];

function seed() {
  const source = new FakeStore("src");
  const target = new FakeStore("dst");
  source.peers = [target];
  target.peers = [source];
  source.tasks.set("a", task("a"));
  source.tasks.set(
    "b",
    task("b", [{ type: "blocked-by", id: "a" } as Task["deps"][0]]),
  );
  return { source, target };
}

const run = (s: FakeStore, t: FakeStore) =>
  transferCollection(s as unknown as Store, IDS, t as unknown as Store).then(
    () => undefined,
    (error: unknown) => error,
  );

const where = (s: FakeStore, t: FakeStore, id: string) =>
  [s.tasks.has(id) && "src", t.tasks.has(id) && "dst"].filter(Boolean);

// Call counts of a clean run bound the fault positions per side.
const clean = seed();
await run(clean.source, clean.target);
const SIDES = { src: clean.source.calls, dst: clean.target.calls };

const cases = (Object.keys(SIDES) as ("src" | "dst")[]).flatMap((side) =>
  Array.from({ length: SIDES[side] }, (_, at) =>
    FAULTS.flatMap((kind) =>
      (["none", "src", "dst"] as const).map((writer) => ({
        side,
        at,
        kind,
        writer,
      })),
    ),
  ).flat(),
);

describe("collection transfer state machine", () => {
  it("covers every call on both sides", () => {
    expect(SIDES.src).toBeGreaterThanOrEqual(3);
    expect(SIDES.dst).toBeGreaterThanOrEqual(3);
    expect(cases.length).toBe((SIDES.src + SIDES.dst) * FAULTS.length * 3);
  });

  it.each(cases)(
    "$side call $at fails with $kind, writer $writer: never zero copies, duplicates explained, retry reconciles",
    async ({ side, at, kind, writer }) => {
      const { source, target } = seed();
      (side === "src" ? source : target).fault = { at, kind };
      const error = await run(source, target);
      // The descendant finishes after the CLI gave up.
      // A concurrent writer on either side was held off at the failure point.
      expect([...source.probes, ...target.probes]).toEqual([
        "LOCKED",
        "LOCKED",
      ]);
      for (const effect of [...source.late, ...target.late]) effect();
      source.fault = target.fault = undefined;

      for (const id of IDS) {
        const found = where(source, target, id);
        expect(found.length, id + " lost").toBeGreaterThan(0);
        if (found.length === 2) {
          // Two copies only with a recorded, recoverable reason.
          expect(error).toBeInstanceOf(AxiError);
          expect((error as AxiError).code).toBe("CONFLICT");
          expect((error as Error).message).toMatch(
            /indeterminate|partially completed/,
          );
        }
      }
      // A raw indeterminate error may only escape before any mutation was issued.
      if (error && isIndeterminate(error))
        for (const id of IDS)
          expect(where(source, target, id)).toEqual(["src"]);
      if (kind === "error" && error) {
        // Determinate failures roll back completely.
        for (const id of IDS)
          expect(where(source, target, id)).toEqual(["src"]);
      }

      // A writer changes one copy between the failed run and the retry.
      if (writer !== "none") {
        const store = writer === "src" ? source : target;
        const victim = [...store.tasks.values()][0];
        if (victim) victim.title = "Edited between runs";
      }

      const retry = await run(source, target);
      for (const id of IDS) {
        const found = where(source, target, id);
        expect(found.length, id + " lost on retry").toBeGreaterThan(0);
        if (retry === undefined) expect(found).toEqual(["dst"]);
      }
      if (retry !== undefined) {
        // Only a diverged duplicate may refuse, and it keeps both copies.
        expect(writer).not.toBe("none");
        expect((retry as AxiError).code).toBe("CONFLICT");
      }
    },
  );
});
