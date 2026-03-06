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
| `screens` | no | `""` | Screen IDs to prerender, one per line |
| `route-format` | no | `#!` | URL routing: `#!` (hash) or `?` (query) |
| `route-key` | no | `screen` | URL parameter key |
| `viewport` | no | `430x932` | Viewport as WIDTHxHEIGHT |
| `timeout` | no | `15000` | Render wait timeout (ms) |

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
