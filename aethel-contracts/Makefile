# ==============================================================================
#  Æthel Labs — Marketplace Deployment Makefile
#  Target Network: ARC Testnet (Circle Layer-1, Chain ID: 5042002)
# ==============================================================================
-include .env

# Ensure Foundry binaries are on PATH
# WSL user is 'binlawal' — foundry lives at /home/binlawal/.foundry/bin
export PATH := /home/binlawal/.foundry/bin:$(HOME)/.foundry/bin:$(PATH)

.PHONY: all build test clean coverage snapshot format \
        deploy-v2-dry-run deploy-v2-arc-testnet list-agents-v2 list-agents-v2-live \
        approve-agents-v2-live verify-v2 help

# ------------------------------------------------------------------------------
# ARC Testnet Config
# ------------------------------------------------------------------------------
ARC_RPC_URL       ?= https://rpc.testnet.arc.network
ARC_CHAIN_ID      ?= 5042002
ARC_EXPLORER_URL  ?= https://testnet.arcscan.app

# Deploy script entrypoint
DEPLOY_V2_SCRIPT  := script/DeployV2.s.sol:DeployMarketplaceV2

# ------------------------------------------------------------------------------
# Core targets
# ------------------------------------------------------------------------------
all: clean build test

build:
	@forge build

test:
	@forge test -vv

test-verbose:
	@forge test -vvvv

coverage:
	@forge coverage

snapshot:
	@forge snapshot

format:
	@forge fmt

clean:
	@forge clean

# ------------------------------------------------------------------------------
# V2 Deployment & Listing (ARC Testnet)
# Set V2_PROXY_ADDRESS and ENGINE_WALLET_ADDRESS in aethel-contracts/.env after deploy.
# ------------------------------------------------------------------------------

## V2 Dry-run: simulate deployment locally — no broadcast, no gas spent
deploy-v2-dry-run:
	@echo "==> Simulating V2 deployment on ARC Testnet (no broadcast)..."
	@forge script $(DEPLOY_V2_SCRIPT) \
		--rpc-url $(ARC_RPC_URL) \
		--chain-id $(ARC_CHAIN_ID) \
		--sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
		-vvvv

## V2 Live deploy: broadcast transactions to ARC Testnet
deploy-v2-arc-testnet:
	@echo "==> Deploying Aethel Marketplace V2 to ARC Testnet (Chain ID: $(ARC_CHAIN_ID))..."
	@forge script $(DEPLOY_V2_SCRIPT) \
		--rpc-url $(ARC_RPC_URL) \
		--chain-id $(ARC_CHAIN_ID) \
		--private-key $(PRIVATE_KEY) \
		--broadcast \
		--legacy \
		-vvvv

## V2 Seed marketplace: list 3 real agents (dry-run, no broadcast)
list-agents-v2:
	@echo "==> Simulating V2 agent listings (no broadcast)..."
	@forge script script/ListAgentsV2.s.sol:ListAgentsV2 \
		--rpc-url $(ARC_RPC_URL) \
		--chain-id $(ARC_CHAIN_ID) \
		-vvvv

## V2 Seed marketplace: list 3 real agents (live broadcast)
## Requires: deployer wallet has >= 60 USDC; V2_PROXY_ADDRESS and ENGINE_WALLET_ADDRESS set in .env
list-agents-v2-live:
	@echo "==> Listing 3 agents on ARC Testnet V2 (live broadcast)..."
	@forge script script/ListAgentsV2.s.sol:ListAgentsV2 \
		--rpc-url $(ARC_RPC_URL) \
		--chain-id $(ARC_CHAIN_ID) \
		--private-key $(PRIVATE_KEY) \
		--broadcast \
		--legacy \
		-vvvv

## Approve the 3 real agents on V2 (owner-only approval gate)
approve-agents-v2-live:
	@echo "==> Approving 3 agent listings on ARC Testnet V2..."
	@cast send $(V2_PROXY_ADDRESS) "approveAgent(string)" "agent_smc_alpha_executor" --rpc-url $(ARC_RPC_URL) --private-key $(PRIVATE_KEY) --legacy
	@cast send $(V2_PROXY_ADDRESS) "approveAgent(string)" "agent_risk_rebalancer" --rpc-url $(ARC_RPC_URL) --private-key $(PRIVATE_KEY) --legacy
	@cast send $(V2_PROXY_ADDRESS) "approveAgent(string)" "agent_crossdex_arb" --rpc-url $(ARC_RPC_URL) --private-key $(PRIVATE_KEY) --legacy

## Verify V2 implementation source on ARC block explorer
## Usage: make verify-v2 CONTRACT=<impl_address> (defaults to deployed V2 implementation)
CONTRACT ?= 0x9FD4048323A36fD16BA6883d2517B672e6Cf6437
verify-v2:
	@echo "==> Verifying V2 contract $(CONTRACT) on ARC Testnet explorer..."
	@forge verify-contract $(CONTRACT) \
		src/AethelMarketplaceV2.sol:AethelMarketplaceV2 \
		--rpc-url $(ARC_RPC_URL) \
		--chain-id $(ARC_CHAIN_ID) \
		--verifier blockscout \
		--verifier-url $(ARC_EXPLORER_URL)/api

# ------------------------------------------------------------------------------
# Help
# ------------------------------------------------------------------------------
help:
	@echo ""
	@echo "  Aethel Labs Marketplace V2 — Available Commands"
	@echo "  ================================================"
	@echo "  make build                     — Compile V2 contracts"
	@echo "  make test                      — Run test suite"
	@echo "  make clean                     — Remove build artifacts"
	@echo "  make format                    — Format Solidity files"
	@echo "  make deploy-v2-dry-run         — Simulate V2 fresh deployment"
	@echo "  make deploy-v2-arc-testnet     — Deploy V2 fresh to ARC Testnet"
	@echo "  make list-agents-v2-live       — List 3 real agents on V2 (needs 60 USDC)"
	@echo "  make approve-agents-v2-live    — Approve 3 agents (owner-only)"
	@echo "  make verify-v2                 — Verify V2 source on ARC explorer"
	@echo ""
