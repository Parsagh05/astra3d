.PHONY: help build dev prod clean logs

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-10s\033[0m %s\n", $$1, $$2}'

build: ## Build production Docker image
	docker build --target production -t astra3d:latest .

build-dev: ## Build development Docker image
	docker build --target dev -t astra3d:dev .

dev: ## Run development container with docker-compose
	docker-compose up -d
	@echo "Astra3D running at http://localhost:3000"

prod: ## Run production container with docker-compose
	docker-compose -f docker-compose.prod.yml up -d
	@echo "Astra3D running at http://localhost:3000"

stop: ## Stop containers
	docker-compose down

stop-prod: ## Stop production container
	docker-compose -f docker-compose.prod.yml down

clean: ## Remove containers and volumes
	docker-compose down -v

logs: ## Tail development logs
	docker-compose logs -f

logs-prod: ## Tail production logs
	docker-compose -f docker-compose.prod.yml logs -f

rebuild: ## Rebuild and restart development container
	docker-compose up -d --force-recreate

shell: ## Open shell in development container
	docker-compose exec astra3d sh
