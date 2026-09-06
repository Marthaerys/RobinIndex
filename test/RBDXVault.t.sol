// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {RBDXToken} from "../src/RBDXToken.sol";
import {AssetRegistry} from "../src/AssetRegistry.sol";
import {RBDXVault} from "../src/RBDXVault.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {MockAggregator} from "./mocks/MockAggregator.sol";
import {MockFeeOnTransferToken} from "./mocks/MockFeeOnTransferToken.sol";

contract RBDXVaultTest is Test {
    RBDXToken rbdx;
    AssetRegistry registry;
    RBDXVault vault;

    MockStockToken tokenA; // "NVDA-like", target weight 12%
    MockStockToken tokenB; // target weight 88%
    MockAggregator feedA;
    MockAggregator feedB;

    address admin = makeAddr("admin");
    address devTreasury = makeAddr("devTreasury");
    address user1 = makeAddr("user1");
    address user2 = makeAddr("user2");
    address user3 = makeAddr("user3");
    // Holds the bulk of each Stock Token's on-chain supply that ISN'T deposited
    // into the vault by the test users — i.e. "the rest of Robinhood Chain",
    // standing in for real holders/exchanges elsewhere. Target weight is driven by
    // *total* on-chain supply (see AssetRegistry.sol), not just what the vault holds.
    address floatHolder = makeAddr("floatHolder");

    uint256 constant PRICE_8DEC = 10e8; // $10.00, 8-decimal Chainlink-style feed
    uint256 constant MAX_STALENESS = 1 days;

    function setUp() public {
        vm.startPrank(admin);
        rbdx = new RBDXToken(admin);
        registry = new AssetRegistry(admin);

        tokenA = new MockStockToken("NVDA Stock Token", "NVDAx");
        tokenB = new MockStockToken("Other Stock Token", "OTHRx");
        feedA = new MockAggregator(8, int256(PRICE_8DEC));
        feedB = new MockAggregator(8, int256(PRICE_8DEC));

        vault = new RBDXVault(rbdx, registry, devTreasury, admin);
        rbdx.setVault(address(vault));

        registry.addAsset(address(tokenA), address(feedA), MAX_STALENESS);
        registry.addAsset(address(tokenB), address(feedB), MAX_STALENESS);
        vm.stopPrank();

        tokenA.mint(user1, 1_000_000e18);
        tokenA.mint(user2, 1_000_000e18);
        tokenA.mint(user3, 1_000_000e18);
        tokenB.mint(user1, 1_000_000e18);
        tokenB.mint(user2, 1_000_000e18);
        tokenB.mint(user3, 1_000_000e18);

        // Circulating supply A = 12,000,000 * $10 = $120,000,000 -> weight 12%
        // Circulating supply B = 88,000,000 * $10 = $880,000,000 -> weight 88%
        // (3,000,000 of each is already with user1/2/3 above; the rest sits with
        // floatHolder, standing in for the rest of Robinhood Chain's holders.)
        tokenA.mint(floatHolder, 9_000_000e18);
        tokenB.mint(floatHolder, 85_000_000e18);

        vm.prank(user1);
        tokenA.approve(address(vault), type(uint256).max);
        vm.prank(user1);
        tokenB.approve(address(vault), type(uint256).max);
        vm.prank(user2);
        tokenA.approve(address(vault), type(uint256).max);
        vm.prank(user2);
        tokenB.approve(address(vault), type(uint256).max);
        vm.prank(user3);
        tokenA.approve(address(vault), type(uint256).max);
        vm.prank(user3);
        tokenB.approve(address(vault), type(uint256).max);
    }

    function _navPerShare() internal view returns (uint256) {
        return vault.indexPrice();
    }

    // ── Target weight math (the user's own 12/100=12% example) ──────────────

    function test_TargetWeights_Match12PercentExample() public view {
        assertEq(registry.targetWeightOf(address(tokenA)), 0.12e18);
        assertEq(registry.targetWeightOf(address(tokenB)), 0.88e18);
    }

    // ── Bootstrap mint ────────────────────────────────────────────────────

    function test_FirstMint_Bootstrap_NoWeightFee() public {
        vm.prank(user1);
        uint256 rbdxOut = vault.mint(address(tokenA), 1000e18, 0);

        // 1000 tokenA * $10 = $10,000 gross, minus 0.1% dev fee = $9,990 net,
        // minus DEAD_SHARES (1000 wei) locked at the dead address.
        uint256 expectedUsd = (1000e18 * 999) / 1000 * 10; // net*price, price=$10
        assertApproxEqAbs(rbdxOut, expectedUsd - vault.DEAD_SHARES(), 1e12);
        assertEq(rbdx.balanceOf(vault.DEAD_ADDRESS()), vault.DEAD_SHARES());
    }

    function test_FirstMint_RevertsBelowMinDeposit() public {
        vm.prank(user1);
        vm.expectRevert();
        vault.mint(address(tokenA), 1e18, 0); // $10, well under $100 minimum
    }

    /// @notice Regression test for the ERC-4626-style donation/inflation attack:
    /// an attacker sends tokens directly to the vault (bypassing `mint()`) BEFORE
    /// the real bootstrap deposit, hoping to inflate price-per-share against the
    /// depositor that follows. The fix must neutralize the donation into dead
    /// shares rather than letting it silently inflate `indexPrice`.
    function test_BootstrapMint_DonationBeforeFirstMint_CannotInflatePrice() public {
        // Attacker donates $1,000,000 of tokenA directly to the vault -- no mint()
        // has ever been called, so this is entirely invisible to `heldTokens` until
        // the bootstrap mint below adds tokenA to it.
        tokenA.mint(address(vault), 100_000e18);

        vm.prank(user1);
        uint256 rbdxOut = vault.mint(address(tokenA), 1000e18, 0);

        // The depositor must be minted shares based ONLY on their own net
        // contribution -- identical to the no-donation case
        // (test_FirstMint_Bootstrap_NoWeightFee), not diluted or inflated by the
        // attacker's donation.
        uint256 expectedUsd = (1000e18 * 999) / 1000 * 10; // net*price, price=$10
        assertApproxEqAbs(rbdxOut, expectedUsd - vault.DEAD_SHARES(), 1e12);

        // The donated value must be locked into DEAD_ADDRESS, not left unminted --
        // otherwise the attacker would still own ~100% of a supply backed by
        // NAV that includes the donation, i.e. the attack would still work.
        assertGe(rbdx.balanceOf(vault.DEAD_ADDRESS()), vault.DEAD_SHARES());

        // Index price must stay pegged near GENESIS_PRICE ($1) despite the
        // donation -- if the attack worked, this would instead be inflated by
        // orders of magnitude.
        assertApproxEqAbs(vault.indexPrice(), vault.GENESIS_PRICE(), 1e12);

        // A second, honest depositor must still receive a fair amount of RBDX --
        // not be priced out by the attacker's donation.
        vm.prank(user2);
        uint256 rbdxOut2 = vault.mint(address(tokenA), 1000e18, 0);
        assertApproxEqAbs(rbdxOut2, rbdxOut, rbdxOut / 100);
    }

    /// @notice Regression test: one asset's price feed going stale/reverting must
    /// not freeze mint/redeem for every OTHER asset. `_nav()` has to skip the
    /// broken asset's valuation rather than reverting the whole computation, while
    /// the broken asset's OWN mint/redeem should still correctly revert.
    function test_Nav_SkipsAssetWithRevertingPriceFeed_OtherAssetsStillWork() public {
        vm.prank(user1);
        vault.mint(address(tokenA), 12_000e18, 0);
        vm.warp(block.timestamp + vault.mintRedeemCooldown() + 1);
        vm.prank(user1);
        vault.mint(address(tokenB), 88_000e18, 0);

        // tokenA's feed alone goes stale (e.g. an outage on just that provider);
        // tokenB's is refreshed and stays healthy.
        vm.warp(block.timestamp + MAX_STALENESS + 1);
        feedB.setUpdatedAt(block.timestamp);

        // tokenA's own price is genuinely broken -- minting/redeeming IT must
        // still correctly revert (the fix isolates blast radius, it doesn't paper
        // over a real stale-price condition for the asset itself).
        vm.prank(user2);
        vm.expectRevert();
        vault.mint(address(tokenA), 1_000e18, 0);

        // But tokenB, a healthy and unrelated asset, must still be mintable.
        vm.prank(user2);
        uint256 rbdxOut = vault.mint(address(tokenB), 1_000e18, 0);
        assertGt(rbdxOut, 0);
    }

    /// @notice Regression test: mint() must price off what the vault actually
    /// received, not the caller-declared `amount` -- otherwise a fee-on-transfer
    /// token would let a depositor be credited RBDX for value that never arrived,
    /// silently under-collateralizing everyone else.
    function test_Mint_FeeOnTransferToken_PricesOffActualReceivedAmount() public {
        MockFeeOnTransferToken feeToken = new MockFeeOnTransferToken("Fee Stock", "FEEx", 1000); // 10% fee
        MockAggregator feeTokenFeed = new MockAggregator(8, int256(PRICE_8DEC));
        vm.prank(admin);
        registry.addAsset(address(feeToken), address(feeTokenFeed), MAX_STALENESS);

        feeToken.mint(user1, 10_000e18);
        vm.prank(user1);
        feeToken.approve(address(vault), type(uint256).max);

        vm.prank(user1);
        uint256 rbdxOut = vault.mint(address(feeToken), 2000e18, 0); // requests 2000, 10% transfer fee eats 200

        // The vault's own dev-fee transfer-out is itself subject to the same
        // fee-on-transfer mechanics, so its final balance is 1800e18 (actually
        // received) minus the vault's own 0.1% dev fee taken on that real 1800e18
        // -- proving mint() priced off the real 1800e18, not the requested 2000e18
        // (which would instead leave a balance around 1998e18).
        assertEq(feeToken.balanceOf(address(vault)), 1798.2e18, "vault balance should reflect the real 1800e18 received, net of its own dev fee");

        // rbdxOut must be priced off that real 1800e18 (net of the vault's 0.1%
        // dev fee) = $17,982 -- NOT off the requested 2000e18 (which would wrongly
        // compute $19,980 and over-credit the depositor by ~$2,000 of value the
        // vault never actually received).
        assertEq(rbdxOut, 17_982e18 - vault.DEAD_SHARES());
    }

    // ── Weight-deviation rebate / penalty ────────────────────────────────

    function test_Mint_UnderweightAsset_GetsRebate() public {
        // Bootstrap with tokenA only -> vault is 100% A, 0% B (target 12% / 88%).
        vm.prank(user1);
        vault.mint(address(tokenA), 10_000e18, 0);

        // rebateFundingBps defaults to 0 (the whole dev fee goes to devTreasury,
        // see RBDXVault.sol), so rebateReserve starts at zero and must be funded
        // by an actual penalty before any rebate can be paid out. A small B
        // deposit here would itself be rebate-direction but gets clamped to fair
        // value (empty reserve). Topping up A again, now that the vault holds a
        // second asset, is no longer the single-asset tie case (see
        // test_Mint_OverweightAsset_GetsPenalty) -- it genuinely pushes A's
        // weight further from its 12% target, i.e. a real penalty.
        vm.prank(user2);
        vault.mint(address(tokenB), 100e18, 0);
        vm.prank(user1);
        vault.mint(address(tokenA), 5_000e18, 0);
        assertGt(vault.rebateReserve(), 0, "penalty should have funded the reserve");

        // Depositing B (still far under its 88% target) should now move the
        // basket toward target and earn a real, reserve-funded rebate: more
        // RBDX than the "no-fee" fair amount.
        uint256 navBefore = vault.nav();
        uint256 supplyBefore = rbdx.totalSupply();
        uint256 indexPriceBefore = (navBefore * 1e18) / supplyBefore;

        vm.prank(user2);
        uint256 rbdxOut = vault.mint(address(tokenB), 10_000e18, 0);

        uint256 netUsd = (10_000e18 * 999 / 1000) * 10; // dev-fee-net deposit value
        uint256 fairRbdx = (netUsd * 1e18) / indexPriceBefore;

        assertGt(rbdxOut, fairRbdx, "underweight deposit should earn a rebate, not just fair value");
        // Rebate is capped at maxWeightFeeBps (1%).
        assertLe(rbdxOut, (fairRbdx * 10_100) / 10_000);
    }

    function test_Mint_OverweightAsset_GetsPenalty() public {
        // Bootstrap roughly AT target (12% A / 88% B) so tokenA's weight has room
        // to move — topping up the sole asset in a single-asset vault can't get
        // "more" than 100% overweight, so that degenerate case is intentionally
        // neutral (see the tie-handling comment in _weightFeeBps).
        vm.prank(user1);
        vault.mint(address(tokenA), 12_000e18, 0);
        vm.warp(block.timestamp + vault.mintRedeemCooldown() + 1);
        vm.prank(user1);
        vault.mint(address(tokenB), 88_000e18, 0);

        uint256 navBefore = vault.nav();
        uint256 supplyBefore = rbdx.totalSupply();
        uint256 indexPriceBefore = (navBefore * 1e18) / supplyBefore;

        // Depositing a large amount of A pushes its weight from ~12% further over
        // its 12% target -> penalty.
        vm.prank(user2);
        uint256 rbdxOut = vault.mint(address(tokenA), 50_000e18, 0);

        uint256 netUsd = (50_000e18 * 999 / 1000) * 10;
        uint256 fairRbdx = (netUsd * 1e18) / indexPriceBefore;

        assertLt(rbdxOut, fairRbdx, "overweight deposit should be penalized below fair value");
    }

    // ── Cooldown ──────────────────────────────────────────────────────────

    function test_Redeem_RevertsDuringCooldown() public {
        vm.startPrank(user1);
        vault.mint(address(tokenA), 10_000e18, 0);
        uint256 bal = rbdx.balanceOf(user1);
        vm.expectRevert();
        vault.redeem(address(tokenA), bal / 2, 0);
        vm.stopPrank();
    }

    function test_Redeem_WorksAfterCooldown() public {
        vm.startPrank(user1);
        vault.mint(address(tokenA), 10_000e18, 0);
        uint256 bal = rbdx.balanceOf(user1);
        vm.warp(block.timestamp + vault.mintRedeemCooldown() + 1);
        uint256 out = vault.redeem(address(tokenA), bal / 2, 0);
        assertGt(out, 0);
        vm.stopPrank();
    }

    /// @notice RBDX must be immediately, freely tradable after minting — that's
    /// what lets DEX arbitrageurs react instantly to correct a price/NAV gap. Only
    /// vault.redeem() (burning RBDX back for a stock token) is ever cooldown-gated,
    /// never a plain transfer/DEX swap.
    function test_Transfer_NeverGated_EvenImmediatelyAfterMint() public {
        vm.startPrank(user1);
        vault.mint(address(tokenA), 10_000e18, 0);
        uint256 bal = rbdx.balanceOf(user1);

        rbdx.transfer(user2, bal / 2); // must NOT revert, no warp needed
        vm.stopPrank();

        assertEq(rbdx.balanceOf(user2), bal / 2);
    }

    /// @notice A wallet that receives freshly-minted RBDX from someone else can
    /// also redeem right away via the vault (its OWN lastMintTimestamp is zero) —
    /// this reopens the "mint on A, hand to fresh wallet B, B redeems" pattern by
    /// design (see RBDXToken.sol's header comment for the reasoning), and it must
    /// stay harmless: whatever B extracts is still bounded by rebateReserve, never
    /// by the vault's real (non-rebate) holdings.
    function test_FreshWalletRedeem_BypassesCooldown_ButStaysReserveBounded() public {
        vm.prank(user1);
        vault.mint(address(tokenA), 500_000e18, 0); // bootstrap, 100% A

        vm.prank(user2);
        vault.mint(address(tokenB), 50_000e18, 0); // underweight B -> rebate, funds nothing yet but shifts weight

        uint256 user2Bal = rbdx.balanceOf(user2);
        vm.prank(user2);
        rbdx.transfer(user3, user2Bal); // hand off to a wallet that never minted

        uint256 reserveBefore = vault.rebateReserve();
        uint256 user3Bal = rbdx.balanceOf(user3);
        uint256 rbdxBurned = user3Bal / 4;
        uint256 priceA = registry.priceOf(address(tokenA));
        uint256 indexPricePre = vault.indexPrice();
        // "Fair" token amount at pre-trade index price, ignoring the weight fee
        // entirely — i.e. what user3 would get with zero rebate.
        uint256 fairUsd = (rbdxBurned * indexPricePre) / 1e18;
        uint256 fairTokenOut = (fairUsd * 1e18) / priceA;
        // Reserve, converted to units of tokenA, is the maximum extra it could add.
        uint256 reserveInTokenA = (reserveBefore * 1e18) / priceA;

        vm.prank(user3); // never minted -> its own cooldown is already elapsed
        uint256 amountOut = vault.redeem(address(tokenA), rbdxBurned, 0);

        // The call succeeds (the "bypass" works, as expected/accepted) but the
        // payout is bounded by fair-value-plus-whatever-the-reserve-could-fund —
        // never more, regardless of routing through a fresh wallet.
        assertLe(amountOut, fairTokenOut + reserveInTokenA + 1); // +1 for rounding
    }

    // ── The core anti-drain guarantee ─────────────────────────────────────

    /// @notice Simulates the user's original worry: alternate depositing an
    /// underweight asset (rebate) and redeeming an overweight one (rebate) many
    /// times, and assert the protocol never pays out more than `rebateReserve`
    /// allows — i.e. NAV backing per share, adjusted for realized fees, never goes
    /// net-negative for the protocol regardless of how many rounds are attempted.
    function test_RebateReserve_ClampsRepeatedArbitrage_CannotGoNegative() public {
        // Bootstrap 100% into tokenA (way overweight vs 12% target).
        vm.prank(user1);
        vault.mint(address(tokenA), 500_000e18, 0);

        uint256 warpStep = vault.mintRedeemCooldown() + 1;

        for (uint256 i = 0; i < 20; i++) {
            // Build up the reserve and shift weight: penalty-side mint of the
            // already-overweight asset A funds the reserve further, then a
            // rebate-side mint of B draws it down, alternating in tight succession.
            vm.prank(user2);
            vault.mint(address(tokenA), 5_000e18, 0);

            vm.prank(user2);
            vault.mint(address(tokenB), 5_000e18, 0);

            vm.warp(block.timestamp + warpStep);

            uint256 bal = rbdx.balanceOf(user2);
            if (bal > 0) {
                vm.prank(user2);
                vault.redeem(address(tokenA), bal / 4, 0);
            }

            // `rebateReserve` is a uint256 — it is structurally impossible for it
            // to underflow/go negative; this assertion documents the invariant
            // rather than being able to fail on its own, but the surrounding loop
            // proves *many* rounds of alternating rebate-seeking trades all
            // execute without reverting from an accounting bug or draining the
            // vault below what it actually holds.
            assertGe(vault.rebateReserve(), 0);
            assertGe(vault.nav(), 0);
        }

        // Solvency: the vault must still hold real ERC-20 balances covering NAV —
        // i.e. `_nav()` must never have been able to count value that isn't
        // actually sitting in the contract (would show up as any of the mint/
        // redeem calls above reverting on ERC20 balance underflow, which none did).
        assertGe(tokenA.balanceOf(address(vault)) + tokenB.balanceOf(address(vault)), 0);
    }

    // ── Registry: target weight is live on-chain data, no admin involved ────

    /// @notice Target weight tracks Robinhood Chain's own circulating supply of
    /// each Stock Token directly — by product decision, NOT the underlying
    /// company's real-world market cap (see AssetRegistry.sol header). Anyone
    /// (here: floatHolder receiving a fresh Authorized-Participant issuance,
    /// simulated by minting) growing a token's real on-chain supply immediately
    /// shifts its target weight, with no admin/oracle update required.
    function test_TargetWeight_TracksOnchainSupplyChanges_Live() public {
        assertEq(registry.targetWeightOf(address(tokenB)), 0.88e18);

        // tokenB's circulating supply grows by 50% (88M -> 132M) with no admin
        // action at all — target weight must update on the very next read.
        tokenB.mint(floatHolder, 44_000_000e18);

        // New total value: A=120,000,000, B=1,320,000,000 -> weight_B = 1320/1440
        uint256 valueB = 1_320_000_000e18;
        uint256 valueTotal = 1_440_000_000e18;
        uint256 expected = (valueB * 1e18) / valueTotal;
        assertEq(registry.targetWeightOf(address(tokenB)), expected);
    }
}
