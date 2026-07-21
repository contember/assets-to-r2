/**
 * Shared plumbing for the assets-to-r2 skill: config, repo walking, reference
 * scanning, classification heuristics, and plan/manifest persistence.
 */
import { S3Client } from 'bun'
import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join, relative, resolve, sep } from 'node:path'

export const STATE_DIR = '.a2r'
export const PLAN_FILE = 'plan.json'
export const MANIFEST_FILE = 'manifest.json'

export type Action = 'move' | 'keep'
export type Klass = 'data' | 'chrome' | 'uncertain'

export interface RefCounts {
	content: number
	code: number
	style: number
	/** Refs found only in committed build caches (e.g. `.astro/data-store.json`). */
	generated: number
	total: number
}

export interface PlanFile {
	/** Path relative to repo root. */
	path: string
	/** Public root-relative URL the site currently uses, e.g. `/assets/foo.jpg`. */
	ref: string
	/** R2 object key, e.g. `assets/<slug>/foo.jpg`. */
	key: string
	/** Absolute CDN URL after the move. */
	url: string
	size: number
	contentType: string
	action: Action
	class: Klass
	reason: string
	refs: RefCounts
}

export interface Plan {
	version: 1
	repoRoot: string
	slug: string
	cdnBaseUrl: string
	prefix: string
	bucket: string
	roots: string[]
	files: PlanFile[]
}

export type UploadStatus = 'uploaded' | 'skipped' | 'failed'

export interface ManifestEntry {
	path: string
	ref: string
	key: string
	url: string
	size: number
	contentType: string
	status: UploadStatus
	error?: string
}

export interface Manifest {
	version: 1
	slug: string
	bucket: string
	cdnBaseUrl: string
	entries: ManifestEntry[]
}

// ---------------------------------------------------------------- config ---

export interface R2Config {
	accessKeyId: string
	secretAccessKey: string
	bucket: string
	region: string
	endpoint: string
	cdnBaseUrl: string
	prefix: string
}

const DEFAULT_CDN_BASE = 'https://cdn.nuasite.com'
const DEFAULT_PREFIX = 'assets'

/** Parse a dotenv-shaped file (.env, .dev.vars) into the process env, without overwriting. */
export async function loadEnvFile(path: string): Promise<void> {
	if (!existsSync(path)) throw new Error(`env file not found: ${path}`)
	const text = await readFile(path, 'utf8')
	for (const raw of text.split('\n')) {
		const line = raw.trim()
		if (!line || line.startsWith('#')) continue
		const eq = line.indexOf('=')
		if (eq === -1) continue
		const key = line.slice(0, eq).trim()
		let value = line.slice(eq + 1).trim()
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1)
		}
		if (process.env[key] === undefined) process.env[key] = value
	}
}

export function readR2Config(overrides: { bucket?: string; cdnBaseUrl?: string; prefix?: string } = {}): R2Config {
	const publicConfig = readPublicConfig(overrides)
	const env = process.env
	const accountId = env.R2_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID
	const endpoint = env.R2_ENDPOINT ??
		(accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined)

	const missing: string[] = []
	if (!env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID')
	if (!env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY')
	if (!endpoint) missing.push('R2_ENDPOINT (or R2_ACCOUNT_ID)')
	if (missing.length) {
		throw new Error(
			`missing R2 credentials in env: ${missing.join(', ')}\n` +
				`Set them in the shell, or point --env-file at a dotenv file (.env / .dev.vars).`,
		)
	}

	return {
		...publicConfig,
		accessKeyId: env.R2_ACCESS_KEY_ID!,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
		region: env.R2_REGION ?? 'auto',
		endpoint: endpoint!,
	}
}

/** Config values that don't require credentials — used by inventory/rewrite/dry runs. */
export function readPublicConfig(overrides: { bucket?: string; cdnBaseUrl?: string; prefix?: string } = {}) {
	const bucket = overrides.bucket ?? process.env.R2_BUCKET
	if (!bucket) throw new Error('missing R2_BUCKET — set it in the environment or pass --bucket')

	return {
		bucket,
		cdnBaseUrl: stripTrailingSlash(overrides.cdnBaseUrl ?? process.env.CDN_BASE_URL ?? DEFAULT_CDN_BASE),
		prefix: trimSlashes(overrides.prefix ?? process.env.CDN_ASSET_PREFIX ?? DEFAULT_PREFIX),
	}
}

export function makeClient(cfg: R2Config): S3Client {
	return new S3Client({
		accessKeyId: cfg.accessKeyId,
		secretAccessKey: cfg.secretAccessKey,
		bucket: cfg.bucket,
		region: cfg.region,
		endpoint: cfg.endpoint,
	})
}

// ------------------------------------------------------------------ util ---

export const stripTrailingSlash = (s: string) => s.replace(/\/+$/, '')
export const trimSlashes = (s: string) => s.replace(/^\/+|\/+$/g, '')

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`
	if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} kB`
	if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
	return `${(n / 1024 ** 3).toFixed(2)} GB`
}

export async function repoRoot(cwd = process.cwd()): Promise<string> {
	const proc = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], { cwd, stdout: 'pipe', stderr: 'ignore' })
	const out = (await new Response(proc.stdout).text()).trim()
	if ((await proc.exited) !== 0 || !out) return resolve(cwd)
	return out
}

