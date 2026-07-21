#!/usr/bin/env bun
/**
 * a2r — move repo-tracked assets to Cloudflare R2 behind a CDN zone.
 *
 * Subcommands: preflight | inventory | mark | upload | rewrite | verify | prune
 * Run `a2r <cmd> --help` semantics are covered by the skill's SKILL.md.
 */
import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { extname, join } from 'node:path'
import {
	type Args,
	type Manifest,
	type ManifestEntry,
	type Plan,
	type PlanFile,
	buildKey,
	buildRefMatcher,
	buildUrl,
	classify,
	contentTypeFor,
	DEFAULT_CLASSIFY,
	detectPublicRoots,
	flagBool,
	flagNum,
	findRef,
	flagStr,
	formatBytes,
	listSourceFiles,
	loadEnvFile,
	makeClient,
	MANIFEST_FILE,
	parseArgs,
	PLAN_FILE,
	pool,
	readManifest,
	readPlan,
	readPublicConfig,
	readR2Config,
	replaceRefs,
	repoRoot,
	retry,
	scanReferences,
	statePath,
	walkAssets,
	writeManifest,
	writePlan,
} from './lib.ts'

/**
 * Note on caching: Bun's S3 client cannot set per-object `Cache-Control`
 * (`S3Options` has no such field), so freshness is a zone concern — see the
 * skill's `reference/cdn-zone.md` for the Cache Rule to add.
 */

async function main() {
	const argv = Bun.argv.slice(2)
	const command = argv[0]
	const args = parseArgs(argv.slice(1))

	const envFile = flagStr(args, 'env-file')
	if (envFile) await loadEnvFile(envFile)

	const root = flagStr(args, 'repo') ?? (await repoRoot())

	switch (command) {
		case 'preflight':
			return preflight(args)
		case 'inventory':
			return inventory(root, args)
		case 'mark':
			return mark(root, args)
		case 'upload':
			return upload(root, args)
		case 'rewrite':
			return rewrite(root, args)
		case 'verify':
			return verify(root, args)
		case 'prune':
			return prune(root, args)
		default:
			console.error(
				'usage: a2r <preflight|inventory|mark|upload|rewrite|verify|prune> [options]\n' +
					'See the assets-to-r2 SKILL.md for the full workflow.',
			)
			process.exit(2)
	}
}

// ------------------------------------------------------------- preflight ---

/** Prove the credentials work and that the CDN zone actually fronts the bucket. */
async function preflight(args: Args) {
	const cfg = readR2Config({
		bucket: flagStr(args, 'bucket'),
		cdnBaseUrl: flagStr(args, 'cdn'),
		prefix: flagStr(args, 'prefix'),
	})
	console.log(`endpoint  ${cfg.endpoint}`)
	console.log(`bucket    ${cfg.bucket}`)
	console.log(`cdn base  ${cfg.cdnBaseUrl}`)

	const client = makeClient(cfg)
	const listed = await client.list({ maxKeys: 3 })
	const keys = listed.contents?.map(o => o.key) ?? []
	console.log(`\n✓ bucket readable — ${listed.keyCount ?? keys.length} key(s) sampled`)
	for (const k of keys) console.log(`    ${k}`)

	// Round-trip a throwaway object through the bucket and back over the CDN.
	const slug = flagStr(args, 'slug')
	if (!slug) {
		console.log('\n(pass --slug to also round-trip a probe object through the CDN zone)')
		return
	}
	const probeKey = `${cfg.prefix}/${slug}/.a2r-preflight.txt`
	const probeUrl = buildUrl(cfg.cdnBaseUrl, probeKey)
	const body = `a2r preflight ${slug}`
	await client.write(probeKey, body, { type: 'text/plain' })
	console.log(`\n✓ wrote probe ${probeKey}`)

	const res = await fetch(probeUrl, { cache: 'no-store' })
	const text = res.ok ? (await res.text()).trim() : ''
	if (res.ok && text === body) {
		console.log(`✓ CDN serves the bucket at ${probeUrl}`)
	} else {
		console.log(`✗ CDN did NOT serve the probe (HTTP ${res.status}) at ${probeUrl}`)
		console.log(`  The zone ${cfg.cdnBaseUrl} may not be bound to bucket ${cfg.bucket}, or not at its root.`)
	}
	await client.delete(probeKey)
	console.log('✓ probe deleted')
	if (!res.ok) process.exit(1)
}

// ------------------------------------------------------------- inventory ---

