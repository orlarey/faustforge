SHELL := /bin/bash

IMAGE ?= faustforge:latest
NAME ?= faustforge
PORT ?= 3000
HOST_SESSIONS_DIR ?= $(HOME)/.faustforge/sessions
FAUST_HTTP_URL ?= http://localhost:$(PORT)
CONTEXT ?= .
NO_CACHE ?= 1

.PHONY: help rebuild run stop restart logs

help:
	@echo "Targets:"
	@echo "  make rebuild   Rebuild Docker image"
	@echo "  make run       Start container"
	@echo "  make stop      Stop and remove container"
	@echo "  make restart   Stop then rebuild andstart container"
	@echo "  make logs      Follow container logs"
	@echo ""
	@echo "Variables (override with VAR=value):"
	@echo "  IMAGE=$(IMAGE)"
	@echo "  NAME=$(NAME)"
	@echo "  PORT=$(PORT)"
	@echo "  HOST_SESSIONS_DIR=$(HOST_SESSIONS_DIR)"
	@echo "  FAUST_HTTP_URL=$(FAUST_HTTP_URL)"
	@echo "  CONTEXT=$(CONTEXT)"
	@echo "  NO_CACHE=$(NO_CACHE)"

rebuild:
	@IMAGE="$(IMAGE)" CONTEXT="$(CONTEXT)" NO_CACHE="$(NO_CACHE)" ./scripts/rebuild.sh

run:
	@IMAGE="$(IMAGE)" NAME="$(NAME)" PORT="$(PORT)" HOST_SESSIONS_DIR="$(HOST_SESSIONS_DIR)" FAUST_HTTP_URL="$(FAUST_HTTP_URL)" ./scripts/run.sh

stop:
	@NAME="$(NAME)" ./scripts/stop.sh

restart: stop rebuild run

logs:
	@docker logs -f "$(NAME)"
