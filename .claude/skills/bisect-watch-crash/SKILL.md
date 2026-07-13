---
name: bisect-watch-crash
description: Bisect a watch-side crash or regression (memory full, blank screen, freeze) against a known-good commit on real hardware. Use when a watch bug has survived 2+ targeted fixes, or when the cause of a crash is unclear — do NOT keep writing speculative fixes.
---

# Bisect a watch crash against a known-good baseline

This workflow found the real cause of this repo’s worst bug (a “memory full”
crash that had already absorbed three plausible-but-wrong fixes). Follow it
exactly; the failure mode it prevents is *you writing another reasonable fix
for the wrong cause*. Background: `docs/WATCH-DEBUGGING-PLAYBOOK.md`.

Real-hardware testing is a human step — the user runs the repro on the watch
and reports back. Your job is to make each round trivially cheap for them:
one build, one install command already run, one precise script of actions to
perform, one question to answer.

## Procedure

### 1. Pin the repro (do not skip)

Ask the user for — or establish from the bug report — the *specific*
triggering conditions: which stop/screen, how many refreshes or scrolls, how
long a session, does text volume matter. Write the repro down as a numbered
script of button presses/actions. If the answer is “it just crashes
sometimes”, your first task is narrowing that, not bisecting yet: have the
user try a busy stop vs a quiet one, rapid scrolling vs idle, etc.

### 2. Preserve current state

- `git status` — if dirty, commit to a WIP branch or stash, and record what
  you did so you can restore it in step 8.
- Note the current HEAD sha.

### 3. Set up a scratch app identity

So debug builds can be installed alongside the user’s normal install:

- Generate a fresh UUID (`uuidgen`).
- In `package.json`, temporarily set `pebble.uuid` to it and suffix the
  display name (e.g. `"Transit DBG"`). **Never commit this change**; it is
  reverted in step 8.
- Re-apply this same edit after every `git checkout` in the walk (checkouts
  revert package.json). A small `git stash` holding just this edit, popped
  after each checkout, works well.

### 4. Establish the baseline

- Identify the last-known-good commit (user’s memory, `git log` dates, or
  the commit before the suspect feature landed).
- `git checkout <good-sha>`, re-apply the scratch identity,
  `pebble build && pebble install --phone <IP>`.
- Have the user run the pinned repro. **If the baseline also fails, stop** —
  either the baseline or the repro is wrong; fix that before walking.

### 5. Walk the range

For a handful of commits, step forward one at a time from good; for a long
range, use `git bisect start <bad> <good>` and let git pick midpoints.
Each round:

1. Checkout, re-apply scratch identity, `pebble build`,
   `pebble install --phone <IP>`.
2. Give the user the repro script verbatim and wait for their report.
3. Record in a running table: commit sha, subject, pass/fail, **and the
   failure detail** (how long it took, what action triggered it, what the
   screen showed). Changed failure behavior between commits is diagnostic —
   e.g. “crashes after 3 refreshes” becoming “crashes after 10” means you’re
   near a contributing commit, not necessarily *the* commit.
4. Keep the table in your response each round so the user sees progress.

### 6. Confirm the first bad commit

Re-test it and its parent once more if the signal was at all noisy —
memory bugs can be timing-dependent, and one flaky round poisons the walk.

### 7. Audit only that diff

`git show <first-bad-sha>`. Check the diff against the playbook’s pattern
list (§B/§G): allocation churn reachable from `draw()`, timers without a
clear path, sensor lifecycle, font pairs, manifest/messageKeys omissions,
payload growth. The bug is in this diff — resist widening the search. Write
the fix against current main (not the old commit), then have the user re-run
the repro on the fixed build to confirm.

### 8. Restore everything

- Revert the scratch UUID/name edit.
- `git checkout` the original branch/sha; restore any stash from step 2.
- Tell the user the “Transit DBG” app can be uninstalled from the watch.

### 9. Write down what you learned

Add the confirmed pattern (or newly-invalidated assumption) to
`docs/WATCH-DEBUGGING-PLAYBOOK.md` in the same change as the fix.
