SHELL := /bin/bash

IMAGE ?= faustforge:latest
NAME ?= faustforge
PORT ?= 3000
HOST_SESSIONS_DIR ?= $(HOME)/.faustforge/sessions
HOST_WORKSPACE_DIR ?= $(HOME)/faust-workspace
FAUST_HTTP_URL ?= http://localhost:$(PORT)
LIVE_AUTO_DISCOVER ?= 1
LIVE_WORKSPACE_ROOT ?= /workspace
HOST_LIVE_WORKSPACE_ROOT ?= $(HOST_WORKSPACE_DIR)
LIVE_SCAN_INTERVAL_MS ?= 1500
LIVE_IGNORE_DIRS ?=
MAX_SESSIONS ?= 0
CONTEXT ?= .
NO_CACHE ?= 1

.PHONY: help rebuild run stop restart logs

help:
	@echo "Targets:"
	@echo "  make rebuild   Rebuild Docker image"
	@echo "  make run       Start container"
	@echo "  make stop      Stop and remove container"
	@echo "  make restart   Stop then rebuild and start container"
	@echo "  make logs      Follow container logs"
	@echo ""
	@echo "Variables (override with VAR=value):"
	@echo "  IMAGE=$(IMAGE)"
	@echo "  NAME=$(NAME)"
	@echo "  PORT=$(PORT)"
	@echo "  HOST_SESSIONS_DIR=$(HOST_SESSIONS_DIR)"
	@echo "  HOST_WORKSPACE_DIR=$(HOST_WORKSPACE_DIR)"
	@echo "  FAUST_HTTP_URL=$(FAUST_HTTP_URL)"
	@echo "  LIVE_AUTO_DISCOVER=$(LIVE_AUTO_DISCOVER)"
	@echo "  LIVE_WORKSPACE_ROOT=$(LIVE_WORKSPACE_ROOT)"
	@echo "  HOST_LIVE_WORKSPACE_ROOT=$(HOST_LIVE_WORKSPACE_ROOT)"
	@echo "  LIVE_SCAN_INTERVAL_MS=$(LIVE_SCAN_INTERVAL_MS)"
	@echo "  LIVE_IGNORE_DIRS=$(LIVE_IGNORE_DIRS)"
	@echo "  MAX_SESSIONS=$(MAX_SESSIONS)"
	@echo "  CONTEXT=$(CONTEXT)"
	@echo "  NO_CACHE=$(NO_CACHE)"

rebuild:
	@IMAGE="$(IMAGE)" CONTEXT="$(CONTEXT)" NO_CACHE="$(NO_CACHE)" ./scripts/rebuild.sh

run:
	@IMAGE="$(IMAGE)" NAME="$(NAME)" PORT="$(PORT)" HOST_SESSIONS_DIR="$(HOST_SESSIONS_DIR)" HOST_WORKSPACE_DIR="$(HOST_WORKSPACE_DIR)" FAUST_HTTP_URL="$(FAUST_HTTP_URL)" LIVE_AUTO_DISCOVER="$(LIVE_AUTO_DISCOVER)" LIVE_WORKSPACE_ROOT="$(LIVE_WORKSPACE_ROOT)" HOST_LIVE_WORKSPACE_ROOT="$(HOST_LIVE_WORKSPACE_ROOT)" LIVE_SCAN_INTERVAL_MS="$(LIVE_SCAN_INTERVAL_MS)" LIVE_IGNORE_DIRS="$(LIVE_IGNORE_DIRS)" MAX_SESSIONS="$(MAX_SESSIONS)" ./scripts/run.sh

stop:
	@NAME="$(NAME)" ./scripts/stop.sh

restart: stop rebuild run

logs:
	@docker logs -f "$(NAME)"
