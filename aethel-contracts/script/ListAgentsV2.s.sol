// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/AethelMarketplaceV2.sol";

/**
 * @notice Lists the 3 real sellable agents on AethelMarketplaceV2 via the deployer key.
 *         Run once after deployment to seed the V2 marketplace registry.
 *
 *         Agents listed here (per AETHEL_LABS_ROADMAP.md Section 3, confirmed 2026-07-23):
 *           - SMC Alpha Executor        (agent_smc_alpha_executor)
 *           - Risk-Adjusted Rebalancer  (agent_risk_rebalancer)
 *           - Cross-DEX Arbitrageur     (agent_crossdex_arb)
 *
 *         NOT listed (old V1 placeholder agents — abandoned):
 *           agent_python_coding, agent_lang_translation, agent_image_gen,
 *           agent_ai_moderation, agent_data_analysis, agent_content_writing
 *
 *         STAKE REQUIREMENT: 3 agents × 20 USDC = 60 USDC total.
 *         The deployer wallet MUST hold >= 60 USDC on Arc testnet before running --broadcast.
 *         The deployer must also have approved V2_PROXY to spend 60 USDC via the USDC
 *         approve() call below (handled inside this script before any listAgent call).
 *
 *         ALL LISTINGS START AS PendingApproval (status=0).
 *         Nothing is purchasable until the owner calls approveAgent() for each one.
 *         See the cast commands at the bottom of this file for approval.
 *
 * Usage:
 *   make list-agents-v2          (dry-run, no broadcast)
 *   make list-agents-v2-live     (live broadcast to Arc testnet)
 *
 * Required env vars:
 *   PRIVATE_KEY              — Deployer private key with 0x prefix
 *   V2_PROXY_ADDRESS         — Address of the freshly deployed V2 proxy
 *   ENGINE_WALLET_ADDRESS    — Deployer/engine wallet that receives ongoing task fees
 *                              (set to NEXT_PUBLIC_ENGINE_WALLET_ADDRESS from .env.local)
 */

interface IERC20Approve {
    function approve(address spender, uint256 amount) external returns (bool);
}