async function inventory(root: string, args: Args) {
	const slug = flagStr(args, 'slug')
	if (!slug) throw new Error('--slug is required (the project slug under assets/, supplied by the operator)')

	const pub = readPublicConfig({
		bucket: flagStr(args, 'bucket'),
		cdnBaseUrl: flagStr(args, 'cdn'),
		prefix: flagStr(args, 'prefix'),
	})
	const keepPrefix = flagBool(args, 'keep-prefix')
	const opts = {
		bigBytes: flagNum(args, 'big', DEFAULT_CLASSIFY.bigBytes),
		smallBytes: flagNum(args, 'small', DEFAULT_CLASSIFY.smallBytes),
	}

	const rootsFlag = flagStr(args, 'root')
	const roots = rootsFlag ? rootsFlag.split(',').map(s => s.trim()).filter(Boolean) : await detectPublicRoots(root)
	if (!roots.length) throw new Error('no public asset root found — pass --root <dir> (relative to repo root)')

	const assets: Array<{ path: string; publicPath: string; size: number; ref: string }> = []
	for (const r of roots) {
		for (const a of await walkAssets(root, r)) {
			assets.push({ ...a, ref: `/${a.publicPath}` })
		}
	}
	if (!assets.length) throw new Error(`no files under: ${roots.join(', ')}`)

	const matcher = buildRefMatcher(assets.map(a => a.ref))
	const sources = await listSourceFiles(root, roots, { includeGenerated: true })
	const refCounts = await scanReferences(root, sources, matcher)

	const files: PlanFile[] = []
	const seenKeys = new Map<string, string>()
	const collisions: string[] = []

	for (const a of assets) {
		const refs = refCounts.get(a.ref) ?? { content: 0, code: 0, style: 0, generated: 0, total: 0 }
		const verdict = classify(a, refs, opts)
		const key = buildKey(a.publicPath, slug, pub.prefix, keepPrefix)
		const prior = seenKeys.get(key)
		if (prior && prior !== a.path) collisions.push(`${key}\n    ${prior}\n    ${a.path}`)
		seenKeys.set(key, a.path)
		files.push({
			path: a.path,
			ref: a.ref,
			key,
			url: buildUrl(pub.cdnBaseUrl, key),
			size: a.size,
			contentType: await contentTypeFor(join(root, a.path)),
			action: verdict.action,
			class: verdict.class,
			reason: verdict.reason,
			refs,
		})
	}

	if (collisions.length) {
		console.error(`✗ ${collisions.length} key collision(s) — two local files map to the same R2 key:\n`)
		for (const c of collisions.slice(0, 20)) console.error(`  ${c}\n`)
		console.error(`Detected roots: ${roots.join(', ')}`)
		console.error(
			'Narrow to one root (--root packages/web/public), give each root its own slug,\n' +
				'or keep the original layout with --keep-prefix.',
		)
		process.exit(1)
	}

	const plan: Plan = {
		version: 1,
		repoRoot: root,
		slug,
		cdnBaseUrl: pub.cdnBaseUrl,
		prefix: pub.prefix,
		bucket: pub.bucket,
		roots,
		files,
	}
	const path = await writePlan(root, plan)

	console.log(`roots     ${roots.join(', ')}`)
	console.log(`sources   ${sources.length} text file(s) scanned for references`)
	console.log(`plan      ${path}\n`)
	printPlanSummary(plan)
	console.log(
		'\nNext: review the buckets above with the user, adjust with `a2r mark`, then `a2r upload --dry-run`.',
	)
}

function printPlanSummary(plan: Plan) {
	const groups = new Map<string, PlanFile[]>()
	for (const f of plan.files) {
		const k = `${f.action}/${f.class}`
		groups.set(k, [...(groups.get(k) ?? []), f])
	}
	const order = ['move/data', 'keep/uncertain', 'keep/chrome', 'move/uncertain', 'move/chrome', 'keep/data']
	const sortedKeys = [...groups.keys()].sort((a, b) => {
		const ia = order.indexOf(a), ib = order.indexOf(b)
		return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
	})

	console.log('action/class      files          size')
	console.log('─'.repeat(46))
	for (const k of sortedKeys) {
		const g = groups.get(k)!
		const bytes = g.reduce((n, f) => n + f.size, 0)
		console.log(`${k.padEnd(18)}${String(g.length).padStart(5)}  ${formatBytes(bytes).padStart(12)}`)
	}
	const moving = plan.files.filter(f => f.action === 'move')
	console.log('─'.repeat(46))
	console.log(
		`${'MOVING'.padEnd(18)}${String(moving.length).padStart(5)}  ${
			formatBytes(moving.reduce((n, f) => n + f.size, 0)).padStart(12)
		}`,
	)

	const uncertain = plan.files.filter(f => f.class === 'uncertain')
	if (uncertain.length) {
		console.log(`\n${uncertain.length} uncertain file(s) — ask the user before deciding. Sample:`)
		for (const f of uncertain.slice(0, 15)) {
			console.log(`  [${f.action}] ${f.path}  (${formatBytes(f.size)}) — ${f.reason}`)
		}
		if (uncertain.length > 15) console.log(`  … and ${uncertain.length - 15} more (see ${PLAN_FILE})`)
	}
}

