import { AsyncResource } from "node:async_hooks";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertTransferRemoval,
  moveRecordPath,
  registerTransferStore,
  transferCollection,
} from "../../src/backends/collection-transfer.js";
import { withLock } from "../../src/backends/lock.js";
import {
  AxiError,
  isIndeterminate,
  markIndeterminate,
} from "../../src/errors.js";
import type { Task } from "../../src/model.js";
import type { Store } from "../../src/store.js";

// Exhaustive walk of docs/collection-transfer.md over two in-memory stores
// that keep the real locks and move record: every call on either side,
// crossed with each failure kind, a concurrent writer at the failure point,
// a writer between the failed run and the retry, and a second failure
// during compensation. Invariants: no task is ever in zero collections; a
// task in both is explained by the move record; a retry reconciles.
type Fault =
  | "error" // determinate: refused before any effect
  | "timeout-applied" // indeterminate: effect landed before the timeout
  | "timeout-lost" // indeterminate: effect never landed
  | "kill-late" // indeterminate: a surviving descendant applies it later
  | "kill-late-wrapped" // as kill-late, but a catch replaces the marked error
  | "death-before" // the CLI is SIGKILLed before this call takes effect
  | "death-after"; // the CLI is SIGKILLed right after this call took effect
const FAULTS: Fault[] = [
  "error",
  "timeout-applied",
  "timeout-lost",
  "kill-late",
  "kill-late-wrapped",
  "death-before",
  "death-after",
];

