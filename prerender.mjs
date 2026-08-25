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

/** Сколько вкладок разбирают очередь маршрутов одновременно. */
const CONCURRENCY = Math.max( 1, parseInt( args[ 'concurrency' ] || '4' ) )

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
//
// Отсюда же следует, что шаблоны описывают ВЕСЬ файловый контент сайта.
// Страница, к которой ни один шаблон не подходит, считается собранной из кода:
// её снимок зависит только от оболочки, и при совпавшем хэше оболочки она
// переиспользуется наравне с остальными. У документационного сайта так живут
// главная, песочница и сравнения — треть всех маршрутов.
// Шаблоны путей к контенту маршрута. Каждый — строка вида
// `content/{mol_locale=en}/docs/{page}.md`: `{ключ}` берётся из самого маршрута
// (он и есть набор пар `ключ=значение`), `=значение` — что подставить, если
// такого ключа в маршруте нет.
//
// Шаблонов может быть несколько: у языковой страницы, для которой перевода ещё
// нет, отрисуется английский текст — значит её снимок зависит и от английского
// файла тоже. Не учесть это означало бы, что правка английской страницы не
// обновит четырнадцать языковых копий, которые её показывают.
const ROUTE_CONTENT = ( args[ 'route-content' ] || '' )
	.split( '\n' ).map( line => line.trim() ).filter( Boolean )

const STATE_FILE = 'prerender-state.json'

/** Литеральное начало шаблона — до первой подстановки. */
const content_roots = ROUTE_CONTENT.map( t => t.split( '{' )[ 0 ] ).filter( Boolean )

/** Маршрут — это пары `ключ=значение`, разделённые слэшем. */
function route_pairs( route ) {
	const pairs = {}
	for ( const chunk of route.split( '/' ) ) {
		const eq = chunk.indexOf( '=' )
		if ( eq > 0 ) pairs[ chunk.slice( 0, eq ) ] = chunk.slice( eq + 1 )
	}
	return pairs
}

/**
 * Хэш маршрута, у которого нет файлового контента: страница собрана из самого
 * кода, а код целиком учтён хэшем оболочки. Отдельная метка, а не хэш пустого
 * набора, — чтобы «шаблон не про этот маршрут» не сливалось с «файл по шаблону
 * пропал», которое обязано менять хэш.
 */
const SHELL_ONLY = 'shell'

/**
 * Файлы, от которых зависит контент маршрута.
 *
 * `null` — ни один шаблон к маршруту не применим: у страницы нет контента в
 * файлах, она целиком из кода. Пустой массив — шаблон применим, но файла по
 * нему сейчас нет (перевода ещё не написали); появится — хэш изменится.
 */
function route_files( route ) {

	if ( !ROUTE_CONTENT.length ) return null
	const pairs = route_pairs( route )
	const files = []
	let applied = 0

	for ( const template of ROUTE_CONTENT ) {
		let unresolved = false
		const file = template.replace( /\{([^}]+)\}/g, ( _, token ) => {
			const [ key, fallback ] = token.split( '=' )
			const value = pairs[ key ] ?? fallback
			if ( value === undefined ) unresolved = true
			return value ?? ''
		} )
		// В маршруте нет ключа, который требует шаблон, — значит шаблон описывает
		// не такие страницы. Это не «неизвестно», это «не про него»: остальные
		// шаблоны ещё могут подойти.
		if ( unresolved ) continue
		applied++
		if ( existsSync( file ) ) files.push( file )
	}

	return applied ? files : null
}

async function route_hash( route ) {
	const files = route_files( route )
	if ( files === null ) return SHELL_ONLY
	const hash = createHash( 'sha256' )
	for ( const file of files ) {
		hash.update( file )
		hash.update( await readFile( file ) )
	}
	return hash.digest( 'hex' )
}

async function read_json( file ) {
	try { return JSON.parse( await readFile( file, 'utf-8' ) ) }
	catch { return null }
}


