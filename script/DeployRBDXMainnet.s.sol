// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {RBDXToken} from "../src/RBDXToken.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {RBDXVault} from "../src/RBDXVault.sol";

/// @notice Deploys RBDXToken + AssetRegistry + RBDXVault to Robinhood Chain
/// MAINNET and lists real Stock Tokens against their REAL Chainlink Data Feeds.
/// Unlike DeployRBDX.s.sol (testnet-only, deploys a MockAggregator per asset
/// because real feeds don't exist on testnet), this registers the actual feed
/// address directly -- no mocks. See script/config/assets.mainnet.json for the
/// asset list (27 individual-company Stock Tokens with live Chainlink Data
/// Feeds coverage, chosen 2026-09 -- deliberately excludes index/ETF and
/// commodity funds; see that file's own header comment for the full rationale).
///
/// Usage:
///   cp .env.example .env   # fill in PRIVATE_KEY, ADMIN_ADDRESS, DEV_TREASURY
///   source .env
///   forge script script/DeployRBDXMainnet.s.sol:DeployRBDXMainnet \
///     --rpc-url robinhood_mainnet --broadcast -vvvv
///
/// Env vars:
///   PRIVATE_KEY     (required) deployer key.
///   ADMIN_ADDRESS   (required -- no default, unlike the testnet script). This
///                    becomes DEFAULT_ADMIN_ROLE/PARAM_ADMIN_ROLE on both
///                    AssetRegistry and RBDXVault. MUST be a multisig (e.g. a
///                    Safe), never a plain EOA -- see docs/DESIGN.md section 6.
///                    Deliberately not defaulted to the deployer so a real
///                    mainnet deploy can't silently ship with an EOA admin by
///                    forgetting to set this.
///   DEV_TREASURY    (optional) where the 0.1% dev fee is paid, defaults to
///                    the deployer.
///   ASSETS_CONFIG   (optional) path to the asset-list JSON, defaults to
///                    script/config/assets.mainnet.json.
contract DeployRBDXMainnet is Script {
    // Struct field order must match the JSON object's keys sorted alphabetically
    // (chainlinkFeed, maxStaleness, symbol, token) -- see DeployRBDX.s.sol's
    // comment for why (forge-std's vm.parseJson struct decoding).
    struct AssetConfig {
        address chainlinkFeed;
        uint256 maxStaleness;
        string symbol;
        address token;
    }

    function run() external returns (RBDXToken token, AssetRegistry registry, RBDXVault vault) {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address admin = vm.envAddress("ADMIN_ADDRESS"); // no envOr default -- see doc comment above
        address devTreasury = vm.envOr("DEV_TREASURY", deployer);
        string memory configPath = vm.envOr("ASSETS_CONFIG", string("script/config/assets.mainnet.json"));

        console2.log("Deployer:      ", deployer);
        console2.log("Admin:         ", admin);
        console2.log("Dev treasury:  ", devTreasury);
        console2.log("Assets config: ", configPath);

        vm.startBroadcast(deployerKey);

        token = new RBDXToken(deployer);
        // Registry/vault are constructed with the deployer -- not the real
        // `admin` -- holding DEFAULT_ADMIN_ROLE/PARAM_ADMIN_ROLE, purely so
        // this script can call addAsset 27 times in the same broadcast: a
        // real multisig ADMIN_ADDRESS (as required above) can't co-sign an
        // atomic forge-script run the way an EOA private key can. Admin power
        // is hand-off to the real `admin` and fully renounced by the deployer
        // in _handOffAdmin below, in the same broadcast -- nothing
        // deployer-controlled is left standing once this function returns.
        registry = new AssetRegistry(deployer);
        vault = new RBDXVault(token, registry, devTreasury, deployer);
        token.setVault(address(vault));
        // The deployer has no further use for RBDXToken's Ownable role after
        // this one-time wiring call (setVault reverts if called again, and
        // there's no other onlyOwner function) -- renounce it so no dangling
        // deployer-EOA privilege is left sitting on-chain for anyone auditing
        // the deployed state to wonder about.
        token.renounceOwnership();

        console2.log("RBDXToken:     ", address(token));
        console2.log("AssetRegistry: ", address(registry));
        console2.log("RBDXVault:     ", address(vault));

        _listAssets(registry, configPath);
        _handOffAdmin(registry, vault, admin, deployer);

        vm.stopBroadcast();
    }

    /// @dev Grants the real (multisig) admin its roles on registry/vault, then
    /// renounces every role the deployer was holding temporarily so it can
    /// list assets above. Order matters: grant before renounce, or a
    /// deployer-only renounce of DEFAULT_ADMIN_ROLE first would leave both
    /// contracts with zero admin, permanently.
    function _handOffAdmin(AssetRegistry registry, RBDXVault vault, address admin, address deployer) internal {
        bytes32 defaultAdminRole = registry.DEFAULT_ADMIN_ROLE(); // 0x00, same constant on both contracts
        bytes32 paramAdminRole = vault.PARAM_ADMIN_ROLE();

        registry.grantRole(defaultAdminRole, admin);
        vault.grantRole(defaultAdminRole, admin);
        vault.grantRole(paramAdminRole, admin);

        registry.renounceRole(defaultAdminRole, deployer);
        vault.renounceRole(defaultAdminRole, deployer);
        vault.renounceRole(paramAdminRole, deployer);

        console2.log("Admin handed off to:", admin);
    }

    function _listAssets(AssetRegistry registry, string memory configPath) internal {
        // Unlike DeployRBDX.s.sol's testnet version, a missing mainnet config is
        // a mistake, not a valid "no assets yet" state -- fail loudly.
        string memory json = vm.readFile(configPath);
        AssetConfig[] memory assets = abi.decode(vm.parseJson(json, ".assets"), (AssetConfig[]));
        for (uint256 i = 0; i < assets.length; i++) {
            AssetConfig memory a = assets[i];
            registry.addAsset(a.token, a.chainlinkFeed, a.maxStaleness);
            console2.log("Listed", a.symbol, a.token);
            console2.log("  feed:", a.chainlinkFeed);
        }
    }
}