export function statePath(root: string, file: string): string {
	return join(root, STATE_DIR, file)
}

export async function readPlan(root: string): Promise<Plan> {
	const path = statePath(root, PLAN_FILE)
	if (!existsSync(path)) throw new Error(`no plan at ${path} — run \`a2r inventory\` first`)
	return JSON.parse(await readFile(path, 'utf8')) as Plan
}

export async function writePlan(root: string, plan: Plan): Promise<string> {
	const path = statePath(root, PLAN_FILE)
	await Bun.write(path, JSON.stringify(plan, null, '\t') + '\n')
	return path
}

export async function readManifest(root: string): Promise<Manifest> {
	const path = statePath(root, MANIFEST_FILE)
	if (!existsSync(path)) throw new Error(`no manifest at ${path} — run \`a2r upload\` first`)
	return JSON.parse(await readFile(path, 'utf8')) as Manifest
}

export async function writeManifest(root: string, manifest: Manifest): Promise<string> {
	const path = statePath(root, MANIFEST_FILE)
	await Bun.write(path, JSON.stringify(manifest, null, '\t') + '\n')
	return path
}

/** Run `fn` over `items` with bounded concurrency, preserving input order in the result. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length)
	let cursor = 0
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (true) {
			const i = cursor++
			if (i >= items.length) return
			results[i] = await fn(items[i]!, i)
		}
	})
	await Promise.all(workers)
	return results
}

export async function retry<T>(attempts: number, fn: () => Promise<T>): Promise<T> {
	let lastError: unknown
	for (let i = 0; i < attempts; i++) {
		try {
			return await fn()
		} catch (error) {
			lastError = error
			if (i < attempts - 1) await Bun.sleep(250 * 2 ** i)
		}
	}
	throw lastError
}

// -------------------------------------------------------- asset scanning ---

/** Directories that never hold site assets. */
const SKIP_DIRS = new Set([
	'node_modules', '.git', 'dist', 'build', '.astro', '.next', '.cache', '.output',
	'.turbo', '.wrangler', '.lopata', '.a2r', 'coverage',
])

/** Public roots we look for, in order of preference. Relative to repo root. */
const PUBLIC_ROOT_CANDIDATES = ['public', 'static', 'assets', 'src/assets']

/** Find plausible public roots: `public/` at repo root or inside any workspace package. */
export async function detectPublicRoots(root: string): Promise<string[]> {
	const found: string[] = []
	const check = async (rel: string) => {
		const abs = join(root, rel)
		if (!existsSync(abs)) return
		if ((await stat(abs)).isDirectory()) found.push(rel)
	}
	for (const c of PUBLIC_ROOT_CANDIDATES) await check(c)

	// one level of monorepo packages: packages/*/public, apps/*/public
	for (const group of ['packages', 'apps']) {
		const abs = join(root, group)
		if (!existsSync(abs)) continue
		for (const entry of await readdir(abs, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue
			for (const c of PUBLIC_ROOT_CANDIDATES) await check(join(group, entry.name, c))
		}
	}
	return found
}

export interface AssetFile {
	/** Path relative to repo root. */
	path: string
	/** Path relative to its public root — this is what the site serves. */
	publicPath: string
	size: number
}

export async function walkAssets(root: string, publicRoot: string): Promise<AssetFile[]> {
	const out: AssetFile[] = []
	const base = join(root, publicRoot)
	const walk = async (dir: string) => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (SKIP_DIRS.has(entry.name)) continue
			const abs = join(dir, entry.name)
			if (entry.isDirectory()) {
				await walk(abs)
			} else if (entry.isFile()) {
				const { size } = await stat(abs)
				out.push({
					path: relative(root, abs).split(sep).join('/'),
					publicPath: relative(base, abs).split(sep).join('/'),
					size,
				})
			}
		}
	}
	await walk(base)
	return out
}

