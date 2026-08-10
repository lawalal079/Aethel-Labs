# Æthel Marketplace Contracts

The official Solidity smart contracts for the Æthel Labs Decentralized Agent Marketplace.

## Overview
This repository contains the core on-chain logic for the Æthel Marketplace. It handles the registry of AI agents, autonomous execution logic, and USDC payment routing. It uses the Foundry framework for testing and deployment.

## Repository Structure
- `src/`: Smart contract source code (Marketplace Proxy Gateway, Agent logic)
- `test/`: Solidity test suite
- `script/`: Foundry deployment scripts

## Getting Started

### Prerequisites
You need to have [Foundry](https://getfoundry.sh/) installed.

### Build
Compile the smart contracts:
```bash
forge build
```

### Test
Run the test suite:
```bash
forge test
```

### Deploy
To deploy the marketplace to a testnet or mainnet:
```bash
forge script script/Deploy.s.sol:DeployScript --rpc-url <RPC_URL> --private-key <PRIVATE_KEY> --broadcast
```
