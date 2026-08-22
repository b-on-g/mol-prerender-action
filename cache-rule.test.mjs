// Проверка решающего правила: когда маршрут переиспользуется, а когда нет.
// Повторяет условие из prerender.mjs дословно.
const decide = ( same_shell, route_hash, prev_hash, file_exists ) =>
	same_shell && route_hash !== null && prev_hash === route_hash && file_exists

const cases = [
	[ 'контент и оболочка те же, файл на месте',     true,  'a', 'a', true,  true  ],
	[ 'контент страницы изменился',                   true,  'b', 'a', true,  false ],
	[ 'изменилась оболочка',                          false, 'a', 'a', true,  false ],
	[ 'файла нет на диске',                           true,  'a', 'a', false, false ],
	[ 'маршрута нет в манифесте',                     true,  null, 'a', true, false ],
	[ 'маршрут новый, прошлого состояния нет',        true,  'a', undefined, true, false ],
]

let bad = 0
for ( const [ name, shell, now, prev, exists, want ] of cases ) {
	const got = decide( shell, now, prev, exists )
	const ok = got === want
	if ( !ok ) bad++
	console.log( `${ ok ? 'ок  ' : 'ПЛОХО' } ${ name.padEnd(42) } переиспользуем=${ got }` )
}
console.log( bad ? `\nпровалов: ${ bad }` : '\nвсе случаи сошлись' )
process.exit( bad ? 1 : 0 )
