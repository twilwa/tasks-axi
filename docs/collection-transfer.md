# Collection transfer state machine

`mv --to` between two collections (`src/backends/collection-transfer.ts`) has an external effect on each side. Both collection locks are held for the whole run. Each task is in one of these states:

| State | Source  | Destination    | Meaning                               |
| ----- | ------- | -------------- | ------------------------------------- |
| `S`   | present | absent         | not started, or rolled back           |
| `C?`  | present | unknown        | create issued, outcome unknown        |
| `B`   | present | present, equal | staged copy verified                  |
| `D?`  | unknown | present, equal | source delete issued, outcome unknown |
| `T`   | absent  | present        | moved                                 |

The steps, in order:

1. Read both sides (locked) and validate.
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
- **Indeterminate failure:** freeze. Nothing is compensated, reread or deleted. The move reports `CONFLICT` "indeterminate; no copy was rolled back". Each task is then in `S`, `B` or `T`, or in `C?`/`D?` resolving to one of those.

So no failure point removes the last copy of a task. A task found in both collections is always explained by one of the two recorded errors.

## Retry reconciles

A rerun of the same `mv` reads both sides again:

- `S` copies and deletes as usual.
- `B` (equal copies) skips the create and deletes the source.
- `T` counts the task as moved.
- A task present on both sides with different content (a writer changed one copy between runs) is refused with `CONFLICT`, and both copies are kept.

## Concurrent writers

Another tasks-axi writer on either side waits for the locks, then sees a settled state. Writers that bypass tasks-axi (native `br` or hand edits during the move) are outside the contract. The rereads in steps 2 and 3 and the removal content check refuse what they can detect.

`test/backends/transfer-state-machine.test.ts` drives every step through each failure kind on each side, with and without a writer between attempts, and asserts the invariants above.