// ------------------------------------------------------------------ mark ---

/** Bulk-reclassify plan entries after checking with the user. */
async function mark(root: string, args: Args) {
	const action = args._[0]
	if (action !== 'move' && action !== 'keep') throw new Error('usage: a2r mark <move|keep> --match <glob> [--class <data|chrome|uncertain>] [--min-size N] [--ext .pdf,.jpg]')

	const plan = await readPlan(root)
	const match = flagStr(args, 'match')
	const klass = flagStr(args, 'class')
	const minSize = flagStr(args, 'min-size') ? flagNum(args, 'min-size', 0) : undefined
	const exts = flagStr(args, 'ext')?.split(',').map(s => s.trim().toLowerCase())
	const glob = match ? new Bun.Glob(match) : undefined

	let changed = 0
	for (const f of plan.files) {
		if (glob && !glob.match(f.path)) continue
		if (klass && f.class !== klass) continue
		if (minSize !== undefined && f.size < minSize) continue
		if (exts && !exts.includes(extname(f.path).toLowerCase())) continue
		if (f.action === action) continue
		f.action = action
		f.reason = `${f.reason} → set to ${action} by operator`
		if (f.class === 'uncertain') f.class = action === 'move' ? 'data' : 'chrome'
		changed++
	}
	await writePlan(root, plan)
	console.log(`marked ${changed} file(s) as ${action}\n`)
	printPlanSummary(plan)
}

// ---------------------------------------------------------------- upload ---

async function upload(root: string, args: Args) {
	const plan = await readPlan(root)
	const dryRun = flagBool(args, 'dry-run')
	const force = flagBool(args, 'force')
	const concurrency = flagNum(args, 'concurrency', 8)

	const targets = plan.files.filter(f => f.action === 'move')
	const totalBytes = targets.reduce((n, f) => n + f.size, 0)
	console.log(`${targets.length} file(s), ${formatBytes(totalBytes)} → ${plan.bucket} as ${plan.prefix}/${plan.slug}/…`)

	if (dryRun) {
		console.log('\n--dry-run: nothing uploaded. Sample of what would go up:\n')
		for (const f of targets.slice(0, 15)) {
			console.log(`  ${f.key}`)
			console.log(`      ← ${f.path}  (${formatBytes(f.size)}, ${f.contentType})`)
		}
		if (targets.length > 15) console.log(`  … and ${targets.length - 15} more`)
		return
	}

	const cfg = readR2Config({ bucket: plan.bucket, cdnBaseUrl: plan.cdnBaseUrl, prefix: plan.prefix })
	const client = makeClient(cfg)

	let done = 0
	let uploadedBytes = 0
	const entries = await pool(targets, concurrency, async (f): Promise<ManifestEntry> => {
		const base = { path: f.path, ref: f.ref, key: f.key, url: f.url, size: f.size, contentType: f.contentType }
		try {
			if (!force) {
				const existing = await client.stat(f.key).catch(() => null)
				if (existing && existing.size === f.size) {
					done++
					return { ...base, status: 'skipped' }
				}
			}
			await retry(3, async () => {
				await client.write(f.key, Bun.file(join(root, f.path)), { type: f.contentType })
			})
			done++
			uploadedBytes += f.size
			if (done % 25 === 0 || done === targets.length) {
				console.log(`  ${done}/${targets.length}  (${formatBytes(uploadedBytes)} uploaded)`)
			}
			return { ...base, status: 'uploaded' }
		} catch (error) {
			done++
			const message = error instanceof Error ? error.message : String(error)
			console.error(`  ✗ ${f.path}: ${message}`)
			return { ...base, status: 'failed', error: message }
		}
	})

	const manifest: Manifest = {
		version: 1,
		slug: plan.slug,
		bucket: plan.bucket,
		cdnBaseUrl: plan.cdnBaseUrl,
		entries,
	}
	const path = await writeManifest(root, manifest)
	const failed = entries.filter(e => e.status === 'failed')
	const skipped = entries.filter(e => e.status === 'skipped')
	console.log(
		`\nuploaded ${entries.length - failed.length - skipped.length}, skipped ${skipped.length} (already present), failed ${failed.length}`,
	)
	console.log(`manifest ${path}`)
	if (failed.length) {
		console.error('\nRe-run `a2r upload` to retry the failures before rewriting references.')
		process.exit(1)
	}
}

