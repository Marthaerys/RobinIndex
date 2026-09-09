// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {RBDXToken} from "../src/RBDXToken.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {RBDXVault} from "../src/RBDXVault.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";

/// @title GasBenchmark
/// @notice Answers a scaling question raised while reviewing an arbitrage-bot
/// proposal for a ~100-asset basket: does RBDXVault.mint()/redeem() become
/// prohibitively expensive as the number of listed/held Stock Tokens grows?
///
/// Two loops drive the cost, on every single mint/redeem call:
///   - AssetRegistry.totalCirculatingValue() — O(all LISTED assets), pulled in via
///     targetWeightOf().
///   - RBDXVault._nav() — O(all HELD assets, i.e. `heldTokens`).
///
/// This measures both in the deliberate worst case (listed == held == N, every
/// asset nonzero) rather than guessing from opcode counts. See the docs/DESIGN.md
/// discussion and the review that prompted this for the caching alternative if
/// these numbers turn out to matter.
contract GasBenchmarkTest is Test {
    RBDXToken rbdx;
    AssetRegistry registry;
    RBDXVault vault;

    address admin = makeAddr("admin");
    address devTreasury = makeAddr("devTreasury");
    address trader = makeAddr("trader"); // stands in for the arbitrage bot
    address floatHolder = makeAddr("floatHolder");

    MockStockToken[] tokens;

    uint256 constant PRICE_8DEC = 10e8; // $10 flat — weight split is irrelevant to gas cost
    uint256 constant MAX_STALENESS = 1 days;
    uint256 constant DEPOSIT_PER_ASSET = 10_000e18; // $100,000 per asset, well above the $100 bootstrap floor

    /// @dev Deploys `n` Stock Tokens, lists all `n`, then mints RBDX against every
    /// one of them from `trader` so `heldTokens.length() == n` (worst case for
    /// _nav()) while `assetList.length` is also `n` (worst case for
    /// totalCirculatingValue()). A real deployment would list its full basket up
    /// front and let the vault fill in gradually — this just skips straight to the
    /// "fully filled" end state so we measure the worst case, not the average one.
    function _setupWithNAssets(uint256 n) internal {
        vm.startPrank(admin);
        rbdx = new RBDXToken(admin);
        registry = new AssetRegistry(admin);
        vault = new RBDXVault(rbdx, registry, devTreasury, admin);
        rbdx.setVault(address(vault));
        vm.stopPrank();

        delete tokens;
        for (uint256 i = 0; i < n; i++) {
            MockStockToken token =
                new MockStockToken(string.concat("Stock ", vm.toString(i)), string.concat("STK", vm.toString(i)));
            MockAggregator feed = new MockAggregator(8, int256(PRICE_8DEC));

            vm.prank(admin);
            registry.addAsset(address(token), address(feed), MAX_STALENESS);

            // Equal circulating supply per asset -> each targets ~1/n weight; the
            // exact split doesn't affect gas, only which side of the fee it lands on.
            token.mint(floatHolder, 1_000_000e18);
            token.mint(trader, 1_000_000e18);

            vm.prank(trader);
            token.approve(address(vault), type(uint256).max);

            tokens.push(token);
        }

        // mint() itself is never cooldown-gated (only redeem() is), so this loop
        // can run back-to-back from the same wallet.
        for (uint256 i = 0; i < n; i++) {
            vm.prank(trader);
            vault.mint(address(tokens[i]), DEPOSIT_PER_ASSET, 0);
        }
        vm.warp(block.timestamp + vault.mintRedeemCooldown() + 1);
    }

    /// @dev Measures one more mint() and one redeem() against an already-held
    /// asset, with the basket already at its worst-case size `n`.
    function _benchmarkMintRedeem(uint256 n) internal {
        vm.prank(trader);
        vault.mint(address(tokens[0]), DEPOSIT_PER_ASSET, 0);
        uint256 mintGas = vm.snapshotGasLastFrame("GasBenchmark", string.concat("mint_", vm.toString(n), "assets"));

        // That mint() just reset trader's own cooldown -> warp past it again
        // before redeem() (mint() is never cooldown-gated, only redeem() is).
        vm.warp(block.timestamp + vault.mintRedeemCooldown() + 1);

        vm.prank(trader);
        vault.redeem(address(tokens[0]), 1_000e18, 0);
        uint256 redeemGas = vm.snapshotGasLastFrame("GasBenchmark", string.concat("redeem_", vm.toString(n), "assets"));

        console2.log("---- N =", n, "----");
        console2.log("mint()   gas:", mintGas);
        console2.log("redeem() gas:", redeemGas);
    }

    function test_Gas_MintRedeem_2Assets() public {
        _setupWithNAssets(2);
        _benchmarkMintRedeem(2);
    }

    function test_Gas_MintRedeem_10Assets() public {
        _setupWithNAssets(10);
        _benchmarkMintRedeem(10);
    }

    function test_Gas_MintRedeem_25Assets() public {
        _setupWithNAssets(25);
        _benchmarkMintRedeem(25);
    }

    function test_Gas_MintRedeem_50Assets() public {
        _setupWithNAssets(50);
        _benchmarkMintRedeem(50);
    }

    function test_Gas_MintRedeem_100Assets() public {
        _setupWithNAssets(100);
        _benchmarkMintRedeem(100);
    }

    /// @notice Isolates which of the two O(N) loops actually dominates: lists 100
    /// assets (worst case for AssetRegistry.totalCirculatingValue()) but only fills
    /// 10 of them (best case for RBDXVault._nav()). If this lands close to the
    /// "100 listed, 100 held" numbers above rather than the "10 listed, 10 held"
    /// ones, totalCirculatingValue() — not _nav() — is the real cost driver, since
    /// it's pulled in via targetWeightOf() and always scans every LISTED asset
    /// regardless of how many the vault actually holds.
    function test_Gas_MintRedeem_100Listed_10Held() public {
        vm.startPrank(admin);
        rbdx = new RBDXToken(admin);
        registry = new AssetRegistry(admin);
        vault = new RBDXVault(rbdx, registry, devTreasury, admin);
        rbdx.setVault(address(vault));
        vm.stopPrank();

        delete tokens;
        for (uint256 i = 0; i < 100; i++) {
            MockStockToken token =
                new MockStockToken(string.concat("Stock ", vm.toString(i)), string.concat("STK", vm.toString(i)));
            MockAggregator feed = new MockAggregator(8, int256(PRICE_8DEC));

            vm.prank(admin);
            registry.addAsset(address(token), address(feed), MAX_STALENESS);

            token.mint(floatHolder, 1_000_000e18);
            token.mint(trader, 1_000_000e18);

            vm.prank(trader);
            token.approve(address(vault), type(uint256).max);

            tokens.push(token);
        }

        // Only fill the first 10 of the 100 listed assets -> heldTokens.length()==10
        // while assetList.length==100.
        for (uint256 i = 0; i < 10; i++) {
            vm.prank(trader);
            vault.mint(address(tokens[i]), DEPOSIT_PER_ASSET, 0);
        }
        vm.warp(block.timestamp + vault.mintRedeemCooldown() + 1);

        _benchmarkMintRedeem(999); // 999 = sentinel label for this mixed scenario
    }
}
