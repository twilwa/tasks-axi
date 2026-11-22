# Collection transfer state machine

`mv --to` between two collections (`src/backends/collection-transfer.ts`) has an external effect on each side. Both collection locks are held for the whole run. Each task is in one of these states:

| State | Source  | Destination    | Meaning                               |
| ----- | ------- | -------------- | ------------------------------------- |
| `S`   | present | absent         | not started, or rolled back           |
| `C?`  | present | unknown        | create issued, outcome unknown        |
| `B`   | present | present, equal | staged copy verified                  |
| `D?`  | unknown | present, equal | source delete issued, outcome unknown |
| `T`   | absent  | present        | moved                                 |

The steps, in order (0 is new: the move record):

1. Read both sides (locked) and validate.
   - Before the first native write, record the intent atomically in `<source>.tasks-axi-move` (target, ids, start time). The record stays until the move settles: on success or a complete rollback it is removed; on any other outcome it is kept.
2. Create each missing task at the destination (`S → C? → B`), then reread it.
3. Reread the whole destination graph.
4. Delete each source task in reverse dependency order (`B → D? → T`).
5. Refresh the projections. A refresh failure does not undo the move.

## Failures

A step either fails **determinately** (br returned an error, a validation or conflict check failed, or Markdown I/O failed) or **indeterminately**. A step is indeterminate when br timed out, was killed by a signal, or failed after it started. A process that inherited the lock descriptor may still be applying the change, so the outcome of that step is unknown.

- **Determinate failure:** compensate.
  - First restore each source task that is missing (`D → S`).
  - Then remove each staged copy whose source is confirmed present (`B → S`).
  - A staged copy whose source could not be confirmed is kept.
  - If compensation itself fails, the move reports `CONFLICT` "partially completed; copies retained for recovery" and stops.
- **CLI killed** (SIGKILL, OOM, power loss) at any point: nothing more runs. Each task is in `S`, `C?`, `B`, `D?` or `T`, and the move record is still there, so a task in both collections is explained by it.
- **Indeterminate failure:** freeze. Nothing is compensated, reread or deleted. A step counts as indeterminate if the error carries the mark, or if any native call inside the move was marked, even when a later `catch` wrapped or replaced that error (a sticky flag on the move's async context). Inside `BeadsStore`, a delete with an unknown outcome is not followed by its usual restoring update. The move reports `CONFLICT` "indeterminate; no copy was rolled back". Each task is then in `S`, `B` or `T`, or in `C?`/`D?` resolving to one of those.

So no failure point removes the last copy of a task. A task found in both collections is always explained by the move record, plus the reported error when the CLI survived to print one.

## Retry reconciles

A rerun of the same `mv` reads both sides again:

- `S` copies and deletes as usual.
- `B` (equal copies) skips the create and deletes the source.
- `T` counts the task as moved.
- A task present on both sides with different content (a writer changed one copy between runs) is refused with `CONFLICT`, and both copies are kept.

## Concurrent writers

Another tasks-axi writer on either side waits for the locks, then sees a settled state. Writers that bypass tasks-axi (native `br` or hand edits during the move) are outside the contract. The rereads in steps 2 and 3 and the removal content check refuse what they can detect.

Two tests check these invariants: every task is in at least one collection, a task in both comes with a move record, and the retry settles every task at the destination and removes the record.

- `test/backends/transfer-state-machine.test.ts` runs two in-memory stores with the real locks and move record. Its single-fault cases fail each call on both sides with every kind: clean error, timeout that applied, timeout that was lost, late descendant, late descendant whose error a catch replaced, and CLI death before or after the call. Each kind runs with no writer and with a writer on either side between runs, and asserts that a concurrent tasks-axi writer on each side is locked out at the failure point. A second sweep adds a failure of every kind at every later call, including calls made during compensation.
- `test/backends/transfer-br-sweep.test.ts` uses real `br` and fails each native call of a beads-to-Markdown and a Markdown-to-beads move, either cleanly or as a timeout while a descriptor-keeping descendant applies the call late.