// --------------------------------------------------------------- rewrite ---

async function rewrite(root: string, args: Args) {
	const plan = await readPlan(root)
	const manifest = await readManifest(root)
	const apply = flagBool(args, 'apply')

	const map = new Map<string, string>()
	for (const e of manifest.entries) {
		if (e.status === 'failed') continue
		map.set(e.ref, e.url)
	}
	if (!map.size) throw new Error('manifest has no successfully uploaded entries — nothing to rewrite')

	const matcher = buildRefMatcher(map.keys())
	const sources = await listSourceFiles(root, plan.roots)
	let filesTouched = 0
	let replacements = 0
	const perFile: Array<{ file: string; count: number }> = []
	const hit = new Set<string>()

	await pool(sources, 16, async file => {
		const abs = join(root, file)
		const text = await Bun.file(abs).text().catch(() => null)
		if (text === null) return
		const { text: next, count } = replaceRefs(text, matcher, ref => {
			const url = map.get(ref)
			if (url) hit.add(ref)
			return url
		})
		if (!count) return
		filesTouched++
		replacements += count
		perFile.push({ file, count })
		if (apply) await Bun.write(abs, next)
	})

	perFile.sort((a, b) => b.count - a.count)
	console.log(`${apply ? 'rewrote' : 'would rewrite'} ${replacements} reference(s) in ${filesTouched} file(s)`)
	for (const p of perFile.slice(0, 15)) console.log(`  ${String(p.count).padStart(4)}  ${p.file}`)
	if (perFile.length > 15) console.log(`  … and ${perFile.length - 15} more file(s)`)

	const unreferenced = [...map.keys()].filter(k => !hit.has(k))
	if (unreferenced.length) {
		console.log(
			`\n${unreferenced.length} uploaded asset(s) had no textual reference in tracked sources.`,
		)
		console.log('That is normal for CMS-driven or orphaned media, but check a few:')
		for (const u of unreferenced.slice(0, 10)) console.log(`  ${u}`)
	}
	if (!apply) console.log('\n--dry-run by default. Re-run with --apply to write the changes.')
}

// ---------------------------------------------------------------- verify ---

