import { expect, test } from 'bun:test'
import { buildKey, buildRefMatcher, buildUrl, classify, findRef, replaceRefs } from './lib.ts'

const CDN = 'https://cdn.nuasite.com'

const rewrite = (text: string, refs: string[], slug = 'demo') => {
	const matcher = buildRefMatcher(refs)
	return replaceRefs(text, matcher, ref => buildUrl(CDN, buildKey(ref.slice(1), slug, 'assets'))).text
}

test('rewrites a plain root-relative reference', () => {
	expect(rewrite('![x](/assets/a.jpg)', ['/assets/a.jpg']))
		.toBe('![x](https://cdn.nuasite.com/assets/demo/a.jpg)')
})

test('a shorter ref never matches inside a longer filename', () => {
	// both are real assets; only the double-extension one occurs in the text
	const out = rewrite('<img src="/assets/a.jpg.webp">', ['/assets/a.jpg', '/assets/a.jpg.webp'])
	expect(out).toBe('<img src="https://cdn.nuasite.com/assets/demo/a.jpg.webp">')
})

test('does not match when the path has a deeper prefix', () => {
	expect(rewrite('/vendor/assets/a.jpg', ['/assets/a.jpg'])).toBe('/vendor/assets/a.jpg')
})

test('leaves absolute URLs on other origins alone', () => {
	const text = 'https://old.example.cz/assets/a.jpg'
	expect(rewrite(text, ['/assets/a.jpg'])).toBe(text)
})

test('handles assets with no file extension', () => {
	expect(rewrite('![](/assets/foto-bez-pripony)', ['/assets/foto-bez-pripony']))
		.toBe('![](https://cdn.nuasite.com/assets/demo/foto-bez-pripony)')
})

test('matches percent-encoded references and canonicalises them', () => {
	const out = rewrite('[d](/assets/a%20b.jpg)', ['/assets/a b.jpg'])
	expect(out).toBe('[d](https://cdn.nuasite.com/assets/demo/a%20b.jpg)')
})

test('rewrites every occurrence and reports the count', () => {
	const matcher = buildRefMatcher(['/assets/a.jpg'])
	const { count } = replaceRefs('/assets/a.jpg /assets/a.jpg', matcher, () => 'X')
	expect(count).toBe(2)
})

test('nested directories survive the key mapping', () => {
	expect(rewrite('/dokumenty/zprava.pdf', ['/dokumenty/zprava.pdf']))
		.toBe('https://cdn.nuasite.com/assets/demo/dokumenty/zprava.pdf')
})

test('the assets/ prefix is not duplicated in the key', () => {
	expect(buildKey('assets/a.jpg', 'demo', 'assets')).toBe('assets/demo/a.jpg')
	expect(buildKey('dokumenty/a.pdf', 'demo', 'assets')).toBe('assets/demo/dokumenty/a.pdf')
	expect(buildKey('assets/a.jpg', 'demo', 'assets', true)).toBe('assets/demo/assets/a.jpg')
})

test('findRef spots a surviving local reference', () => {
	const matcher = buildRefMatcher(['/assets/a.jpg'])
	expect(findRef('nothing here', matcher)).toBeUndefined()
	expect(findRef('src="/assets/a.jpg"', matcher)).toBe('/assets/a.jpg')
})

// ------------------------------------------------------------ classify ---

const refs = (o: Partial<{ content: number; code: number; style: number; generated: number }> = {}) => {
	const c = { content: 0, code: 0, style: 0, generated: 0, ...o }
	return { ...c, total: c.content + c.code + c.style + c.generated }
}
const asset = (publicPath: string, size: number) => ({ path: `public/${publicPath}`, publicPath, size })

test('svg and fonts stay in the repo', () => {
	expect(classify(asset('assets/icon.svg', 2_000), refs({ code: 3 })).action).toBe('keep')
	expect(classify(asset('assets/fonts/Jost.woff2', 30_000), refs()).action).toBe('keep')
})

test('a logo stays even when unreferenced', () => {
	expect(classify(asset('assets/logo-main.png', 40_000), refs()).action).toBe('keep')
	expect(classify(asset('gfx/whatever.png', 40_000), refs()).action).toBe('keep')
})

test('a payload-sized file wins over every chrome signal but asks first', () => {
	const v = classify(asset('assets/logo-huge.png', 5_000_000), refs())
	expect(v.action).toBe('keep')
	expect(v.class).toBe('uncertain')
})

test('big files move regardless of references', () => {
	expect(classify(asset('assets/photo.jpg', 8_000_000), refs()).action).toBe('move')
})

test('content-referenced files move', () => {
	expect(classify(asset('assets/photo.jpg', 20_000), refs({ content: 1 })).action).toBe('move')
})

test('a build-cache reference is enough to count as content', () => {
	const v = classify(asset('assets/photo.jpg', 20_000), refs({ generated: 1 }))
	expect(v.action).toBe('move')
	expect(v.reason).toContain('build cache')
})

test('code-only small files are treated as chrome', () => {
	const v = classify(asset('assets/partner-logo-x.png', 20_000), refs({ code: 2 }))
	expect(v.action).toBe('keep')
	expect(v.class).toBe('chrome')
})

test('unreferenced but sizeable files are orphaned uploads and move', () => {
	expect(classify(asset('assets/photo.jpg', 300_000), refs()).action).toBe('move')
})

test('unreferenced tiny files are left for the operator to judge', () => {
	const v = classify(asset('assets/blip.png', 200), refs())
	expect(v.class).toBe('uncertain')
})

test('urls are percent-encoded per path segment', () => {
	expect(buildUrl(CDN, 'assets/demo/a b.jpg')).toBe('https://cdn.nuasite.com/assets/demo/a%20b.jpg')
	expect(buildUrl(CDN, 'assets/demo/sub/c.jpg')).toBe('https://cdn.nuasite.com/assets/demo/sub/c.jpg')
})
