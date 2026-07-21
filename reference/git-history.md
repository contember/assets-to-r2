# Shrinking `.git` afterwards — optional, invasive

`a2r prune` removes the files from the working tree and the index. It does
**not** shrink `.git`: every blob is still reachable from history, so a repo
that was 6 GB stays 6 GB on clone.

Only do this if the user explicitly asks for a smaller repository, and only
after the migration is committed and pushed. It rewrites every commit hash.

## Cost, stated plainly

- All SHAs change. Every open branch and PR must be rebased or recreated.
- Everyone with a clone must re-clone or hard-reset; a normal `git pull` after a
  force-push produces a mess.
- Force-push to a shared branch needs coordination — agree a window first.
- Tags and any SHA referenced elsewhere (CI configs, changelogs, deploy
  pipelines, issue comments) go stale.

## Procedure

Use `git-filter-repo` (not `filter-branch`, which is slow and error-prone).
Work on a fresh clone so the original stays intact.

```bash
git clone --no-local /path/to/repo repo-shrink
cd repo-shrink
git filter-repo --path packages/web/public/assets --invert-paths
git count-objects -vH          # confirm the size drop
```

Add `--path` for every directory that was migrated. `--invert-paths` means
"remove these", so double-check the list before running: anything omitted stays,
anything extra is gone from history.

Then verify the rewritten clone builds and its HEAD tree matches the original's
HEAD tree apart from the removed files:

```bash
git diff --stat <original-head> HEAD   # after adding the original as a remote
```

Only once that is clean, force-push, and tell everyone to re-clone.

## The cheaper alternative

If the goal is just faster clones for new contributors, a shallow or partial
clone costs nothing and rewrites nothing:

```bash
git clone --filter=blob:none <url>     # blobs fetched on demand
git clone --depth 1 <url>              # single commit
```

Suggest this first. It solves the common complaint ("cloning takes forever")
without touching history at all.
