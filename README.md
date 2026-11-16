# Pathnote

See which files your AI searched, read and wrote, live on a map of your folders.

- Website: https://pathnote.pages.dev
- npm: [`pathnote`](https://www.npmjs.com/package/pathnote) — `npx -y pathnote setup`
- Full documentation: [app/README.md](app/README.md)

## Repository layout

| Path | What it is |
| --- | --- |
| `app/` | The npm package: MCP server (`src/`), local viewer (`viewer/index.html`), CLI (`bin/`), tests |
| `public/` | Landing page (Cloudflare Pages) |
| `functions/` | Waitlist API (Cloudflare Pages Functions + D1) |
| `scripts/` | Helper for connecting Pathnote to Claude Desktop on macOS |

## Development

```bash
cd app
npm ci
node --test test/*.test.js
node bin/pathnote.js --sample ~/pathnote-sample   # sample notes to try it on
```

Landing page: `npm ci && npm run db:local && npm run dev` from the repository root.

## License

MIT — see [app/LICENSE](app/LICENSE).
