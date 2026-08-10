// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "../src/AethelMarketplaceV2.sol";

/**
 * @notice Fresh deployment of AethelMarketplaceV2 on Arc Testnet.
 *         This is NOT an upgrade from V1 — it deploys a new proxy + implementation pair.
 *         V1 proxy (0x86552B0e39CF2b4861cd0d34254F0fd98d23E852) is abandoned after this.
 *
 * Usage:
 *   make deploy-v2-dry-run      (simulate, no broadcast)
 *   make deploy-v2-arc-testnet  (live broadcast to Arc testnet)
 *
 * Required env vars (set in aethel-contracts/.env or pass via shell):
 *   PRIVATE_KEY       — Deployer private key with 0x prefix
 *   USDC_ADDRESS      — Testnet USDC token (default: 0x3600000000000000000000000000000000000000)
 *   TREASURY_ADDRESS  — Protocol treasury (default: same as V1 deployer — see Makefile note)
 */
contract DeployMarketplaceV2 is Script {
    function run() public {
        // Falls back to Anvil's default key #0 for dry-run simulations (no --broadcast).
        // For live deployment, set PRIVATE_KEY=0x<your_key> in .env
        uint256 deployerPrivateKey = vm.envOr(
            "PRIVATE_KEY",
            uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80)
        );

        address testnetUsdc = vm.envOr(
            "USDC_ADDRESS",
            address(0x3600000000000000000000000000000000000000)
        );

        // Default treasury: same as V1 — override via TREASURY_ADDRESS env var
        address treasury = vm.envOr(
            "TREASURY_ADDRESS",
            address(0x2) // placeholder for dry-run only; must be set for live deploy
        );

        vm.startBroadcast(deployerPrivateKey);

        // 1. Deploy implementation (constructor calls _disableInitializers())
        AethelMarketplaceV2 implementation = new AethelMarketplaceV2();

        // 2. Encode the initializer call
        bytes memory initData = abi.encodeWithSelector(
            AethelMarketplaceV2.initialize.selector,
            testnetUsdc,
            treasury
        );

        // 3. Deploy ERC1967 UUPS proxy pointing to implementation
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);

        vm.stopBroadcast();

        console.log(unicode"=== Aethel Marketplace V2 Deployed ===");
        console.log(unicode"Implementation:", address(implementation));
        console.log(unicode"Proxy (use this address):", address(proxy));
        console.log(unicode"USDC token:", testnetUsdc);
        console.log(unicode"Treasury:", treasury);
        console.log(unicode"");
        console.log(unicode"NEXT STEPS:");
        console.log(unicode"  1. Update NEXT_PUBLIC_MARKETPLACE_ADDRESS in .env.local to:", address(proxy));
        console.log(unicode"  2. Fund deployer wallet with >= 60 USDC for 3 agent stakes");
        console.log(unicode"  3. Approve V2 proxy to spend 60 USDC, then run list-agents-v2-live");
        console.log(unicode"  4. Call approveAgent() for each listing via the cast commands in ListAgentsV2.s.sol");
    }
}
