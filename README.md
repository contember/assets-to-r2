# assets-to-r2

A Claude Code skill (plus a standalone Bun CLI) that moves heavy binary assets
out of a git repository onto Cloudflare R2 behind `cdn.nuasite.com`, and
rewrites every reference to absolute CDN URLs.

Built for the recurring problem where a site repo accumulates gigabytes of
committed article photos, uploaded PDFs and crawled media — typically after a
site rebuild — and every clone pays for it.

## Why the rewrite is mandatory

The nuasite `<Image>` component (`@nuasite/components`) builds Cloudflare
transform URLs by splicing the origin of `src` into the prefix:

| `src` | emitted |
|---|---|
| `/assets/a.jpg` | `/cdn-cgi/image/…/assets/a.jpg` — against **the site's own host** |
| `https://cdn.nuasite.com/assets/x/a.jpg` | `https://cdn.nuasite.com/cdn-cgi/image/…/assets/x/a.jpg` |

Same-zone is structural — the component never emits a cross-origin form. So once
an asset lives on R2, a root-relative reference asks the site's zone to transform
a file it no longer hosts. See `reference/nuasite-image.md`.

## Install

Clone into your Claude skills directory; the checkout *is* the skill:

```bash
git clone git@github.com:contember/assets-to-r2.git ~/.claude/skills/assets-to-r2
```

Claude picks it up automatically. Requires Bun — the CLI has no dependencies
(it uses `Bun.S3Client`).

## Use

Ask Claude: *"presuň assety z tohohle repa na CDN"*. Or drive the CLI directly
from the target repo's root:

```bash
A2R=~/.claude/skills/assets-to-r2/scripts/a2r.ts

bun $A2R preflight --slug my-project        # prove creds + that the zone fronts the bucket
bun $A2R inventory --slug my-project        # classify assets → .a2r/plan.json
bun $A2R mark move --class uncertain        # adjust the plan
bun $A2R upload --dry-run                   # then without --dry-run
bun $A2R rewrite                            # dry-run; then --apply
bun $A2R verify                             # CDN reachability + a real cdn-cgi transform
bun $A2R prune --apply                      # delete the local copies
```

Every destructive step is dry-run by default and nothing is deleted until
`verify` passes.

## What moves and what stays

Assets are classified by how they are referenced across all tracked text files.
The default line: **fixed parts of the site stay** (SVG, icons, logos, fonts,
`gfx/`), **data moves** (article photos, uploaded PDFs, orphaned media, anything
≥ 1 MB). Undecided files land in an `uncertain` bucket that the skill tells
Claude to raise with you rather than guess. Adjust with `mark`.

## Configuration

Read from the environment; pass `--env-file .dev.vars` to load a dotenv file.

| var | default |
|---|---|
| `R2_ACCESS_KEY_ID` | required |
| `R2_SECRET_ACCESS_KEY` | required |
| `R2_ENDPOINT` | required, or derive from `R2_ACCOUNT_ID` |
| `R2_BUCKET` | required, or pass `--bucket` |
| `R2_REGION` | `auto` |
| `CDN_BASE_URL` | `https://cdn.nuasite.com` |
| `CDN_ASSET_PREFIX` | `assets` |

Objects land at `<bucket>/assets/<project-slug>/<path>`, served as
`https://cdn.nuasite.com/assets/<project-slug>/<path>`.

## Tests

```bash
cd scripts && bun test
```

Covers the reference matcher's boundary cases (`a.jpg` vs `a.jpg.webp`, deeper
path prefixes, foreign origins, extensionless assets, percent-encoding) and the
classification rules. Run it after touching `lib.ts` — a matcher bug silently
corrupts content files.

## Layout

```
SKILL.md                      the workflow Claude follows
scripts/a2r.ts                CLI: preflight, inventory, mark, upload, rewrite, verify, prune
scripts/lib.ts                config, walking, ref matching, classification
scripts/lib.test.ts           bun:test suite
reference/nuasite-image.md    the <Image> cdn-cgi contract and its failure modes
reference/cdn-zone.md         bucket/key layout, caching, CORS
reference/git-history.md      optional history rewrite to actually shrink .git
```

## Caveats

- `prune` does not shrink `.git` — the blobs stay in history. Shrinking it is a
  separate, invasive follow-up (`reference/git-history.md`).
- Per-object `Cache-Control` is not set; Bun's S3 client cannot. Use a zone
  Cache Rule (`reference/cdn-zone.md`).
- Fonts stay local by default — cross-origin fonts need CORS on the bucket.
