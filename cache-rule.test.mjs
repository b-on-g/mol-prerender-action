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
	[ 'нет page — зависимость неизвестна',      'section=playground',                       null ],
	[ 'корень — зависимость неизвестна',        '',                                         null ],
]

// 2. Решение о переиспользовании снимка.
const reuse = ( same_shell, hash, prev, exists ) =>
	same_shell && hash !== null && prev === hash && exists

const rules = [
	[ 'всё сошлось',                          true,  'a', 'a',       true,  true  ],
	[ 'контент страницы изменился',           true,  'b', 'a',       true,  false ],
	[ 'изменилась оболочка',                  false, 'a', 'a',       true,  false ],
	[ 'файла нет на диске',                   true,  'a', 'a',       false, false ],
	[ 'зависимость неизвестна',               true,  null,'a',       true,  false ],
	[ 'маршрут новый',                        true,  'a', undefined, true,  false ],
]

let bad = 0
console.log( '— разбор маршрута в путь —' )
for ( const [ name, route, want ] of paths ) {
	const got = resolve( T, route )
	const ok = got === want
	if ( !ok ) bad++
	console.log( `${ ok ? 'ок   ' : 'ПЛОХО' } ${ name.padEnd( 38 ) } ${ got }` )
}
console.log( '\n— решение о переиспользовании —' )
for ( const [ name, shell, hash, prev, exists, want ] of rules ) {
	const got = reuse( shell, hash, prev, exists )
	const ok = got === want
	if ( !ok ) bad++
	console.log( `${ ok ? 'ок   ' : 'ПЛОХО' } ${ name.padEnd( 38 ) } ${ got }` )
}
console.log( bad ? `\nпровалов: ${ bad }` : '\nвсе случаи сошлись' )
process.exit( bad ? 1 : 0 )