async function verify(root: string, args: Args) {
	const manifest = await readManifest(root)
	const concurrency = flagNum(args, 'concurrency', 12)
	const samples = flagNum(args, 'samples', 5)
	const live = manifest.entries.filter(e => e.status !== 'failed')

	let ok = 0
	const problems: string[] = []
	await pool(live, concurrency, async e => {
		try {
			const res = await fetch(e.url, { method: 'HEAD', cache: 'no-store' })
			if (!res.ok) {
				problems.push(`HTTP ${res.status}  ${e.url}`)
				return
			}
			const len = Number(res.headers.get('content-length') ?? '0')
			if (len && len !== e.size) {
				problems.push(`size ${len} ≠ local ${e.size}  ${e.url}`)
				return
			}
			// octet-stream makes a browser download rather than render the asset
			const served = (res.headers.get('content-type') ?? '').split(';')[0]!.trim()
			if (served === 'application/octet-stream' && e.contentType !== 'application/octet-stream') {
				problems.push(`served as octet-stream, expected ${e.contentType}  ${e.url}`)
				return
			}
			ok++
		} catch (error) {
			problems.push(`${error instanceof Error ? error.message : String(error)}  ${e.url}`)
		}
	})
	console.log(`✓ ${ok}/${live.length} object(s) reachable on the CDN`)
	if (problems.length) {
		console.log(`\n✗ ${problems.length} problem(s):`)
		for (const p of problems.slice(0, 25)) console.log(`  ${p}`)
	}

	// cdn-cgi transform spot-check — this is what the nuasite <Image> component hits.
	// Send a browser-like Accept: with `format=auto` the negotiated type depends on
	// it, and a bare fetch would report jpeg where a real visitor gets webp/avif.
	const BROWSER_ACCEPT = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
	// Select by sniffed type, not extension — extensionless crawled media is
	// exactly the case most likely to be broken.
	const rasters = live
		.filter(e => e.contentType.startsWith('image/') && e.contentType !== 'image/svg+xml')
		.slice(0, samples)
	if (rasters.length) {
		console.log(`\ncdn-cgi transform spot-check (${rasters.length} sample(s)):`)
		for (const e of rasters) {
			const transformUrl = `${manifest.cdnBaseUrl}/cdn-cgi/image/quality=85,format=auto,width=480/${e.key}`
			try {
				const res = await fetch(transformUrl, { cache: 'no-store', headers: { accept: BROWSER_ACCEPT } })
				const type = res.headers.get('content-type') ?? ''
				const bytes = Number(res.headers.get('content-length') ?? '0')
				if (!res.ok) {
					problems.push(`transform HTTP ${res.status}  ${transformUrl}`)
					console.log(`  ✗ HTTP ${res.status}  ${transformUrl}`)
				} else if (!type.startsWith('image/')) {
					problems.push(`transform returned ${type}  ${transformUrl}`)
					console.log(`  ✗ ${type} (image resizing may be off for this zone)  ${transformUrl}`)
				} else {
					console.log(`  ✓ ${type} ${formatBytes(bytes)} (from ${formatBytes(e.size)})  width=480`)
				}
			} catch (error) {
				problems.push(`${error instanceof Error ? error.message : String(error)}  ${transformUrl}`)
				console.log(`  ✗ ${error instanceof Error ? error.message : String(error)}`)
			}
		}
	}

	// leftover local references to moved assets
	const plan = await readPlan(root).catch(() => null)
	if (plan) {
		const matcher = buildRefMatcher(live.map(e => e.ref))
		const sources = await listSourceFiles(root, plan.roots)
		const leftovers: string[] = []
		await pool(sources, 16, async file => {
			const text = await Bun.file(join(root, file)).text().catch(() => null)
			if (text === null) return
			const stale = findRef(text, matcher)
			if (stale) leftovers.push(`${file}: ${stale}`)
		})
		if (leftovers.length) {
			console.log(`\n✗ ${leftovers.length} file(s) still reference moved assets by local path:`)
			for (const l of leftovers.slice(0, 15)) console.log(`  ${l}`)
			problems.push(`${leftovers.length} stale local reference(s)`)
		} else {
			console.log('\n✓ no stale local references to moved assets')
		}
	}

	if (problems.length) process.exit(1)
	console.log('\nAll checks passed — safe to `a2r prune`.')
}

// ----------------------------------------------------------------- prune ---

async function prune(root: string, args: Args) {
	const manifest = await readManifest(root)
	const apply = flagBool(args, 'apply')
	const targets = manifest.entries.filter(e => e.status !== 'failed')
	if (!targets.length) throw new Error('nothing to prune')

	const bytes = targets.reduce((n, e) => n + e.size, 0)
	console.log(`${apply ? 'removing' : 'would remove'} ${targets.length} local file(s), ${formatBytes(bytes)}`)
	if (!apply) {
		for (const e of targets.slice(0, 10)) console.log(`  ${e.path}`)
		if (targets.length > 10) console.log(`  … and ${targets.length - 10} more`)
		console.log('\nRe-run with --apply. Run `a2r verify` first — prune does not re-check the CDN.')
		return
	}

	const paths = targets.map(e => e.path).filter(p => existsSync(join(root, p)))
	for (let i = 0; i < paths.length; i += 200) {
		const chunk = paths.slice(i, i + 200)
		const proc = Bun.spawn(['git', 'rm', '-q', '-f', '--ignore-unmatch', '--', ...chunk], {
			cwd: root,
			stdout: 'pipe',
			stderr: 'pipe',
		})
		if ((await proc.exited) !== 0) {
			console.error(await new Response(proc.stderr).text())
			throw new Error('git rm failed — resolve and re-run')
		}
	}
	// untracked leftovers git rm ignored
	let unlinked = 0
	for (const p of paths) {
		const abs = join(root, p)
		if (existsSync(abs)) {
			await unlink(abs)
			unlinked++
		}
	}
	console.log(`✓ removed ${paths.length} file(s) (${unlinked} were untracked)`)
	console.log(`\nState kept in ${statePath(root, PLAN_FILE)} and ${statePath(root, MANIFEST_FILE)}.`)
	console.log('Add .a2r/ to .gitignore, then review `git status` and commit.')
}

main().catch(error => {
	console.error(`✗ ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
})