/** Хэш оболочки: всё, от чего зависит бандл, кроме контентных файлов. */
async function shell_hash( build_dir ) {

	const deps = await read_json( join( build_dir, 'web.deps.json' ) )
	if ( !deps?.files ) return null

	const hash = createHash( 'sha256' )

	for ( const file of deps.files.slice().sort() ) {
		// Всё, что лежит под корнем шаблона контента, — это контент и то, что из
		// него сгенерировано (у smalljs content.ts, llms.txt, sitemap.xml лежат
		// там же). Их учитывает хэш маршрута, а не оболочки, иначе правка любой
		// страницы меняла бы оболочку и пропускать было бы нечего.
		if ( content_roots.some( root => file.startsWith( root ) ) ) continue
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

			// Приложение на лету переписывает адрес на глубокий путь маршрута, и всё,
			// что оно грузит относительной ссылкой ПОСЛЕ этого — словарь локали,
			// иконки, — уезжает в `/<маршрут>/web.locale=en.json`. Такого файла нет,
			// откат отдавал index.html, и `JSON.parse` спотыкался на `<`. Приложение
			// оставалось без словаря и не дорисовывалось. Ловилось это только под
			// нагрузкой: по очереди запрос успевал уйти до подмены адреса.
			//
			// Сегмент маршрута всегда имеет вид `ключ=значение`, так что ведущие
			// такие сегменты просто отбрасываем и ищем файл ещё раз.
			const candidates = [ file ]
			const parts = path.replace( /^\//, '' ).split( '/' )
			while ( parts.length > 1 && parts[ 0 ].includes( '=' ) ) {
				parts.shift()
				candidates.push( join( BUILD_DIR, parts.join( '/' ) ) )
			}

			for ( const candidate of candidates ) {
				try {
					const data = await readFile( candidate )
					res.writeHead( 200, { 'Content-Type': MIME[ extname( path ) ] || 'application/octet-stream' } )
					res.end( data )
					return
				} catch { /* пробуем следующий */ }
			}

			try {
				const data = await readFile( join( BUILD_DIR, 'index.html' ) )
				res.writeHead( 200, { 'Content-Type': 'text/html' } )
				res.end( data )
			} catch {
				res.writeHead( 404 )
				res.end( 'Not found' )
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

	/** Вкладка, готовая снимать: свой вьюпорт и чистое хранилище на каждой навигации. */
	async function new_page() {

		// Каждой вкладке — свой контекст, то есть отдельное хранилище. Вкладки в
		// общем контексте делят один localStorage на всех, и сброс перед навигацией
		// в одной затирает состояние соседней прямо посреди её загрузки: страница
		// зависала на пустом корне и отваливалась по таймауту. Ловится только
		// параллельным прогоном, потому что по очереди затирать некого.
		const context = typeof browser.createBrowserContext === 'function'
			? await browser.createBrowserContext()
			: browser
		const page = await context.newPage()
		await page.setViewport({ width: vw, height: vh })

		// Вкладка обслуживает много маршрутов подряд, а приложение хранит состояние в
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

		return page
	}

	let ok = 0, failed = 0
	try {

		const incremental = ROUTE_CONTENT.length > 0
		const shell = incremental ? await shell_hash( BUILD_DIR ) : null
		const prev = incremental ? await read_json( join( BUILD_DIR, STATE_FILE ) ) : null
		const same_shell = !!shell && prev?.shell === shell
		const next_state = { shell, routes: {} }

		if ( incremental ) {
			console.log( same_shell
				? 'Оболочка не менялась — перерисуем только маршруты с новым контентом.'
				: 'Оболочка изменилась — перерисуем все маршруты.' )
		}

		let reused = 0

		// Сначала раскладываем маршруты на две стопки: что берём готовым и что
		// рисуем. Это чтение файлов, оно дешёвое и последовательное — а рисование
		// дальше пойдёт в несколько вкладок.
		const snapshots = new Map()   // маршрут -> { title, desc } для sitemap
		const queue = []

		for ( const route of all_routes ) {

			const hash = incremental ? await route_hash( route ) : null
			if ( incremental ) next_state.routes[ route ] = hash

			// Переиспользуем прошлый снимок, только если сошлось всё сразу:
			// оболочка, контент маршрута и наличие самого файла на диске.
			// `hash === null` бывает лишь при выключенном поштучном режиме.
			if ( same_shell && hash !== null && prev?.routes?.[ route ] === hash ) {
				const dest = join( BUILD_DIR, out_path( route ) )
				if ( existsSync( dest ) ) {
					snapshots.set( route, { title: '', desc: '' } )
					reused++
					ok++
					continue
				}
			}

			queue.push( route )
		}

		// Рисование — это почти сплошное ожидание: навигация, networkidle0, пауза до
		// затихания DOM. Процессор при этом простаивает, поэтому несколько вкладок
		// разбирают очередь параллельно и время падает почти пропорционально их числу.
		// Вкладки берут следующий маршрут сами, а не делят список заранее: страницы
		// разной тяжести, и статичное деление упёрлось бы в самую медленную стопку.
		let cursor = 0

		async function render_worker() {

			const page = await new_page()

			try {
				while ( cursor < queue.length ) {

					const route = queue[ cursor++ ]
					const url = make_url( route )
					const label = route || 'index'

					try {

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
						await page.evaluate( ( quiet, cap ) => new Promise( settled => {

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
								settled()
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

						snapshots.set( route, { title: meta.title, desc: meta.desc } )
						ok++

					} catch ( e ) {
						failed++
						console.error( `  !! ${ label } failed: ${ e.message }` )
					}
				}
			} finally {
				const context = page.browserContext?.()
				await page.close()
				if ( context && context !== browser.defaultBrowserContext?.() ) await context.close()
			}
		}

		const hands = Math.max( 1, Math.min( CONCURRENCY, queue.length ) )
		if ( queue.length ) console.log( `Рисуем ${ queue.length } страниц в ${ hands } вкладк(и/ах).` )
		await Promise.all( Array.from( { length: hands }, render_worker ) )

		// Generate sitemap.xml (skipped if the pipeline ships its own — see README).
		if ( args[ 'sitemap' ] !== 'false' ) {
			const now = new Date().toISOString().split( 'T' )[ 0 ]
			// Порядок — как в списке маршрутов, а не как вкладки успели их снять.
			const urls = all_routes.filter( r => snapshots.has( r ) ).map( r => {
				const s = { id: r, ... snapshots.get( r ) }
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
		if ( incremental ) {
			await writeFile( join( BUILD_DIR, STATE_FILE ), JSON.stringify( next_state ), 'utf-8' )
		}

		// Итог одной строкой, и без слова «отрисовано» напротив числа всех
		// страниц: в удачном прогоне отрисовано ноль, а страниц по-прежнему 912.
		const parts = [ `${ ok } страниц на выходе` ]
		if ( incremental ) parts.push( `${ reused } из кэша`, `${ ok - reused } отрисовано заново` )
		if ( failed ) parts.push( `${ failed } не вышло` )
		console.log( `\nГотово: ${ parts.join( ', ' ) }.` )
	} finally {
		await browser.close()
		server.close()
	}

	// Non-blocking by design in CI, but a total wipeout should still surface.
	if ( ok === 0 ) process.exit( 1 )
}

prerender().catch( e => { console.error( e ); process.exit( 1 ) } )
