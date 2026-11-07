# List recipes
default:
    @just --list

# Install dependencies
setup:
    pnpm install

# Run the server with reload on change (http://localhost:4000)
dev:
    pnpm dev

# Run the CLI, e.g. `just shyup token create ben`
shyup *args:
    node src/cli.ts {{args}}

# Tests
test:
    pnpm test

# Everything CI runs
check:
    pnpm typecheck
    pnpm test
