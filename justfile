# cf-graph — Graph store on Cloudflare Durable Objects

# List all targets
default:
    @just --list

# Install dependencies
install:
    npm install

# Generate TypeScript types from wrangler config
types:
    npx wrangler types

# Run local dev server
dev:
    npx wrangler dev

# Type-check without emitting
check:
    npx tsc --noEmit

# Deploy to Cloudflare
deploy:
    npx wrangler deploy

# Tail production logs
tail:
    npx wrangler tail

# Generate graph manifest from LinkML schema
graph-manifest:
    uv run --with pyyaml tools/linkml-to-graph-manifest.py features/lifeos-schema.yaml features/graph-manifest.json

# Create the R2 bucket (run once)
create-bucket:
    npx wrangler r2 bucket create cf-graph-files

# Create the preview R2 bucket (run once, for local dev)
create-preview-bucket:
    npx wrangler r2 bucket create cf-graph-files-preview