// ----------------------------------------------------- reference scanning ---

const CONTENT_EXT = new Set(['.md', '.mdx', '.markdown', '.json', '.yaml', '.yml', '.csv', '.toml'])
const CODE_EXT = new Set([
	'.astro', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.html', '.htm', '.php',
])
const STYLE_EXT = new Set(['.css', '.scss', '.sass', '.less', '.styl'])

const SCANNABLE = new Set([...CONTENT_EXT, ...CODE_EXT, ...STYLE_EXT])

/** A committed build cache — a usage signal, but never safe to rewrite. */
export function isGenerated(file: string): boolean {
	return file.split('/').some(segment => SKIP_DIRS.has(segment))
}

/**
 * Text files tracked by git, minus the asset roots themselves.
 *
 * Committed build caches (`.astro/data-store.json` and friends) are included
 * only for reference *counting* — they prove an asset is in use. They are never
 * rewritten, because they are regenerated from the sources they mirror.
 */
export async function listSourceFiles(
	root: string,
	publicRoots: string[],
	opts: { includeGenerated?: boolean } = {},
): Promise<string[]> {
	const proc = Bun.spawn(['git', 'ls-files', '-z'], { cwd: root, stdout: 'pipe', stderr: 'ignore' })
	const raw = await new Response(proc.stdout).text()
	const files = raw.split('\0').filter(Boolean)
	return files.filter(f => {
		if (!SCANNABLE.has(extname(f).toLowerCase())) return false
		if (publicRoots.some(r => f.startsWith(`${r}/`))) return false
		return opts.includeGenerated === true || !isGenerated(f)
	})
}

export function kindOf(file: string): keyof Omit<RefCounts, 'total'> {
	if (isGenerated(file)) return 'generated'
	const ext = extname(file).toLowerCase()
	if (CONTENT_EXT.has(ext)) return 'content'
	if (STYLE_EXT.has(ext)) return 'style'
	return 'code'
}

// ------------------------------------------------------------ ref matching ---

export interface RefMatcher {
	/** Matched text (possibly percent-encoded) → canonical ref. */
	canonical: Map<string, string>
}

/**
 * Any maximal root-relative path run.
 *
 * Deliberately does NOT require a file extension: assets crawled from a CMS
 * regularly have none, and an extension-shaped tokenizer skips them silently.
 * Matching maximally is also what makes it boundary-safe — `/assets/a.jpg`
 * cannot match inside `/assets/a.jpg.webp` (the longer run wins) nor inside
 * `/deep/assets/a.jpg` (the run starts at `/deep`), and the leading `/` of an
 * absolute URL is never a match start because `//` breaks the pattern.
 *
 * The lookbehind stops a run from starting mid-token. Without it a *relative*
 * path like `public/assets/a.jpg` matches at `/assets/a.jpg` and the rewrite
 * leaves the prefix glued to the replacement (`publichttps://cdn…`). Only a
 * root-relative path — one not preceded by a path character — is a reference.
 * `/` is deliberately absent from the class so `//` still starts a run at the
 * second slash, preserving the absolute-URL behaviour above.
 */
const PATH_RUN = /(?<![A-Za-z0-9._~%@-])\/[A-Za-z0-9._~%@-]+(?:\/[A-Za-z0-9._~%@-]+)*/g

/**
 * Build a lookup for a known set of public paths. Matching is a single linear
 * tokenizing pass plus O(1) map hits — an alternation over thousands of
 * literals compiles fine but runs orders of magnitude slower.
 */
export function buildRefMatcher(refs: Iterable<string>): RefMatcher {
	const canonical = new Map<string, string>()
	for (const ref of refs) {
		canonical.set(ref, ref)
		// markdown/HTML often percent-encode spaces and diacritics
		const encoded = encodeURI(ref)
		if (encoded !== ref) canonical.set(encoded, ref)
	}
	return { canonical }
}

