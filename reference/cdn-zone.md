# CDN zone notes

## Where the bytes live

The CDN hostname must serve the selected R2 bucket at its root. Supply the
bucket explicitly through `R2_BUCKET` or `--bucket`, and set `CDN_BASE_URL` or
`--cdn` if using a hostname other than `cdn.nuasite.com`.

Assets from this skill land at:

```
<bucket>/assets/<project-slug>/<path-under-the-public-root>
        └─ served as https://cdn.nuasite.com/assets/<project-slug>/<path>
```

A leading `assets/` segment in the local public path is stripped, so
`public/assets/a.jpg` becomes `assets/<slug>/a.jpg`, not
`assets/<slug>/assets/a.jpg`. Other directories keep their shape:
`public/dokumenty/x.pdf` → `assets/<slug>/dokumenty/x.pdf`. Pass `--keep-prefix`
to disable the stripping.

`a2r preflight --slug <slug>` proves this end to end: it writes a probe object
and fetches it back over the CDN hostname. Run it before any bulk upload — an
unbound zone means a 404 for every asset after the rewrite.

## Caching

`a2r upload` does not set per-object `Cache-Control`: Bun's `S3Options` has no
such field, so the S3 client cannot attach the header. Set caching at the zone
instead — a Cache Rule matching `/assets/*` with a long edge TTL and browser
TTL. This is the better place for it anyway: the filenames are content-hashed,
so `public, max-age=31536000, immutable` is appropriate and can be changed
without re-uploading anything.

If per-object metadata is genuinely required, `wrangler r2 object put
<bucket>/<key> --file <path> --cache-control '…' --remote` sets it — but it is
one HTTP request per object, far too slow for a bulk migration.

## Fonts and CORS

Cross-origin fonts need `Access-Control-Allow-Origin` on the response. The
classifier keeps `.woff/.woff2/.ttf/.otf` in the repo by default for exactly
this reason — a local font is the boring, working default. If a project does
want fonts on the CDN, add the CORS policy to the bucket first and verify a real
`@font-face` load in a browser, not just a 200 from `curl`.

## Read-only

Nothing in this flow gives the website write access to the bucket. Uploads run
from an operator machine or CI with the R2 keys; the site only ever fetches over
HTTPS. Keep the website's access read-only.
