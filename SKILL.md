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
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, AskUserQuestion, Skill
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

The CLI covers steps 0–5 and 7. **The migration is not done when `verify` goes
green** — that only proves the bytes are on the CDN. Steps 6, 8 and 9 (audit the
image markup, build with the local copies gone, confirm real rendering through
`agent-browser`) are where a broken migration actually shows up. Do not stop
early.

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

`verify` proves the bytes are on the CDN. It does **not** prove the site renders
them — that is steps 6–8, and they are not optional.

### 6. Audit how the site consumes images

Before deleting anything, check what the markup actually does with the new URLs.

```bash
grep -rn "allowedDomains" --include=*.astro --include=*.tsx src packages/*/src
grep -rln "@nuasite/components" packages/*/src | head
grep -rn "<img" --include=*.astro src packages/*/src | head
```

Three things to resolve, all documented in `reference/nuasite-image.md`:

- **`allowedDomains` must include the CDN host.** A non-empty list that omits
  `cdn.nuasite.com` silently disables transforms — no error, just a plain `<img>`
  with no `srcset`. (Before the migration the same prop broke on *relative*
  `src`; after it, the failure mode is a missing host.)
- **Raw `<img>` gets no transforms.** Absolute CDN URLs load fine, so nothing is
  broken, but the site loses resizing. Tell the user rather than silently
  converting the markup — switching to `<Image>` is a separate change with its
  own review.
- **SVG passes through untransformed**, which is fine and expected.

### 7. Prune, then build

```bash
bun …/a2r.ts prune              # dry-run
bun …/a2r.ts prune --apply
```

**Order matters: prune before building, not after.** While the local files still
exist, a reference the rewriter missed keeps resolving from disk and the build
passes — a false pass that hides exactly the bug you are looking for. Delete
first, then build, and a missed reference fails loudly.

Run the repo's real build (`bun run web:build`, `bun run build`, whatever the
project uses; check its `CLAUDE.md` or `package.json`). If it fails on a missing
asset, restore the file — `git restore <path>` — fix the reference, and re-run.
Everything is committed at this point, so nothing is lost.

### 8. Confirm it actually renders — use `agent-browser`

A green build only proves the files resolve. It does not prove the browser gets
an image. Invoke the **`agent-browser`** skill (do not write your own Playwright
script), start the site's dev/preview server, and check a page that uses
migrated media — an article detail page is the usual candidate.

Assert, on a real page:

- images are **not broken**: `naturalWidth > 0`, not merely present in the DOM;
- `src`/`srcset` point at `https://cdn.nuasite.com/cdn-cgi/image/…` — if you see
  a bare CDN URL with no `/cdn-cgi/image/` prefix, the component is not
  transforming (check `allowedDomains`, and note that plain `astro dev` degrades
  by design — use the pletivo dev server or a production preview);
- no failed requests to the CDN host in the network log, and no 404s;
- a PDF link, if any moved, opens rather than downloading a broken file.

Take a screenshot and show it to the user. A migration that builds but renders
grey boxes is the failure this step exists to catch.

### 9. Commit

Add `.a2r/` to `.gitignore`, review `git status`, and commit. Two commits read
better than one: the reference rewrite, then the deletion.

Deleting the files does **not** shrink `.git` — the blobs stay in history. If
the user wants the repository itself smaller, that is a separate, invasive
follow-up: `reference/git-history.md`.

## Re-running later

New assets arrive after the first migration. Re-run `inventory` → `mark` →
`upload` → `rewrite --apply` → `verify` → `prune --apply` → build; already-uploaded
objects are skipped and already-absolute URLs are not matched by the scanner, so
the pass is safe to repeat. The browser check (step 8) can be skipped on a repeat
run *if* the first migration passed it and no image markup changed since — the
component wiring is what it validates, and that does not change when new photos
land.

## Tests

`bun test` in `scripts/` covers the reference matcher (boundary cases:
`a.jpg` vs `a.jpg.webp`, deeper prefixes, foreign origins, extensionless
assets, percent-encoding) and the classification rules. Run it after any change
to `lib.ts` — a matcher bug silently corrupts content files.