/** Replace every known ref in `text`; `fn` maps a canonical ref to its replacement. */
export function replaceRefs(
	text: string,
	matcher: RefMatcher,
	fn: (ref: string) => string | undefined,
): { text: string; count: number } {
	let count = 0
	const out = text.replace(PATH_RUN, match => {
		const ref = matcher.canonical.get(match)
		const replacement = ref === undefined ? undefined : fn(ref)
		if (replacement === undefined) return match
		count++
		return replacement
	})
	return { text: out, count }
}

/** First known ref occurring in `text`, or undefined. */
export function findRef(text: string, matcher: RefMatcher): string | undefined {
	for (const match of text.matchAll(PATH_RUN)) {
		const ref = matcher.canonical.get(match[0])
		if (ref !== undefined) return ref
	}
	return undefined
}

/**
 * Count, for every known public path, how many source files reference it and of
 * what kind — one pass over the sources rather than a search per asset.
 */
export async function scanReferences(
	root: string,
	sourceFiles: string[],
	matcher: RefMatcher,
): Promise<Map<string, RefCounts>> {
	const counts = new Map<string, RefCounts>()
	const bump = (ref: string, kind: keyof Omit<RefCounts, 'total'>) => {
		let c = counts.get(ref)
		if (!c) counts.set(ref, (c = { content: 0, code: 0, style: 0, generated: 0, total: 0 }))
		c[kind]++
		c.total++
	}

	await pool(sourceFiles, 16, async file => {
		const kind = kindOf(file)
		let text: string
		try {
			text = await readFile(join(root, file), 'utf8')
		} catch {
			return
		}
		for (const match of text.matchAll(PATH_RUN)) {
			const ref = matcher.canonical.get(match[0])
			if (ref !== undefined) bump(ref, kind)
		}
	})
	return counts
}

// ------------------------------------------------------- classification ---

