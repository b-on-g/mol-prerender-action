#!/usr/bin/env node

import puppeteer from 'puppeteer'
import { createServer } from 'http'
import { readFile, writeFile } from 'fs/promises'
import { join, extname } from 'path'
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

const SCREENS = ( args[ 'screens' ] || '' )
	.split( /[\n,]/ )
	.map( s => s.trim() )
	.filter( Boolean )

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

function serve() {
	return new Promise( resolve => {
		const server = createServer( async ( req, res ) => {
			const url = new URL( req.url, `http://localhost:${ PORT }` )
			let path = url.pathname === '/' ? '/index.html' : url.pathname
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
			console.log( `Server on http://localhost:${ PORT }` )
			resolve( server )
		} )
	} )
}

function make_url( screen_id ) {
	if ( !screen_id ) return `http://localhost:${ PORT }/`
	if ( ROUTE_FORMAT === '?' ) {
		return `http://localhost:${ PORT }/?${ ROUTE_KEY }=${ screen_id }`
	}
	return `http://localhost:${ PORT }/#!${ ROUTE_KEY }=${ screen_id }`
}

function make_sitemap_url( screen_id ) {
	if ( !screen_id ) return BASE_URL
	// Sitemap points to actual static HTML files, not hash/query URLs
	return `${ BASE_URL }${ screen_id }.html`
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

	const all_screens = [ '', ...SCREENS ] // '' = index/home

	const server = await serve()
	const browser = await puppeteer.launch({
		headless: true,
		args: [ '--no-sandbox', '--disable-setuid-sandbox' ],
	})

	try {
		const page = await browser.newPage()
		await page.setViewport({ width: vw, height: vh })

		const sitemap_entries = []

		for ( const screen_id of all_screens ) {
			const url = make_url( screen_id )
			const label = screen_id || 'index'

			console.log( `Rendering: ${ label }...` )
			await page.goto( url, { waitUntil: 'networkidle0', timeout: 30_000 } )

			// Wait for $mol to render content into root element
			await page.waitForFunction(
				( selector, expected ) => {
					const root = document.querySelector( selector )
					if ( !root || root.children.length === 0 ) return false
					if ( !expected ) return true
					return !!root.querySelector( `[class*="${ expected }"]` )
						|| !!root.querySelector( `[mol_view_root*="${ expected }"]` )
						|| root.innerHTML.length > 500
				},
				{ timeout: TIMEOUT },
				root_selector,
				screen_id,
			)

			// Extra wait for async content
			await new Promise( r => setTimeout( r, 2000 ) )

			// Extract title and description from the rendered page
			const meta = await page.evaluate( () => ({
				title: document.title || '',
				desc: document.querySelector( 'meta[name="description"]' )?.getAttribute( 'content' ) || '',
			}) )

			const html = await page.content()
			const filename = screen_id ? `${ screen_id }.html` : 'index.html'
			await writeFile( join( BUILD_DIR, filename ), html, 'utf-8' )
			console.log( `  -> ${ filename } (${ meta.title })` )

			sitemap_entries.push({ id: screen_id, title: meta.title, desc: meta.desc })
		}

		// Generate sitemap.xml
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
		console.log( '-> sitemap.xml' )

		// Generate robots.txt
		const robots = `User-agent: *\nAllow: /\n\nSitemap: ${ BASE_URL }sitemap.xml`
		await writeFile( join( BUILD_DIR, 'robots.txt' ), robots, 'utf-8' )
		console.log( '-> robots.txt' )

		console.log( `\nDone! Prerendered ${ all_screens.length } pages.` )
	} finally {
		await browser.close()
		server.close()
	}
}

prerender().catch( e => { console.error( e ); process.exit( 1 ) } )
