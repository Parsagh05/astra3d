.PHONY: help build build-dev dev prod stop stop-prod clean logs logs-prod rebuild shell import-volume

# Docker Compose v2 ("docker compose") with a fallback to the v1 binary.
# Older setups kept photos in this Docker volume; see `make import-volume`.
OLD_VOLUME ?= astra3d_astra3d-data
COMPOSE ?= $(shell docker compose version >/dev/null 2>&1 && echo "docker compose" || echo docker-compose)

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-10s\033[0m %s\n", $$1, $$2}'

build: ## Build production Docker image
	docker build --target production -t astra3d:latest .

build-dev: ## Build development Docker image
	docker build --target dev -t astra3d:dev .

dev: ## Run development container (hot reload); data stays in .astra3d-data/
	mkdir -p .astra3d-data test-cases
	$(COMPOSE) up -d
	@echo "Astra3D running at http://localhost:3000"

prod: ## Run production container; data stays in .astra3d-data/
	mkdir -p .astra3d-data test-cases
	$(COMPOSE) -f docker-compose.prod.yml up -d --build
	@echo "Astra3D running at http://localhost:3000"

stop: ## Stop containers
	$(COMPOSE) down

stop-prod: ## Stop production container
	$(COMPOSE) -f docker-compose.prod.yml down

clean: ## Remove containers and build caches (keeps .astra3d-data/ and test-cases/)
	$(COMPOSE) down -v --remove-orphans

logs: ## Tail development logs
	$(COMPOSE) logs -f

logs-prod: ## Tail production logs
	$(COMPOSE) -f docker-compose.prod.yml logs -f

rebuild: ## Rebuild and restart development container
	$(COMPOSE) up -d --build --force-recreate

shell: ## Open shell in development container
	$(COMPOSE) exec astra3d sh

import-volume: ## Copy photos from the old astra3d-data Docker volume into .astra3d-data/
	mkdir -p .astra3d-data
	docker run --rm -v $(OLD_VOLUME):/from:ro -v "$(CURDIR)/.astra3d-data":/to node:22-bookworm-slim sh -c 'cp -an /from/. /to/ && ls /to/projects 2>/dev/null | wc -l | xargs echo "projects now in .astra3d-data:"'
