---
name: assets-to-r2
description: >
  Move heavy binary assets (article photos, uploaded PDFs, crawled media) out of
  a git repository and onto Cloudflare R2 behind the cdn.nuasite.com zone, then
  rewrite every reference to absolute CDN URLs so the nuasite `<Image>`
  component keeps producing correct `/cdn-cgi/image/...` transform URLs.

  Use when a repo is bloated by committed images/PDFs, when the user says
  "presunout assety na R2 / na CDN", "repo je moc velké kvůli obrázkům",
  "public/assets má gigabajty", "offload the images", "get the media out of
  git", or asks to set up CDN asset hosting for a project. Also use to re-run
  the move for a project that has already been migrated (new assets arrive).

  Not for: optimising/resizing images in place, moving code, or anything that
  needs write access from the website (the CDN path is read-only).
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, AskUserQuestion
---

# assets-to-r2

Moves repo-tracked assets to R2 and rewrites references to
`https://cdn.nuasite.com/assets/<project-slug>/<path>`.

The tool is `scripts/a2r.ts`, a Bun CLI next to this file. Invoke it **from the
target repo's root**:

```bash
bun ~/.claude/skills/assets-to-r2/scripts/a2r.ts <command> [flags]
```

Every destructive command is dry-run by default. Nothing is deleted until
`verify` has passed.

## The one thing that must not go wrong

The nuasite `<Image>` component (`@nuasite/components`) builds Cloudflare
transform URLs by **splicing the origin of `src` into the prefix**:

| `src` | emitted |
|---|---|
| `/assets/a.jpg` | `/cdn-cgi/image/<opts>/assets/a.jpg` — resolved against **the site's own host** |
| `https://cdn.nuasite.com/assets/x/a.jpg` | `https://cdn.nuasite.com/cdn-cgi/image/<opts>/assets/x/a.jpg` |

So once an asset lives on R2, a root-relative reference is **broken** — it asks
the site's own zone to transform a file that is no longer there. References must
become absolute CDN URLs. That is exactly what `a2r rewrite` does, and why it is
not optional. Details and the two failure modes worth knowing:
`reference/nuasite-image.md`.

## Workflow

### 0. Preconditions

- Bun (the CLI uses `Bun.S3Client`, zero dependencies).
- The repo is committed and clean — `prune` deletes files, so the user wants a
  clean `git status` to review afterwards.
- R2 credentials in the environment (below). Read them from env; never inline a
  secret into a command or a file.

```
R2_ACCESS_KEY_ID          required
R2_SECRET_ACCESS_KEY      required
R2_ENDPOINT               required, or R2_ACCOUNT_ID to derive it
R2_BUCKET                 required, or pass --bucket; must be served by the CDN
R2_REGION                 default auto
CDN_BASE_URL              default https://cdn.nuasite.com
CDN_ASSET_PREFIX          default assets
```

Pass `--env-file .dev.vars` (or `--env-file .env`) to load a dotenv file instead
of exporting them. If credentials are missing, **stop and ask the user** — do
not invent a bucket or hunt for keys in the repo.

Then prove the plumbing before touching anything:

```bash
bun …/a2r.ts preflight --slug <slug>
```

This lists the bucket, writes a probe object, fetches it back **through the CDN
hostname**, and deletes it. If the probe 404s, the zone is not bound to that
bucket at its root — surface that to the user rather than uploading 1.7 GB into
a bucket nobody serves.

### 1. Inventory

```bash
bun …/a2r.ts inventory --slug <project-slug> [--root packages/web/public]
```

The slug is supplied by the operator — ask for it, don't derive it from the
directory name. Assets land at `assets/<slug>/…` in the bucket.

Public roots are auto-detected (`public/`, `static/`, `assets/`, plus
`packages/*/public` and `apps/*/public`). **In a monorepo this frequently finds
several roots that collide** (two packages each shipping `fonts/Jost`); the tool
refuses and lists them. Narrow with `--root`, or give each root its own slug.

Inventory writes `.a2r/plan.json` and prints a summary. It classifies each file
by counting how it is referenced across all tracked text files:

