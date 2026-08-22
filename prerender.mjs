#!/usr/bin/env node

import puppeteer from 'puppeteer'
import { createServer } from 'http'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { createHash } from 'crypto'
import { join, extname, dirname } from 'path'
import { existsSync } from 'fs'

// Parse CLI args: --key=value
const args = Object.fromEntries(
	process.argv.slice( 2 )
		.filter( a => a.startsWith( '--' ) )
		.map( a => {
			const [ k, ...v ] = a.slice( 2 ).split( '=' )
			return [ k, v.join( '=' ) ]
		} )
)

const BUILD_DIR = args[ 'build-dir' ]
const ROOT_FQN = args[ 'root-fqn' ] // e.g. $bog_project_tree_appname_app
const BASE_URL = args[ 'base-url' ]?.replace( /\/?$/, '/' ) // ensure trailing slash
const ROUTE_FORMAT = args[ 'route-format' ] || '#!'
const ROUTE_KEY = args[ 'route-key' ] || 'screen'
const VIEWPORT = args[ 'viewport' ] || '430x932'
const TIMEOUT = parseInt( args[ 'timeout' ] || '15000' )

/** Сколько DOM должен простоять неизменным, чтобы считать страницу готовой. */
const SETTLE_QUIET = parseInt( args[ 'settle-quiet' ] || '300' )
/** Потолок ожидания — прежняя глухая пауза, теперь только как верхняя граница. */
const SETTLE_CAP = parseInt( args[ 'settle-cap' ] || '1500' )

// Mount = the path the app is served under (from base-url), e.g. `/smalljs/`.
// For `path` routing the app's client router only activates under this prefix,
// and static assets (web.js) resolve relative to it.
const MOUNT = ( () => {
	try { return new URL( BASE_URL ).pathname.replace( /\/?$/, '/' ) }
	catch { return '/' }
} )()

// In `path` mode each entry is a full pathname route (e.g. `section=docs/page=views`);
// in `#!`/`?` mode each is a single route-key value (legacy behaviour).
const SCREENS = ( args[ 'screens' ] || '' )
	.split( /[\n,]/ )
	.map( s => s.trim() )
	.filter( Boolean )

// `path` mode can also take the full route list straight from a committed sitemap.xml
// (single source of truth): every <loc> under base-url becomes a route to prerender.
const SITEMAP_FILE = args[ 'sitemap-file' ] || ''

// --- поштучный кэш (опционально) --------------------------------------------
//
// Без манифеста ничего из этого не работает и поведение прежнее: один общий
// ключ на все страницы, промах — перерисовываем всё.
//
// С манифестом маршрут переиспользуется из прошлого прогона, только если
// совпали ДВА хэша: его собственный (что за контент на странице) и хэш
// оболочки (весь остальной код, из которого собран бандл). Оболочка считается
// консервативно — по web.deps.json за вычетом файлов, которые проект назвал
// контентными. Поэтому любая правка кода, стилей или чужого модуля по-прежнему
// перерисовывает всё: быстрый путь достаётся только чистым правкам контента.
const MANIFEST_FILE = args[ 'route-manifest' ] || ''
const STATE_FILE = 'prerender-state.json'

async function read_json( file ) {
	try { return JSON.parse( await readFile( file, 'utf-8' ) ) }
	catch { return null }
}

/** Хэш оболочки: всё, от чего зависит бандл, кроме контентных файлов. */
async function shell_hash( build_dir, content_files ) {

	const deps = await read_json( join( build_dir, 'web.deps.json' ) )
	if ( !deps?.files ) return null

	const skip = new Set( content_files ?? [] )
	const hash = createHash( 'sha256' )

	for ( const file of deps.files.slice().sort() ) {
		if ( skip.has( file ) ) continue
		hash.update( file )
		try { hash.update( await readFile( file ) ) }
		catch { /* файла нет — учитываем сам факт по имени выше */ }
	}

	return hash.digest( 'hex' )
}

async function routes_from_sitemap() {
	if ( !SITEMAP_FILE || !existsSync( SITEMAP_FILE ) ) return []
	const xml = await readFile( SITEMAP_FILE, 'utf-8' )
	return [ ...xml.matchAll( /<loc>([^<]+)<\/loc>/g ) ]
		.map( m => m[ 1 ].trim() )
		.filter( u => u.startsWith( BASE_URL ) )
		.map( u => u.slice( BASE_URL.length ) )   // route relative to base
		.filter( r => r && !r.endsWith( '.md' ) ) // skip raw .md endpoints (already static)
}