contract ListAgentsV2 is Script {
    // ── Update these after deployment ──────────────────────────────────────────
    // V2_PROXY_ADDRESS is read from env; must be set before running --broadcast.
    // USDC on Arc testnet
    address constant USDC = 0x3600000000000000000000000000000000000000;

    // Stake per listing: must match AethelMarketplaceV2.minListingStake (20 USDC)
    uint256 constant STAKE_PER_AGENT = 20_000000; // 20 USDC (6 decimals)
    uint256 constant NUM_AGENTS      = 3;
    uint256 constant TOTAL_STAKE     = STAKE_PER_AGENT * NUM_AGENTS; // 60 USDC

    function run() public {
        uint256 deployerPrivateKey = vm.envOr(
            "PRIVATE_KEY",
            uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80)
        );

        // V2 proxy — must be set after DeployV2.s.sol broadcast
        address v2Proxy = vm.envOr(
            "V2_PROXY_ADDRESS",
            address(0) // will revert on listAgent if not set; intentional for dry-run safety
        );

        // Engine wallet: receives ongoing per-task Nanopayments revenue
        address engineWallet = vm.envOr(
            "ENGINE_WALLET_ADDRESS",
            address(0xDe45Ec28834C609307BEf5651688A6c41d5e6994) // from .env.local NEXT_PUBLIC_ENGINE_WALLET_ADDRESS
        );

        AethelMarketplaceV2 market = AethelMarketplaceV2(v2Proxy);

        vm.startBroadcast(deployerPrivateKey);

        // ── 0. Approve V2 proxy to pull total stake from deployer wallet ─────────
        // This must succeed before any listAgent call or the transferFrom will revert.
        // Safe to call even if allowance is already set — approve() overwrites.
        IERC20Approve(USDC).approve(v2Proxy, TOTAL_STAKE);
        console.log("Approved V2 proxy to spend", TOTAL_STAKE, "USDC (6 dec) from deployer");

        // ── 1. SMC Alpha Executor ─────────────────────────────────────────────────
        _listIfNew(
            market,
            "agent_smc_alpha_executor",
            15_000000, // $15.00 one-time license (6 decimals)
            unicode'{"title":"SMC Alpha Executor","description":"Autonomous FX & token-pair trading agent using Smart Money Concepts analysis. Executes USDC/EURC/cbBTC swaps on Arc via Circle App Kit Swap - no human confirmation required per trade.","icon":"TrendingUp","category":"DeFi"}',
            engineWallet
        );

        // ── 2. Risk-Adjusted Rebalancer ───────────────────────────────────────────
        _listIfNew(
            market,
            "agent_risk_rebalancer",
            12_000000, // $12.00 one-time license (6 decimals)
            unicode'{"title":"Risk-Adjusted Rebalancer","description":"Continuously monitors portfolio allocation and autonomously rebalances toward target weights using real-time risk signals. Executes rebalancing trades via Arc StableFX within user-defined spend limits.","icon":"BarChart2","category":"DeFi"}',
            engineWallet
        );

        // ── 3. Cross-DEX Arbitrageur ──────────────────────────────────────────────
        _listIfNew(
            market,
            "agent_crossdex_arb",
            18_000000, // $18.00 one-time license (6 decimals)
            unicode'{"title":"Cross-DEX Arbitrageur","description":"Detects and executes swap-based arbitrage opportunities across Arc-native liquidity pools. Operates fully autonomously within user-configured risk envelopes - no flash loans, pure spot arbitrage.","icon":"Zap","category":"DeFi"}',
            engineWallet
        );

        vm.stopBroadcast();

        console.log("");
        console.log("=== Listing complete ===");
        console.log("All 3 agents are now PendingApproval (status=0).");
        console.log("NONE are purchasable until you approve each one.");
        console.log("");
        console.log("Run these cast commands to approve each listing (replace <PROXY> and <PRIVATE_KEY>):");
        console.log("");
        console.log("  # SMC Alpha Executor");
        console.log("  cast send <PROXY> \"approveAgent(string)\" \"agent_smc_alpha_executor\" \\");
        console.log("    --rpc-url https://rpc.testnet.arc.network --private-key <PRIVATE_KEY> --legacy");
        console.log("");
        console.log("  # Risk-Adjusted Rebalancer");
        console.log("  cast send <PROXY> \"approveAgent(string)\" \"agent_risk_rebalancer\" \\");
        console.log("    --rpc-url https://rpc.testnet.arc.network --private-key <PRIVATE_KEY> --legacy");
        console.log("");
        console.log("  # Cross-DEX Arbitrageur");
        console.log("  cast send <PROXY> \"approveAgent(string)\" \"agent_crossdex_arb\" \\");
        console.log("    --rpc-url https://rpc.testnet.arc.network --private-key <PRIVATE_KEY> --legacy");
    }

    /**
     * @dev Only lists if not already registered (idempotent guard).
     *      In a fresh V2 deploy there should be nothing registered yet —
     *      this guard is a safety net for re-runs.
     */
    function _listIfNew(
        AethelMarketplaceV2 market,
        string memory agentId,
        uint256 priceUsdc6,
        string memory metadataUri,
        address engineWallet
    ) internal {
        // marketRegistry is a public mapping — the auto-generated getter returns a tuple.
        // Destructure just the creator (index 1) to check if the slot is registered.
        (
            /*_agentId*/,
            address creator,
            /*_engineWallet*/,
            /*_price*/,
            /*_stakedAmount*/,
            /*_recurringFeeBps*/,
            /*_status*/,
            /*_metadataUri*/
        ) = market.marketRegistry(agentId);

        if (creator == address(0)) {
            market.listAgent(agentId, priceUsdc6, metadataUri, engineWallet);
            console.log("Listed:", agentId, "at price (6dec):", priceUsdc6);
        } else {
            console.log("Already registered, skipping:", agentId);
        }
    }
}
