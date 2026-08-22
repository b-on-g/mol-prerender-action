// Два правила, на которых держится поштучный кэш. Обе функции — копии из
// prerender.mjs; расхождение поймается тем, что тест перестанет отражать код.

// 1. Разбор маршрута в путь к контенту.
const route_pairs = route => {
	const pairs = {}
	for ( const chunk of route.split( '/' ) ) {
		const eq = chunk.indexOf( '=' )
		if ( eq > 0 ) pairs[ chunk.slice( 0, eq ) ] = chunk.slice( eq + 1 )
	}
	return pairs
}

const resolve = ( template, route ) => {
	const pairs = route_pairs( route )
	let unresolved = false
	const file = template.replace( /\{([^}]+)\}/g, ( _, token ) => {
		const [ key, fallback ] = token.split( '=' )
		const value = pairs[ key ] ?? fallback
		if ( value === undefined ) unresolved = true
		return value ?? ''
	} )
	return unresolved ? null : file
}

const T = 'content/{mol_locale=en}/docs/{page}.md'

const paths = [
	[ 'английский маршрут берёт запасной язык', 'section=docs/page=views',                 'content/en/docs/views.md' ],
	[ 'языковой маршрут берёт свой язык',       'mol_locale=ru/section=docs/page=views',   'content/ru/docs/views.md' ],
	[ 'порядок пар не важен',                   'page=views/mol_locale=ja',                'content/ja/docs/views.md' ],
	[ 'нет page — шаблон не про этот маршрут',  'section=playground',                       null ],
	[ 'корень — шаблон не про этот маршрут',    '',                                         null ],
]

// 2. Какие файлы держат маршрут. `null` — ни один шаблон не подошёл: страница
//    целиком из кода. Пустой массив — шаблон подошёл, а файла нет.
const SHELL_ONLY = 'shell'

const route_files = ( templates, route, on_disk ) => {
	const files = []
	let applied = 0
	for ( const template of templates ) {
		const file = resolve( template, route )
		if ( file === null ) continue
		applied++
		if ( on_disk.includes( file ) ) files.push( file )
	}
	return applied ? files : null
}

const route_hash = ( templates, route, on_disk ) => {
	const files = route_files( templates, route, on_disk )
	return files === null ? SHELL_ONLY : files.join( '+' )
}

const TT = [ T, 'content/en/docs/{page}.md' ]
const DISK = [ 'content/en/docs/views.md', 'content/ru/docs/views.md' ]

const hashes = [
	[ 'перевод есть — оба файла',        'mol_locale=ru/section=docs/page=views', 'content/ru/docs/views.md+content/en/docs/views.md' ],
	[ 'перевода нет — только оригинал',  'mol_locale=ja/section=docs/page=views', 'content/en/docs/views.md' ],
	[ 'страница из кода — метка',        'section=playground',                     SHELL_ONLY ],
	[ 'главная — тоже из кода',          '',                                       SHELL_ONLY ],
	[ 'файлов нет вовсе — не метка',     'section=docs/page=ghost',                '' ],
]

// 3. Решение о переиспользовании снимка.
const reuse = ( same_shell, hash, prev, exists ) =>
	same_shell && hash !== null && prev === hash && exists

const rules = [
	[ 'всё сошлось',                          true,  'a',        'a',        true,  true  ],
	[ 'контент страницы изменился',           true,  'b',        'a',        true,  false ],
	[ 'изменилась оболочка',                  false, 'a',        'a',        true,  false ],
	[ 'файла нет на диске',                   true,  'a',        'a',        false, false ],
	[ 'страница из кода, оболочка та же',     true,  SHELL_ONLY, SHELL_ONLY, true,  true  ],
	[ 'страница из кода, оболочка другая',    false, SHELL_ONLY, SHELL_ONLY, true,  false ],
	[ 'манифест старого формата',             true,  SHELL_ONLY, null,       true,  false ],
	[ 'поштучный режим выключен',             true,  null,       null,       true,  false ],
	[ 'маршрут новый',                        true,  'a',        undefined,  true,  false ],
]

let bad = 0
const check = ( name, got, want ) => {
	const ok = JSON.stringify( got ) === JSON.stringify( want )
	if ( !ok ) bad++
	console.log( `${ ok ? 'ок   ' : 'ПЛОХО' } ${ name.padEnd( 38 ) } ${ JSON.stringify( got ) }` )
}

console.log( '— разбор маршрута в путь —' )
for ( const [ name, route, want ] of paths ) check( name, resolve( T, route ), want )

console.log( '\n— хэш маршрута —' )
for ( const [ name, route, want ] of hashes ) check( name, route_hash( TT, route, DISK ), want )

console.log( '\n— решение о переиспользовании —' )
for ( const [ name, shell, hash, prev, exists, want ] of rules ) check( name, reuse( shell, hash, prev, exists ), want )

console.log( bad ? `\nпровалов: ${ bad }` : '\nвсе случаи сошлись' )
process.exit( bad ? 1 : 0 )