const PORT = 9222

const MIME = {
	'.html': 'text/html',
	'.js': 'application/javascript',
	'.mjs': 'application/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.webp': 'image/webp',
	'.woff2': 'font/woff2',
	'.baza': 'application/octet-stream',
}

// Serve BUILD_DIR under MOUNT, mirroring GitHub Pages: real files win, any unknown
// path under the mount falls back to index.html (SPA).
function serve() {
	return new Promise( resolve => {
		const server = createServer( async ( req, res ) => {
			const url = new URL( req.url, `http://localhost:${ PORT }` )
			let path = decodeURIComponent( url.pathname )
			if ( MOUNT !== '/' && path.startsWith( MOUNT ) ) path = '/' + path.slice( MOUNT.length )
			if ( path === '/' || path === '' ) path = '/index.html'
			const file = join( BUILD_DIR, path )

			try {
				const data = await readFile( file )
				const ext = extname( path )
				res.writeHead( 200, { 'Content-Type': MIME[ ext ] || 'application/octet-stream' } )
				res.end( data )
			} catch {
				try {
					const data = await readFile( join( BUILD_DIR, 'index.html' ) )
					res.writeHead( 200, { 'Content-Type': 'text/html' } )
					res.end( data )
				} catch {
					res.writeHead( 404 )
					res.end( 'Not found' )
				}
			}
		} )
		server.listen( PORT, () => {
			console.log( `Server on http://localhost:${ PORT }${ MOUNT } (mount ${ MOUNT })` )
			resolve( server )
		} )
	} )
}

// URL to navigate for a given route. `path` mode loads from the mount root via the
// GitHub-Pages `?/`-fallback form (rafgraph), exactly like a real deep-link cold load:
// assets resolve from the root and the client router expands `?/route` into the path.
function make_url( route ) {
	const base = `http://localhost:${ PORT }${ MOUNT }`
	if ( ROUTE_FORMAT === 'path' ) {
		if ( !route ) return base
		return `${ base }?/${ route.replace( /&/g, '~and~' ) }`
	}
	if ( !route ) return base
	if ( ROUTE_FORMAT === '?' ) return `${ base }?${ ROUTE_KEY }=${ route }`
	return `${ base }#!${ ROUTE_KEY }=${ route }`
}

function make_sitemap_url( route ) {
	if ( !route ) return BASE_URL
	if ( ROUTE_FORMAT === 'path' ) return `${ BASE_URL }${ route }`
	// Legacy: sitemap points to actual static HTML files, not hash/query URLs.
	return `${ BASE_URL }${ route }.html`
}

// Where to write the rendered HTML for a route. `path` mode writes `<route>/index.html`
// so GitHub Pages serves it at `/<route>` with a 200; legacy modes write `<route>.html`.
function out_path( route ) {
	if ( !route ) return 'index.html'
	if ( ROUTE_FORMAT === 'path' ) return join( route, 'index.html' )
	return `${ route }.html`
}

// In-page: expand the app's `data-bog-meta` JSON into real <head> tags (title, meta,
// og:*, twitter:*, canonical, hreflang alternates) so crawlers and social scrapers —
// which never run JS — get full per-page SEO from the static file. Also guarantees a
// <base href> so relative assets resolve from the mount on any deep path.
function inject_meta_in_page( mount ) {
	const root = document.querySelector( '[data-bog-meta]' )
	const head = document.head

	// <base href> — the client router adds one at runtime; ensure it's in the dump too.
	if ( !head.querySelector( 'base[href]' ) ) {
		const base = document.createElement( 'base' )
		base.setAttribute( 'href', mount )
		head.insertBefore( base, head.firstChild )
	}

	if ( !root ) return
	let meta
	try { meta = JSON.parse( root.getAttribute( 'data-bog-meta' ) || '{}' ) } catch { return }

	const upsert = ( selector, tag, attrs ) => {
		let el = head.querySelector( selector )
		if ( !el ) { el = document.createElement( tag ); head.appendChild( el ) }
		for ( const [ k, v ] of Object.entries( attrs ) ) el.setAttribute( k, v )
	}

	const title = meta.title
	const desc = meta.description
	const url = meta.canonical

	if ( title ) document.title = title
	if ( desc ) upsert( 'meta[name="description"]', 'meta', { name: 'description', content: desc } )
	if ( url ) upsert( 'link[rel="canonical"]', 'link', { rel: 'canonical', href: url } )

	if ( meta.og_title ) upsert( 'meta[property="og:title"]', 'meta', { property: 'og:title', content: meta.og_title } )
	if ( meta.og_description ) upsert( 'meta[property="og:description"]', 'meta', { property: 'og:description', content: meta.og_description } )
	if ( meta.og_type ) upsert( 'meta[property="og:type"]', 'meta', { property: 'og:type', content: meta.og_type } )
	if ( meta.og_image ) upsert( 'meta[property="og:image"]', 'meta', { property: 'og:image', content: meta.og_image } )
	if ( url ) upsert( 'meta[property="og:url"]', 'meta', { property: 'og:url', content: url } )

	if ( meta.og_image ) {
		upsert( 'meta[name="twitter:card"]', 'meta', { name: 'twitter:card', content: 'summary_large_image' } )
		if ( title ) upsert( 'meta[name="twitter:title"]', 'meta', { name: 'twitter:title', content: title } )
		if ( desc ) upsert( 'meta[name="twitter:description"]', 'meta', { name: 'twitter:description', content: desc } )
		upsert( 'meta[name="twitter:image"]', 'meta', { name: 'twitter:image', content: meta.og_image } )
	}

	// hreflang alternates — remove stale ones, then add the current set.
	for ( const el of head.querySelectorAll( 'link[rel="alternate"][hreflang]' ) ) el.remove()
	for ( const alt of ( meta.alternates || [] ) ) {
		const link = document.createElement( 'link' )
		link.setAttribute( 'rel', 'alternate' )
		link.setAttribute( 'hreflang', alt.lang )
		link.setAttribute( 'href', alt.href )
		head.appendChild( link )
	}
}

