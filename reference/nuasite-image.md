# The nuasite `<Image>` contract

Why references must become absolute CDN URLs, and what breaks if they don't.

Source: `@nuasite/components` — `src/image/index.astro` (URL building) and
`src/image/utils.ts` (option serialisation) in the component source tree.

## How the URL is built

```
normalizeBase   = absolute src ? `${new URL(src).origin}${deliveryBase}` : deliveryBase
normalizeSource = absolute src ? `${url.pathname}${url.search}` : src.replace(/^\/+/, '')
url(width)      = `${normalizeBase}/${serializeOptions({quality, format, ...transformOptions, width})}/${normalizeSource}`
```

`deliveryBase` defaults to `/cdn-cgi/image`. Options serialise as
comma-separated `key=value`, in insertion order — `quality`, `format`, then any
`transformOptions`, then the per-variant `width`.

| `src` | emitted (width=1400 variant) |
|---|---|
| `/assets/a.jpg` | `/cdn-cgi/image/quality=85,format=auto,width=1400/assets/a.jpg` |
| `https://cdn.nuasite.com/assets/x/a.jpg` | `https://cdn.nuasite.com/cdn-cgi/image/quality=85,format=auto,width=1400/assets/x/a.jpg` |

**Same-zone is structural.** For an absolute `src` the component moves the
origin into the prefix and reduces the source to a path on that same origin. It
never emits the cross-origin form
(`/cdn-cgi/image/<opts>/https://other-host/x.jpg`). So the host that serves the
image must itself be a Cloudflare zone with Image Resizing enabled —
`cdn.nuasite.com` is.

This is the whole reason the migration rewrites to absolute URLs: leaving
`/assets/a.jpg` in place after moving the file makes the *site's own* zone try
to transform a file it no longer hosts.

Note pletivo's own `buildCdnCgiImageUrl` **does** support cross-origin sources.
Do not generalise from it — the nuasite component is the one rendering these
pages.

## Two failure modes to remember

1. **`allowedDomains` + a relative `src` = no transform at all.** The guard is
   `!allowedDomains.length || (parsedSrc && allowedDomains.includes(...))`; a
   relative `src` has no parsed URL, so a non-empty `allowedDomains` makes the
   whole expression falsy and the component falls back to a plain `<img>` with
   no `srcset`. After migrating, `src` is absolute, so setting
   `allowedDomains={['cdn.nuasite.com']}` is safe — before migrating it is not.

2. **Plain `astro dev` silently degrades.** The component only transforms when
   `!import.meta.env.DEV` or `globalThis.__PLETIVO__` is set. Under vanilla
   `astro dev` nothing serves `/cdn-cgi/image`, so you get an untransformed
   `<img>`. Absolute CDN URLs still load in dev (they hit the real CDN); it is
   the *resizing* that is absent. Don't debug a "missing srcset" in dev.

## Props worth knowing

There is no flat `width`/`height`/`fit` prop — those go inside
`transformOptions`. Per-variant width comes from `widths` (default
`[480, 768, 1024, 1400]`); `sizes` defaults to
`(min-width: 1024px) 50vw, 100vw`; `quality` defaults to `85`, `format` to
`auto`.

Some option keys are remapped on serialisation: `onError → onerror`,
`slowConnectionQuality → slow-connection-quality`,
`trimBorderColor → trim.border.color`, `trimWidth → trim.width`.

## Repos that do not use the component

Plenty of sites use raw `<img src=…>`. The migration still applies and still
works — absolute CDN URLs load fine — you just get no automatic resizing. If the
user wants transforms there, that is a follow-up: switch the markup to
`<Image>`, or build the `/cdn-cgi/image/...` prefix by hand against the CDN
origin.

## Auth walls in front of a transform source

Cloudflare's image-resizing subrequest is cookie-less and carries
`Via: … image-resizing`. Any auth gate that redirects it will make CF report
**ERROR 9412 (not an image)**. If a project puts a preview/auth proxy in front
of assets, it needs an explicit carve-out for asset paths in that proxy.
