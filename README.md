# $mol Prerender Action

Prerender `$mol` SPA pages with Puppeteer for SEO. Generates static HTML snapshots, `sitemap.xml`, and `robots.txt`.

Auto-detects build directory and root component from `index.html`.

## Usage

### Minimal

```yaml
- uses: b-on-g/mol-prerender-action@v1
  with:
    base-url: "https://example.github.io/app/"
```

### With screens

```yaml
- uses: b-on-g/mol-prerender-action@v1
  with:
    base-url: "https://b-on-g.github.io/tree/"
    screens: |
      campaign
      endless
      pvp
      shop
      leaderboard
      settings
```

### Full example (after mam_build)

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: hyoo-ru/mam_build@master2
        with:
          package: "bog/project/tree"
          modules: "appname/app"

      - uses: b-on-g/mol-prerender-action@v1
        with:
          base-url: "https://b-on-g.github.io/tree/"
          screens: |
            campaign
            endless
            pvp
            shop
            leaderboard

      - uses: hyoo-ru/gh-deploy@v4.4.1
        if: github.ref == 'refs/heads/master'
        with:
          folder: "bog/project/tree/appname/app/-"
```

## Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `base-url` | yes | — | Production URL for sitemap.xml |
| `folder` | no | autodetected | Build directory, if the `index.html` probe picks the wrong one |
| `screens` | no | `""` | Screen IDs to prerender, one per line |
| `sitemap-file` | no | `""` | Committed sitemap to take the route list from, instead of `screens` |
| `route-format` | no | `#!` | URL routing: `#!` (hash), `?` (query) or `path` (`/a=1/b=2/`) |
| `route-key` | no | `screen` | URL parameter key |
| `route-content` | no | `""` | Path templates for each route's content — enables the incremental cache, see below |
| `viewport` | no | `430x932` | Viewport as WIDTHxHEIGHT |
| `timeout` | no | `15000` | Render wait timeout (ms) |

## Incremental cache

Without `route-content` the cache is all-or-nothing: one key over the whole
build, and any miss re-renders every route.

`route-content` tells the action where a route's text lives, so it can skip the
routes whose text did not change. Each line is a path with `{key}` slots filled
from the route itself (a route is just `key=value` pairs), and `=value` after
the key is what to substitute when the route has no such pair:

```yaml
route-content: |
  content/{mol_locale=en}/docs/{page}.md
  content/en/docs/{page}.md
```

A snapshot is reused only when two hashes match: the route's own content, and
the **shell** — every file in `web.deps.json` outside the templates' literal
root. So any change to code, styles or a dependency still re-renders everything;
the fast path is for content-only commits.

Two consequences worth knowing before you turn this on:

- **The templates must describe all file-based content.** A route no template
  applies to is treated as built from code alone, and is reused whenever the
  shell hash matches. On a docs site that covers the landing, the playground and
  such — a third of the routes here.
- **Everything under a template's literal root is excluded from the shell
  hash**, generated files included. That is deliberate: a bundled content
  registry changes on every edit and would otherwise invalidate the shell. The
  flip side is that changing the *generator* without touching any content file
  is invisible to the cache — bump something outside that folder when you do.

The manifest is written to `prerender-state.json` in the build directory and
restored via `restore-keys`, so the previous run's snapshots are available even
when the exact key misses.

## How it works

1. Finds `$mol` build directory by locating `index.html` with `mol_view_root`
2. Extracts root component FQN from `index.html`
3. Starts local HTTP server from the build directory
4. Opens each screen in Puppeteer, waits for `$mol` to render
5. Saves rendered HTML as static files (`index.html`, `campaign.html`, etc.)
6. Extracts `<title>` and `<meta description>` from each rendered page for sitemap
7. Generates `sitemap.xml` and `robots.txt`

## Output files

All files are written to the detected build directory (`*/-/`):

- `index.html` — prerendered home screen (overwritten with rendered content)
- `{screen}.html` — prerendered screen pages
- `sitemap.xml` — sitemap with all screen URLs
- `robots.txt` — allows all crawlers, points to sitemap