async function prerender() {
	if ( !BUILD_DIR || !existsSync( BUILD_DIR ) ) {
		console.error( `Build dir not found: ${ BUILD_DIR }` )
		process.exit( 1 )
	}
	if ( !BASE_URL ) {
		console.error( 'Missing --base-url' )
		process.exit( 1 )
	}

	const root_selector = ROOT_FQN
		? `[mol_view_root="${ ROOT_FQN }"]`
		: '[mol_view_root]'

	const [ vw, vh ] = VIEWPORT.split( 'x' ).map( Number )

	// '' = index/home; merge explicit screens with routes discovered in the sitemap.
	const sitemap_routes = await routes_from_sitemap()
	const all_routes = [ '', ...new Set( [ ...SCREENS, ...sitemap_routes ] ) ]

	const server = await serve()
	const browser = await puppeteer.launch({
		headless: true,
		args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
	})

	let ok = 0, failed = 0
	try {
		const page = await browser.newPage()
		await page.setViewport({ width: vw, height: vh })

		// Одна вкладка обслуживает все маршруты, а приложение хранит состояние в
		// localStorage — $mol_locale, например, держит там выбранный язык. Без сброса
		// снимок наследует состояние предыдущего: после `mol_locale=ja/...` страница
		// `section=docs/page=tooling`, у которой языка в URL нет, отрисовывалась
		// по-японски. Порядок маршрутов такое лечит лишь по счастливой случайности.
		// evaluateOnNewDocument выполняется на каждой навигации ДО скриптов страницы,
		// так что каждый маршрут стартует с чистого состояния.
		await page.evaluateOnNewDocument( () => {
			try {
				localStorage.clear()
				sessionStorage.clear()
			} catch {
				// приватный режим или запрет хранилища — сбрасывать нечего
			}
		} )

		const sitemap_entries = []

		const manifest = MANIFEST_FILE ? await read_json( MANIFEST_FILE ) : null
		if ( MANIFEST_FILE && !manifest ) {
			console.error( `!! route-manifest не прочитан: ${ MANIFEST_FILE } — рендерим всё` )
		}

		const shell = manifest ? await shell_hash( BUILD_DIR, manifest.content ) : null
		const prev = manifest ? await read_json( join( BUILD_DIR, STATE_FILE ) ) : null
		const same_shell = !!shell && prev?.shell === shell
		const next_state = { shell, routes: {} }

		if ( manifest ) {
			console.log( same_shell
				? 'Оболочка не менялась — перерисуем только маршруты с новым контентом.'
				: 'Оболочка изменилась — перерисуем все маршруты.' )
		}

		let reused = 0

		for ( const route of all_routes ) {
			const url = make_url( route )
			const label = route || 'index'

			const route_hash = manifest?.routes?.[ route ] ?? null
			if ( manifest ) next_state.routes[ route ] = route_hash

			// Переиспользуем прошлый снимок, только если сошлось всё сразу:
			// оболочка, контент маршрута и наличие самого файла на диске.
			if ( same_shell && route_hash !== null && prev?.routes?.[ route ] === route_hash ) {
				const dest = join( BUILD_DIR, out_path( route ) )
				if ( existsSync( dest ) ) {
					sitemap_entries.push({ id: route, title: '', desc: '' })
					reused++
					ok++
					continue
				}
			}

			try {
				console.log( `Rendering: ${ label } ...` )
				await page.goto( url, { waitUntil: 'networkidle0', timeout: 30_000 } )

				// Wait for $mol to render content into the root element.
				await page.waitForFunction(
					( selector ) => {
						const root = document.querySelector( selector )
						return !!root && ( root.children.length > 0 || root.innerHTML.length > 500 )
					},
					{ timeout: TIMEOUT },
					root_selector,
				)

				// Досаживаем асинхронный контент. Раньше здесь стояла глухая пауза
				// в 1.5 с на КАЖДУЮ страницу: на 896 маршрутах это 22 минуты чистого
				// сна, больше половины прогона, причём подавляющее большинство
				// страниц готовы сразу после waitForFunction выше.
				//
				// Теперь ждём тишины в DOM: как только полотно перестало меняться
				// на SETTLE_QUIET, снимаем. Потолок остался прежним — 1.5 с, так что
				// худший случай не стал хуже прежнего, а типичный короче на порядок.
				await page.evaluate( ( quiet, cap ) => new Promise( done => {

					let timer = setTimeout( finish, quiet )
					const ceiling = setTimeout( finish, cap )

					const watcher = new MutationObserver( () => {
						clearTimeout( timer )
						timer = setTimeout( finish, quiet )
					} )
					watcher.observe( document.documentElement, {
						subtree: true,
						childList: true,
						characterData: true,
						attributes: true,
					} )

					function finish() {
						clearTimeout( timer )
						clearTimeout( ceiling )
						watcher.disconnect()
						done()
					}

				} ), SETTLE_QUIET, SETTLE_CAP )

				await page.evaluate( inject_meta_in_page, MOUNT )

				const meta = await page.evaluate( () => ( {
					title: document.title || '',
					desc: document.querySelector( 'meta[name="description"]' )?.getAttribute( 'content' ) || '',
				} ) )

				const html = await page.content()
				const rel = out_path( route )
				const dest = join( BUILD_DIR, rel )
				await mkdir( dirname( dest ), { recursive: true } )
				await writeFile( dest, html, 'utf-8' )
				console.log( `  -> ${ rel } (${ meta.title })` )

				sitemap_entries.push({ id: route, title: meta.title, desc: meta.desc })
				ok++
			} catch ( e ) {
				failed++
				console.error( `  !! ${ label } failed: ${ e.message }` )
			}
		}

		// Generate sitemap.xml (skipped if the pipeline ships its own — see README).
		if ( args[ 'sitemap' ] !== 'false' ) {
			const now = new Date().toISOString().split( 'T' )[ 0 ]
			const urls = sitemap_entries.map( s => {
				const loc = make_sitemap_url( s.id )
				const priority = s.id ? '0.7' : '1.0'
				return `  <url>\n    <loc>${ loc }</loc>\n    <lastmod>${ now }</lastmod>\n    <priority>${ priority }</priority>\n  </url>`
			} )
			const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${ urls.join( '\n' ) }
</urlset>`
			await writeFile( join( BUILD_DIR, 'sitemap.xml' ), sitemap, 'utf-8' )
			await writeFile( join( BUILD_DIR, 'robots.txt' ), `User-agent: *\nAllow: /\n\nSitemap: ${ BASE_URL }sitemap.xml`, 'utf-8' )
			console.log( '-> sitemap.xml + robots.txt' )
		}

		// Состояние кладём рядом со снимками: оно уезжает в кэш вместе с ними
		// и на следующем прогоне отвечает, что можно не перерисовывать.
		if ( manifest ) {
			await writeFile( join( BUILD_DIR, STATE_FILE ), JSON.stringify( next_state ), 'utf-8' )
			console.log( `Переиспользовано из кэша: ${ reused }, перерисовано: ${ ok - reused }` )
		}

		console.log( `\nDone. Prerendered ${ ok } page(s)${ failed ? `, ${ failed } failed` : '' }.` )
	} finally {
		await browser.close()
		server.close()
	}

	// Non-blocking by design in CI, but a total wipeout should still surface.
	if ( ok === 0 ) process.exit( 1 )
}

prerender().catch( e => { console.error( e ); process.exit( 1 ) } )
