// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {RBDXToken} from "../src/RBDXToken.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {RBDXVault} from "../src/RBDXVault.sol";

/// @notice Deploys RBDXToken + AssetRegistry + RBDXVault, wires them together
/// (token.setVault), and lists whatever assets are defined in the JSON config at
/// `ASSETS_CONFIG` (defaults to script/config/assets.testnet.json).
///
/// Deliberately does NOT hardcode any Stock Token / Chainlink feed addresses —
/// Robinhood Chain's token-contracts page renders its list client-side (from a
/// live on-chain registry), so there's no static address list to safely bake into
/// this repo. Fill in the JSON config yourself from
/// https://docs.robinhood.com/chain/contracts (testnet) before running this, per
/// AssetRegistry's own "researched, not assumed" principle (see DESIGN.md §2).
///
/// Usage:
///   cp .env.example .env               # fill in PRIVATE_KEY etc.
///   source .env                        # or use `--rpc-url` / env flags directly
///   forge script script/DeployRBDX.s.sol:DeployRBDX \
///     --rpc-url robinhood_testnet --broadcast -vvvv
///
/// Env vars:
///   PRIVATE_KEY     (required) deployer key — becomes admin/PARAM_ADMIN/DEFAULT_ADMIN
///                    on both AssetRegistry and RBDXVault unless ADMIN_ADDRESS is set.
///   ADMIN_ADDRESS   (optional) governance admin, defaults to the deployer. On
///                    testnet an EOA is fine; before mainnet this should be a
///                    Gnosis Safe + timelock per DESIGN.md §6.
///   DEV_TREASURY    (optional) where the 0.1% dev fee is paid out, defaults to
///                    the deployer.
///   ASSETS_CONFIG   (optional) path to the asset-list JSON, defaults to
///                    script/config/assets.testnet.json.
contract DeployRBDX is Script {
    // Struct field order must match the JSON object's keys sorted alphabetically
    // (feed, maxStaleness, symbol, token) — that's how forge-std's vm.parseJson
    // struct decoding works.
    struct AssetConfig {
        address feed;
        uint256 maxStaleness;
        string symbol;
        address token;
    }

    function run() external returns (RBDXToken token, AssetRegistry registry, RBDXVault vault) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address admin = vm.envOr("ADMIN_ADDRESS", deployer);
        address devTreasury = vm.envOr("DEV_TREASURY", deployer);
        string memory configPath = vm.envOr("ASSETS_CONFIG", string("script/config/assets.testnet.json"));

        console2.log("Deployer:      ", deployer);
        console2.log("Admin:         ", admin);
        console2.log("Dev treasury:  ", devTreasury);
        console2.log("Assets config: ", configPath);

        vm.startBroadcast(deployerKey);

        token = new RBDXToken(deployer);
        registry = new AssetRegistry(admin);
        vault = new RBDXVault(token, registry, devTreasury, admin);
        token.setVault(address(vault));

        console2.log("RBDXToken:     ", address(token));
        console2.log("AssetRegistry: ", address(registry));
        console2.log("RBDXVault:     ", address(vault));

        _listAssets(registry, configPath);

        vm.stopBroadcast();
    }

    function _listAssets(AssetRegistry registry, string memory configPath) internal {
        string memory json;
        try vm.readFile(configPath) returns (string memory content) {
            json = content;
        } catch {
            console2.log("No assets config found at", configPath, "- skipping addAsset calls.");
            return;
        }

        AssetConfig[] memory assets = abi.decode(vm.parseJson(json, ".assets"), (AssetConfig[]));
        for (uint256 i = 0; i < assets.length; i++) {
            AssetConfig memory a = assets[i];
            if (a.token == address(0) || a.feed == address(0)) {
                console2.log("Skipping unset placeholder entry:", a.symbol);
                continue;
            }
            registry.addAsset(a.token, a.feed, a.maxStaleness);
            console2.log("Listed", a.symbol, a.token);
        }
    }
}
