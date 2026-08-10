# ⚡ Æthel Labs — Decentralized AI Agent Marketplace & Autonomous Execution Engine

> **Next-Generation Autonomous AI Agent Marketplace powered by ARC Testnet (Chain ID: 5042002), Circle Developer & User-Controlled MPC Wallets, EIP-3009 Nanopayments Gateway, and Gemini 2.5 Flash LLM Reasoning.**

---

## 🌟 Overview

**Æthel Labs** is a decentralized marketplace and execution platform for autonomous AI trading agents. It enables users to browse, license, deploy, and monitor specialized AI agents that execute real-time trading strategies on-chain.

The platform combines **Smart Money Concepts (SMC) market reasoning**, **Circle Developer-Controlled & User-Controlled Wallets**, and **EIP-3009 micropayments** to deliver seamless, automated agent execution without recurring manual transaction popups.

---

## 🔑 Core Features & Innovations

### 1. 🛒 On-Chain Agent Licensing Marketplace
- **Smart Contract Licensing**: Gated on-chain via the `AethelMarketplaceV2` proxy contract (`0xD3362dB9Afa0D9e0FA6Eb9909527BFb6693AAe53`).
- **USDC Payments**: Transparent USDC token pricing (`0x3600000000000000000000000000000000000000`) on ARC Testnet.
- **Idempotent Ownership Verification**: On-chain `userLicenses()` verification before enabling agent daemon execution.

### 2. 🔐 Dual-Layer Circle MPC Wallet Architecture
- **User-Controlled Wallets**: Social login (Google / OAuth) and 2-of-2 MPC key custody powered by the `@circle-fin/w3s-pw-web-sdk`.
- **Developer-Controlled Trading & Fee Wallets**: Automated provisioning via `@circle-fin/developer-controlled-wallets`:
  - **Trading Wallet**: Dedicated capital pool holding user trading balances (USDC, EURC, cirBTC).
  - **Fee Wallet**: Dedicated EOA for EIP-3009 nanopayment gas settlements, strictly isolating user trading capital from platform task fee billing.

### 3. ⚡ EIP-3009 Nanopayments & Circle Gateway x402
- **Per-Cycle Micropayments**: Fixed 0.0001 USDC task fee deducted per daemon cycle.
- **Batched Settlement**: Authorization payloads (`TransferWithAuthorization`) signed server-side using developer-controlled entity secrets and settled via the Circle x402 Gateway Smart Contract (`0x0077777d7EBA4688BDeF3E311b846F25870A19B9`).

### 4. 🧠 Shared Decision-Engine Architecture
- **Global Market Analyst**: Shared process running once per interval per agent type (`SMC Alpha Executor`) across all active users.
- **Zero Rate-Limit Bottlenecks**: Exactly 1 Gemini 2.5 Flash call & 1 market price feed call per interval regardless of the number of active users.
- **Shared Memory Store**: Stores actionable signals (`action`, `pattern`, `patternLow`, `patternHigh`, `reasoning`, `timestamp`) for instant client daemon consumption.

### 5. 🔁 Layered Autonomous Execution Loop
- **Layer 1 (Reasoning)**: Gemini 2.5 Flash SMC strategy evaluation (Fair Value Gaps, Liquidity Sweeps, Order Blocks).
- **Layer 2 (Spend Policy Gate)**: Enforces spend limits and risk policies (`checkSpendPolicy`).
- **Layer 3 (Execution)**: Automated spot swap execution via Circle App Kit (`estimateSwap` & `executeSwap`).

### 6. 📊 Real-Time Telemetry & Console
- **Dark Glassmorphic UI**: Built with Next.js 15, Tailwind CSS, and Phosphor Icons.
- **Live Daemon Telemetry**: Real-time stats on completed cycles, uptime, last cycle timestamp, open position holdings, and Gemini reasoning.
- **On-Chain Ratings**: Rating & review system (`POST /agents/rate`) authenticated via Circle session tokens and validated against on-chain licenses.

---

## 🏗️ Repository Architecture

```text
├── src/                          # Next.js 15 App Router Frontend
│   ├── app/                      # UI Pages (Marketplace, My Agents, Agent Portal, Billing)
│   │   ├── api/                  # Next.js API Routes (Proxy to Æthel Engine)
│   │   ├── components/           # UI Components & Web3 Providers (CircleWalletProvider)
│   │   └── context.tsx           # Global State Management
├── ENGINE/                       # Æthel Engine Backend Daemon (TypeScript / Node.js)
│   ├── src/
│   │   ├── api/                  # Dispatcher Server & Auth (`dispatcher.ts`)
│   │   ├── agents/               # SMC Executor Loop (`smc_executor_loop.ts`)
│   │   ├── reasoning/            # Market Analyst & Gemini SMC Reasoning (`market_analyst.ts`, `smc.ts`)
│   │   └── lib/                  # Trading & Fee Wallets, AppKit Swap, Nanopayments, Position Store
│   ├── data/                     # Persistent JSON Stores (`positions.json`, `ratings.json`, `transactions.json`)
│   ├── .env.example              # Engine Environment Variable Template
├── aethel-contracts/             # Solidity Smart Contracts (AethelMarketplaceV2)
├── .env.example                  # Frontend Environment Variable Template
├── package.json                  # Workspace Package Manifest
└── README.md                     # Main Documentation
```

---

## 🚀 Quick Start Guide

### Prerequisites
- **Node.js**: v18.0.0 or higher
- **Package Manager**: `pnpm` (recommended) or `npm`

### 1. Clone & Install
```bash
git clone https://github.com/lawalal079/Aethel-Labs.git
cd Aethel-Labs
pnpm install
```

### 2. Environment Setup

Create `.env.local` in the root directory:
```bash
cp .env.example .env.local
```

Create `.env` in the `ENGINE/` directory:
```bash
cp ENGINE/.env.example ENGINE/.env
```

Fill in your respective API keys:
- `CIRCLE_API_KEY` & `CIRCLE_ENTITY_SECRET` (Circle Console)
- `PRIVATE_KEY` (Engine Payee EVM Wallet)
- `GEMINI_API_KEY` (Google AI Studio)

### 3. Run Development Servers

**Terminal 1 — Start Backend Engine:**
```bash
cd ENGINE
npm run dev
```

**Terminal 2 — Start Next.js Frontend:**
```bash
# From root directory
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## 📑 Contract & Network Reference

| Parameter | Value |
| :--- | :--- |
| **Network Name** | ARC Testnet |
| **Chain ID** | `5042002` |
| **RPC URL** | `https://rpc.testnet.arc.network` |
| **Marketplace Proxy Contract** | `0xD3362dB9Afa0D9e0FA6Eb9909527BFb6693AAe53` |
| **Native USDC Address** | `0x3600000000000000000000000000000000000000` |
| **Circle Gateway Address** | `0x0077777d7EBA4688BDeF3E311b846F25870A19B9` |

---

## 📄 License

This project is open source and available under the [MIT License](LICENSE).
