# cf-graph

Cloudflare Workers project (TypeScript) managed with Wrangler CLI.

## Quick start

```bash
npm install
npm run dev
```

## Available scripts

- `npm run dev` - run the worker locally with Wrangler
- `npm run test` - run Vitest unit/integration tests
- `npm run deploy` - deploy with Wrangler
- `npm run cf-typegen` - regenerate Worker binding types

## Agent support

This repository includes:

- `AGENTS.md` for Claude Code/Codex guidance
- `.github/workflows/copilot-setup-steps.yml` to preinstall dependencies and Wrangler in Copilot cloud agent sessions