const dir = mkdtempSync(join(tmpdir(), "transfer-sm-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let serial = 0;

// Run outside the transfer's async context, as another process would.
const root = new AsyncResource("probe-root");
const noChain = <T>(fn: () => Promise<T>) => root.runInAsyncScope(fn);

interface World {
  dead: boolean;
  snapshot?: {
    src: Map<string, Task>;
    dst: Map<string, Task>;
    record: string | null;
  };
  probe: boolean;
}

class FakeStore {
  tasks = new Map<string, Task>();
  calls = 0;
  faults: { at: number; kind: Fault }[] = [];
  late: (() => void)[] = [];
  probes: string[] = [];
  readonly path: string;
  constructor(
    readonly name: "src" | "dst",
    readonly world: World,
    readonly peer: () => FakeStore,
    readonly record: () => string,
  ) {
    this.path = join(dir, name + "-" + serial++ + ".md");
    registerTransferStore(this as unknown as Store, this.path);
  }
  capabilities() {
    return { backend: "beads" } as ReturnType<Store["capabilities"]>;
  }
  /** A concurrent writer, outside the transfer's async chain, on each side. */
  private async probe(): Promise<void> {
    const codes = await Promise.all(
      [this, this.peer()].map((store) =>
        noChain(() =>
          withLock(store.path, () => "entered", { timeoutMs: 30 }).then(
            (v) => v,
            (e: AxiError) => e.code,
          ),
        ),
      ),
    );
    this.probes.push(...codes);
  }
  private die(): never {
    const src = this.name === "src" ? this : this.peer();
    const dst = this.name === "src" ? this.peer() : this;
    const path = this.record();
    this.world.dead = true;
    this.world.snapshot = {
      src: structuredClone(src.tasks),
      dst: structuredClone(dst.tasks),
      record: existsSync(path) ? readFileSync(path, "utf8") : null,
    };
    throw new Error("killed");
  }
  private async step<T>(effect: () => T): Promise<T> {
    if (this.world.dead) throw new Error("dead");
    const at = this.calls++;
    const fault = this.faults.find((f) => f.at === at)?.kind;
    if (!fault) return effect();
    if (this.world.probe) await this.probe();
    const fail = (message: string) =>
      markIndeterminate(new AxiError(this.name + ": " + message, "UNKNOWN"));
    switch (fault) {
      case "error":
        throw new AxiError(this.name + ": br refused", "UNKNOWN");
      case "timeout-applied":
        effect();
        throw fail("br timed out");
      case "timeout-lost":
        throw fail("br timed out");
      case "kill-late":
        this.late.push(() => void effect());
        throw fail("br killed by SIGKILL");
      case "kill-late-wrapped":
        this.late.push(() => void effect());
        fail("br killed by SIGKILL");
        throw new AxiError(this.name + ": follow-up call failed", "UNKNOWN");
      case "death-before":
        return this.die();
      case "death-after":
        effect();
        return this.die();
    }
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

function seed(probe = true) {
  const world: World = { dead: false, probe };
  const pair: { source?: FakeStore; target?: FakeStore } = {};
  const record = () => moveRecordPath(pair.source!.path);
  const source = new FakeStore("src", world, () => pair.target!, record);
  const target = new FakeStore("dst", world, () => source, record);
  pair.source = source;
  pair.target = target;
  source.tasks.set("a", task("a"));
  source.tasks.set(
    "b",
    task("b", [{ type: "blocked-by", id: "a" } as Task["deps"][0]]),
  );
  return { source, target, world, record: record() };
}

const transfer = (s: FakeStore, t: FakeStore) =>
  transferCollection(s as unknown as Store, IDS, t as unknown as Store).then(
    () => undefined,
    (error: unknown) => error,
  );

const where = (s: FakeStore, t: FakeStore, id: string) =>
  [s.tasks.has(id) && "src", t.tasks.has(id) && "dst"].filter(Boolean);

/** Fail once, let late effects land (or the CLI die), then check and retry. */
async function exercise(
  faults: { side: "src" | "dst"; at: number; kind: Fault }[],
  writer: "none" | "src" | "dst",
  probe: boolean,
): Promise<{ error: unknown; problems: string[]; probes: string[] }> {
  const { source, target, world, record } = seed(probe);
  for (const f of faults)
    (f.side === "src" ? source : target).faults.push({
      at: f.at,
      kind: f.kind,
    });
  const error = await transfer(source, target);
  if (world.dead && world.snapshot) {
    // Nothing after the kill happened: rewind to the moment of death.
    source.tasks = world.snapshot.src;
    target.tasks = world.snapshot.dst;
    if (world.snapshot.record === null) rmSync(record, { force: true });
    else writeFileSync(record, world.snapshot.record);
  }
  for (const effect of [...source.late, ...target.late]) effect();
  world.dead = false;
  source.faults = [];
  target.faults = [];
  const problems: string[] = [];
  for (const id of IDS) {
    const found = where(source, target, id);
    if (!found.length) problems.push(id + " in no collection");
    if (found.length === 2 && !existsSync(record))
      problems.push(id + " in both collections with no move record");
  }
  if (error && isIndeterminate(error))
    for (const id of IDS)
      if (where(source, target, id).join() !== "src")
        problems.push("raw indeterminate error after a mutation");
  if (writer !== "none") {
    const store = writer === "src" ? source : target;
    const victim = [...store.tasks.values()][0];
    if (victim) victim.title = "Edited between runs";
  }
  const retry = await transfer(source, target);
  for (const id of IDS) {
    const found = where(source, target, id);
    if (!found.length) problems.push(id + " lost on retry");
    if (retry === undefined && found.join() !== "dst")
      problems.push(id + " not reconciled: " + found.join("+"));
  }
  if (retry === undefined && existsSync(record))
    problems.push("move record left after a settled retry");
  if (retry !== undefined) {
    if (writer === "none") problems.push("retry failed: " + String(retry));
    else if ((retry as AxiError).code !== "CONFLICT")
      problems.push("retry refused without CONFLICT: " + String(retry));
    for (const id of IDS)
      if (where(source, target, id).length === 2 && !existsSync(record))
        problems.push(id + " refused duplicate without a move record");
  }
  rmSync(record, { force: true });
  return { error, problems, probes: [...source.probes, ...target.probes] };
}

// Call counts of a clean run bound the first fault; compensation adds calls.
const clean = seed();
await transfer(clean.source, clean.target);
const CLEAN = { src: clean.source.calls, dst: clean.target.calls };
const SIDES = ["src", "dst"] as const;

const single = SIDES.flatMap((side) =>
  Array.from({ length: CLEAN[side] }, (_, at) =>
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
    expect(CLEAN.src).toBeGreaterThanOrEqual(3);
    expect(CLEAN.dst).toBeGreaterThanOrEqual(3);
    expect(single.length).toBe((CLEAN.src + CLEAN.dst) * FAULTS.length * 3);
  });

  it.each(single)(
    "$side call $at fails with $kind, writer $writer",
    async ({ side, at, kind, writer }) => {
      const { error, problems, probes } = await exercise(
        [{ side, at, kind }],
        writer,
        true,
      );
      expect(problems).toEqual([]);
      // A concurrent tasks-axi writer on either side was held off.
      expect(probes).toEqual(["LOCKED", "LOCKED"]);
      if (kind === "error" && error)
        expect((error as AxiError).code).not.toBe(undefined);
    },
  );

  it("survives a second failure of every kind during compensation", async () => {
    const failures: string[] = [];
    let runs = 0;
    for (const side1 of SIDES)
      for (let k1 = 0; k1 < CLEAN[side1]; k1++)
        for (const side2 of SIDES)
          for (let k2 = 0; k2 < CLEAN[side2] + 8; k2++) {
            if (side2 === side1 && k2 <= k1) continue;
            for (const kind of FAULTS) {
              runs++;
              const { problems } = await exercise(
                [
                  { side: side1, at: k1, kind: "error" },
                  { side: side2, at: k2, kind },
                ],
                "none",
                false,
              );
              if (problems.length)
                failures.push(
                  `${side1}@${k1} error, then ${side2}@${k2} ${kind}: ${problems.join("; ")}`,
                );
            }
          }
    expect(runs).toBeGreaterThan(500);
    expect(failures).toEqual([]);
  }, 120_000);
});
