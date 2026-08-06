# Renderer specs

Node-run Playwright harnesses, no test framework. Each spec stubs the bridge
(`window.hubApi` / `window.launcherApi`) via `addInitScript`, loads the real page
over a loopback HTTP server, and drives it with real keyboard and mouse events.

```bash
npm run test:renderer
```

Two things are deliberate:

**They serve over http, not `file://`.** Both pages carry the CSP they ship with,
and `script-src 'self'` doesn't resolve usefully for a file origin — the specs
would either fail to load the scripts or test a policy the app never runs under.
`serve.mjs` is a ~30-line static server for exactly this.

**They assert behaviour, not markup.** A spec should survive restyling. Where a
selector is asserted it's because the class carries meaning (`.row-dot.warn`,
`.card-error`), not because it happens to exist.

`CHROMIUM_PATH` overrides the browser binary if you don't want Playwright's.