| signal | verdict |
|---|---|
| `.svg .ico .woff .woff2 .ttf .otf`, or in `fonts/ gfx/ icons/ logos/ brand/`, or named like a logo/favicon | **keep** — site furniture |
| ≥ 1 MB | **move** — payload regardless of usage |
| referenced from content (`.md .json .yaml …`) or from a committed build cache | **move** — article data |
| unreferenced and ≥ 100 kB | **move** — orphaned upload |
| referenced only from code/styles and small | **keep** |
| anything else | **uncertain** — ask |

Thresholds: `--big` (default 1 MB) and `--small` (default 100 kB).

### 2. Decide with the user — do not skip this

The heuristics are a starting point, not the answer. **Show the user the summary
and the uncertain list, and ask what they want moved.** The rule of thumb the
tool encodes, and the one to confirm out loud: *fixed parts of the site (logos,
icons, SVG, fonts, UI graphics) stay in the repo; data does the moving — article
photos, uploaded PDFs, crawled media.* Where the line sits is per-repo.

Use `AskUserQuestion` with concrete numbers from the summary, then apply their
answer:

```bash
bun …/a2r.ts mark move --class uncertain            # move everything undecided
bun …/a2r.ts mark move --ext .pdf                   # all PDFs
bun …/a2r.ts mark keep --match '**/partner-*.png'   # partner logos stay
bun …/a2r.ts mark move --min-size 500000            # anything over 500 kB
```

`mark` filters combine (AND) and rewrite `.a2r/plan.json` in place; it reprints
the summary each time. You can also edit `plan.json` directly for one-offs.

### 3. Upload

```bash
bun …/a2r.ts upload --dry-run          # always look first
bun …/a2r.ts upload [--concurrency 8]
```

Idempotent: an object already in the bucket at the same size is skipped, so a
re-run resumes a partial upload. Failures are recorded and the command exits
non-zero — re-run it until clean, and **do not proceed to rewrite with failed
entries**. Results go to `.a2r/manifest.json`.

Per-object `Cache-Control` is not set — Bun's S3 client cannot. Caching belongs
to a zone Cache Rule; see `reference/cdn-zone.md`.

### 4. Rewrite references

```bash
bun …/a2r.ts rewrite              # dry-run, shows per-file counts
bun …/a2r.ts rewrite --apply
```

Rewrites only assets that actually uploaded. Committed build caches
(`.astro/data-store.json` and friends) are **counted** as usage but never
rewritten — they regenerate from the sources.

Assets with no textual reference are reported. That is normal for CMS-driven
media, but skim the list: a large count can mean references live somewhere the
scanner does not read (a database, a remote CMS, a binary format). If so, say
so before pruning.

### 5. Verify

```bash
bun …/a2r.ts verify
```

Checks, and exits non-zero on any failure:
- every uploaded object is reachable at its CDN URL with a matching size;
- a sample of rasters survives a real `cdn-cgi/image` transform (this is the
  check that catches a zone without Image Resizing — a non-image content-type
  or an HTTP error here means `<Image>` will break in production);
- no tracked source still points at a moved asset by local path.

### 6. Prune and commit

```bash
bun …/a2r.ts prune              # dry-run
bun …/a2r.ts prune --apply
```

Then add `.a2r/` to `.gitignore`, review `git status`, run the repo's build to
confirm nothing dangles, and commit. Two commits read better than one: the
reference rewrite, then the deletion.

Deleting the files does **not** shrink `.git` — the blobs stay in history. If
the user wants the repository itself smaller, that is a separate, invasive
follow-up: `reference/git-history.md`.

## Re-running later

New assets arrive after the first migration. Re-run `inventory` → `mark` →
`upload` → `rewrite --apply` → `verify`; already-uploaded objects are skipped and
already-absolute URLs are not matched by the scanner, so the pass is safe to
repeat.

## Tests

`bun test` in `scripts/` covers the reference matcher (boundary cases:
`a.jpg` vs `a.jpg.webp`, deeper prefixes, foreign origins, extensionless
assets, percent-encoding) and the classification rules. Run it after any change
to `lib.ts` — a matcher bug silently corrupts content files.