/** Extensions that are site furniture by nature, never article payload. */
const CHROME_EXT = new Set(['.svg', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot'])
const CHROME_DIR = /(^|\/)(fonts?|gfx|icons?|logos?|brand|ui|favicons?|sprites?)(\/|$)/i
const CHROME_NAME = /(logo|favicon|icon|sprite|placeholder|og-image|apple-touch|touch-icon|manifest)/i

export interface ClassifyOptions {
	/** Anything at or above this is payload regardless of other signals. */
	bigBytes: number
	/** Below this, a code-only-referenced file is assumed to be site furniture. */
	smallBytes: number
}

export const DEFAULT_CLASSIFY: ClassifyOptions = { bigBytes: 1_048_576, smallBytes: 102_400 }

export function classify(
	file: AssetFile,
	refs: RefCounts,
	opts: ClassifyOptions = DEFAULT_CLASSIFY,
): { action: Action; class: Klass; reason: string } {
	const ext = extname(file.publicPath).toLowerCase()
	const name = basename(file.publicPath)
	const big = file.size >= opts.bigBytes

	const chromeSignals: string[] = []
	if (CHROME_EXT.has(ext)) chromeSignals.push(`${ext} is site furniture`)
	if (CHROME_DIR.test(file.publicPath)) chromeSignals.push('lives in a chrome directory')
	if (CHROME_NAME.test(name)) chromeSignals.push('name looks like chrome')

	if (chromeSignals.length) {
		// A multi-MB "logo" is not a logo. Let the operator decide.
		if (big) {
			return {
				action: 'keep',
				class: 'uncertain',
				reason: `${chromeSignals[0]}, but ${formatBytes(file.size)} is payload-sized — confirm with the user`,
			}
		}
		return { action: 'keep', class: 'chrome', reason: chromeSignals[0]! }
	}

	if (big) {
		return { action: 'move', class: 'data', reason: `${formatBytes(file.size)} — payload regardless of usage` }
	}
	// A ref from a build cache still proves the asset is content, not chrome.
	const dataRefs = refs.content + refs.generated
	if (dataRefs > 0) {
		const from = refs.content > 0 ? `${refs.content} content file(s)` : `${refs.generated} build cache(s)`
		return { action: 'move', class: 'data', reason: `referenced from ${from}` }
	}
	if (refs.total === 0 && file.size >= opts.smallBytes) {
		return { action: 'move', class: 'data', reason: `unreferenced and ${formatBytes(file.size)} — orphaned upload` }
	}
	if (refs.total > 0 && file.size < opts.smallBytes) {
		return {
			action: 'keep',
			class: 'chrome',
			reason: `only referenced from code/styles, ${formatBytes(file.size)}`,
		}
	}
	return {
		action: 'keep',
		class: 'uncertain',
		reason:
			`${formatBytes(file.size)}, ${refs.content} content / ${refs.code} code / ${refs.style} style / ${refs.generated} cache refs`,
	}
}

// -------------------------------------------------------------- key rules ---

/**
 * Build the R2 key for an asset.
 *
 * The CDN prefix is already `assets/<slug>`, so a leading `assets/` segment in
 * the public path is stripped to avoid `assets/<slug>/assets/foo.jpg`.
 */
export function buildKey(publicPath: string, slug: string, prefix: string, keepPrefix = false): string {
	let rel = trimSlashes(publicPath)
	if (!keepPrefix && rel.startsWith(`${prefix}/`)) rel = rel.slice(prefix.length + 1)
	return `${prefix}/${slug}/${rel}`
}

export function buildUrl(cdnBaseUrl: string, key: string): string {
	return `${stripTrailingSlash(cdnBaseUrl)}/${key.split('/').map(encodeURIComponent).join('/')}`
}

const startsWith = (bytes: Uint8Array, sig: number[], offset = 0) =>
	sig.every((b, i) => bytes[offset + i] === b)

const ascii = (bytes: Uint8Array, s: string, offset = 0) =>
	startsWith(bytes, [...s].map(c => c.charCodeAt(0)), offset)

/**
 * Identify a file from its leading bytes.
 *
 * Crawled media regularly has no extension at all, and serving those as
 * `application/octet-stream` makes browsers download the file instead of
 * rendering it — so the extension is a hint, not the authority.
 */
export function sniffMagic(bytes: Uint8Array): string | undefined {
	if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
	if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
	if (ascii(bytes, 'GIF8')) return 'image/gif'
	if (ascii(bytes, 'RIFF') && ascii(bytes, 'WEBP', 8)) return 'image/webp'
	if (ascii(bytes, 'ftypavif', 4)) return 'image/avif'
	if (ascii(bytes, 'ftypheic', 4) || ascii(bytes, 'ftypheix', 4)) return 'image/heic'
	if (ascii(bytes, '%PDF-')) return 'application/pdf'
	if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
		return 'image/tiff'
	}
	if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon'
	if (ascii(bytes, '<svg') || ascii(bytes, '<?xml')) return 'image/svg+xml'
	return undefined
}

export async function contentTypeFor(absPath: string): Promise<string> {
	const byExtension = (Bun.file(absPath).type || '').split(';')[0]!.trim()
	if (byExtension && byExtension !== 'application/octet-stream') return byExtension

	const head = new Uint8Array(await Bun.file(absPath).slice(0, 16).arrayBuffer())
	return sniffMagic(head) ?? 'application/octet-stream'
}

// ------------------------------------------------------------- arg parsing ---

export interface Args {
	_: string[]
	flags: Record<string, string | boolean>
}

export function parseArgs(argv: string[]): Args {
	const _: string[] = []
	const flags: Record<string, string | boolean> = {}
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!
		if (!a.startsWith('--')) {
			_.push(a)
			continue
		}
		const eq = a.indexOf('=')
		if (eq !== -1) {
			flags[a.slice(2, eq)] = a.slice(eq + 1)
		} else {
			const next = argv[i + 1]
			if (next && !next.startsWith('--')) {
				flags[a.slice(2)] = next
				i++
			} else {
				flags[a.slice(2)] = true
			}
		}
	}
	return { _, flags }
}

export function flagStr(args: Args, name: string): string | undefined {
	const v = args.flags[name]
	return typeof v === 'string' ? v : undefined
}

export function flagBool(args: Args, name: string): boolean {
	return args.flags[name] === true || args.flags[name] === 'true'
}

export function flagNum(args: Args, name: string, fallback: number): number {
	const v = flagStr(args, name)
	if (v === undefined) return fallback
	const n = Number(v)
	if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got ${v}`)
	return n
}
