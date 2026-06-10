.PHONY: install build dev dev-daemon dev-agent start-local docker-build docker-up docker-down clean help

# ── Install & build ────────────────────────────────────────────────────────────

install:
	npm install

build: install
	npm run build

# ── Development (local, no tunnel) ────────────────────────────────────────────

dev-daemon:
	npm run dev:daemon

dev-agent:
	npm run dev:agent

# Start both daemon and Playwright MCP locally (M1: no tunnel)
dev:
	@echo ""
	@echo "Starting daemon + Playwright MCP locally."
	@echo "Make sure Chrome is open and remote debugging is enabled:"
	@echo "  chrome://inspect/#remote-debugging"
	@echo ""
	@$(MAKE) -j2 dev-daemon playwright-mcp

playwright-mcp:
	npx --yes @playwright/mcp@latest --port 3000 --browser chrome --cdp-endpoint http://localhost:9222

# ── Host services (M2: with tunnel) ───────────────────────────────────────────

start-local: build
	bash scripts/start-local.sh

# ── Docker (M2: mock AWS VM) ───────────────────────────────────────────────────

docker-build: build
	docker build -f docker/Dockerfile.agent -t remote-browser-agent .

docker-up:
	docker compose up --build

docker-down:
	docker compose down

# ── Misc ──────────────────────────────────────────────────────────────────────

clean:
	rm -rf packages/daemon/dist packages/agent/dist node_modules packages/*/node_modules

help:
	@echo ""
	@echo "Remote Browser MCP — Makefile targets"
	@echo "--------------------------------------"
	@echo "  make install        Install all dependencies"
	@echo "  make build          Build all packages"
	@echo "  make dev            M1: start daemon + Playwright MCP locally (no tunnel)"
	@echo "  make start-local    M2: start all host services + Cloudflare tunnels"
	@echo "  make docker-up      M2: run the agent inside a Docker container (mock AWS VM)"
	@echo "  make docker-down    Stop the Docker container"
	@echo "  make dev-daemon     Watch-mode daemon only"
	@echo "  make dev-agent      Run agent locally (set env vars first)"
	@echo "  make clean          Remove build artifacts"
	@echo ""
