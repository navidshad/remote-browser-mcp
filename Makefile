.PHONY: install build dev dev-daemon dev-agent chrome-debug aso-window start-local docker-build docker-up docker-down clean help

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

# ── Debuggable Chrome (CDP-port mode) ─────────────────────────────────────────

# Launch a dedicated debug Chrome on port 9222 (separate profile; your normal
# Chrome is untouched). Required before the agent can drive a page — Chrome 136+
# blocks debugging on the default profile and the chrome://inspect toggle does
# not expose a usable port.
chrome-debug:
	bash scripts/start-chrome-debug.sh

# Ensure the agent's Chrome profile (ASO_PROFILE_NAME, resolved by name) has a
# window open so the bridge extension is live. Extension mode; background is fine.
aso-window:
	bash scripts/open-aso-window.sh

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
	@echo "  make aso-window     Open the agent's Chrome profile window (extension mode)"
	@echo "  make chrome-debug   Launch dedicated debug Chrome on port 9222 (CDP-port fallback)"
	@echo "  make dev            M1: start daemon + Playwright MCP locally (no tunnel)"
	@echo "  make start-local    M2: start all host services + Cloudflare tunnels"
	@echo "  make docker-up      M2: run the agent inside a Docker container (mock AWS VM)"
	@echo "  make docker-down    Stop the Docker container"
	@echo "  make dev-daemon     Watch-mode daemon only"
	@echo "  make dev-agent      Run agent locally (set env vars first)"
	@echo "  make clean          Remove build artifacts"
	@echo ""
