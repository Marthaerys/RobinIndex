// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {RBDXToken} from "./RBDXToken.sol";
import {AssetRegistry} from "./AssetRegistry.sol";

/// @title RBDXVault
/// @notice Holds the Stock Token basket backing $RBDX and implements single-asset
/// mint/redeem at a weight-deviation-adjusted price. See docs/DESIGN.md for the
/// full mechanism writeup; this contract implements §1-§5 of it.
///
/// SOLVENCY INVARIANT: rebates (bonus RBDX on mint / bonus token on redeem, for trades
/// that move the basket toward its target weight) are paid ONLY out of
/// `rebateReserve`, a USD-denominated ledger funded exclusively by (a) penalty fees
/// collected from trades that move AWAY from target weight, and (b) the
/// `rebateFundingBps` slice of the 0.1% dev fee that is deliberately left in the
/// vault (not sent to the treasury) to back it. A rebate can never exceed what
/// `rebateReserve` currently holds, so `Σ rebates paid ≤ Σ penalties collected + Σ
/// reserve-funding dev-fee` holds by construction — no transaction sequence can
/// extract more USD value than was deposited plus what other users' penalties
/// funded. This is enforced in `_applyFee`, not by reasoning about weights alone.
contract RBDXVault is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    bytes32 public constant PARAM_ADMIN_ROLE = keccak256("PARAM_ADMIN_ROLE");

    RBDXToken public immutable rbdx;
    AssetRegistry public immutable registry;

    address public devTreasury;

    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public devFeeBps = 10; // 0.1%, per the approved plan
    uint256 public rebateFundingBps = 0; // 0% of the dev fee stays in-vault; all of it goes to devTreasury (the reserve is funded entirely by penalties, see the solvency invariant doc comment above)
    uint256 public maxWeightFeeBps = 100; // ±1% cap on the weight-deviation fee/rebate
    uint256 public mintRedeemCooldown = 15 minutes; // see RBDXToken._update for why

    uint256 public constant GENESIS_PRICE = 1e18; // $1 / RBDX at bootstrap
    uint256 public constant MIN_FIRST_DEPOSIT_USD = 100e18; // inflation-attack guard
    uint256 public constant DEAD_SHARES = 1000; // wei of RBDX, locked forever on first mint
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice USD-1e18 accounting ledger, NOT a segregated pool of tokens — see
    /// the solvency invariant above. Only ever spent via `_applyFee`.
    uint256 public rebateReserve;

    mapping(address account => uint256 timestamp) public lastMintTimestamp;

    /// @dev Every token the vault currently holds a nonzero balance of, whether or
    /// not it's still listed in the registry — used for NAV so a delisted holding
    /// keeps counting until it's fully redeemed out (see AssetRegistry.delistAsset).
    EnumerableSet.AddressSet private heldTokens;

    event Minted(address indexed user, address indexed token, uint256 amountIn, uint256 rbdxOut, int256 weightFeeBps);
    event Redeemed(address indexed user, address indexed token, uint256 rbdxIn, uint256 amountOut, int256 weightFeeBps);
    event ParamsUpdated();

    error ZeroAddress();
    error ZeroAmount();
    error AssetNotListed(address token);
    error FirstDepositTooSmall(uint256 usdIn, uint256 minUsd);
    error SlippageExceeded(uint256 got, uint256 wanted);
    error CooldownActive(address account, uint256 cooldownEnds);
    error InsufficientVaultBalance(address token);
    error InvalidRedeemAmount();
    error FeeTooHigh();

    constructor(RBDXToken rbdx_, AssetRegistry registry_, address devTreasury_, address admin) {
        if (address(rbdx_) == address(0) || address(registry_) == address(0) || devTreasury_ == address(0)) {
            revert ZeroAddress();
        }
        rbdx = rbdx_;
        registry = registry_;
        devTreasury = devTreasury_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(PARAM_ADMIN_ROLE, admin);
    }

    // ── Core: mint ───────────────────────────────────────────────────────────

    /// @notice Deposit `amount` of `token` (must be listed) to mint RBDX.
    /// @param minRbdxOut Slippage guard — revert if computed output is less.
    function mint(address token, uint256 amount, uint256 minRbdxOut)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 rbdxOut)
    {
        if (!registry.isListed(token)) revert AssetNotListed(token);
        if (amount == 0) revert ZeroAmount();

        uint256 navPre = _nav();
        uint256 supplyPre = rbdx.totalSupply();
        uint256 balancePre = IERC20(token).balanceOf(address(this));
        uint256 price = registry.priceOf(token);

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        // SECURITY: price off what the vault actually received, not the caller-
        // declared `amount` — protects solvency if a fee-on-transfer/deflationary
        // token is ever listed (today's Stock Tokens are plain ERC-20s, so this is
        // a no-op in practice, but the vault shouldn't rely on that holding forever).
        uint256 received = IERC20(token).balanceOf(address(this)) - balancePre;
        if (received == 0) revert ZeroAmount();
        heldTokens.add(token);

        uint256 netAmount = _splitDevFee(token, received, price);
        uint256 usdIn = (netAmount * price) / 1e18;

        int256 weightFeeBps;
        if (supplyPre == 0) {
            // Bootstrap mint: no basket yet to be "away from target" relative to.
            //
            // SECURITY: `balancePre` (captured above, before this deposit's own
            // transferFrom) may be nonzero even though nothing has ever been
            // minted -- e.g. an attacker directly `transfer()`-ing tokens to the
            // vault address ahead of the real bootstrap mint, to try to inflate
            // price-per-share against the next depositor (the classic ERC-4626
            // donation/inflation attack). Any such pre-existing balance is priced
            // and minted to DEAD_ADDRESS alongside the fixed DEAD_SHARES floor, so
            // it backs total supply instead of just backing the depositor's own
            // claim -- the donor forfeits it, and the resulting index price still
            // starts at exactly GENESIS_PRICE regardless of any pre-funding.
            if (usdIn < MIN_FIRST_DEPOSIT_USD) revert FirstDepositTooSmall(usdIn, MIN_FIRST_DEPOSIT_USD);
            uint256 donatedValue = (balancePre * price) / 1e18;
            rbdxOut = usdIn - DEAD_SHARES;
            rbdx.mint(DEAD_ADDRESS, DEAD_SHARES + donatedValue);
        } else {
            uint256 indexPricePre = (navPre * 1e18) / supplyPre;
            uint256 currentWeight = navPre == 0 ? 0 : (balancePre * price / 1e18) * 1e18 / navPre;
            uint256 navAfter = navPre + usdIn;
            uint256 nextBalanceValue = ((balancePre + netAmount) * price) / 1e18;
            uint256 nextWeight = navAfter == 0 ? 0 : (nextBalanceValue * 1e18) / navAfter;
            uint256 targetWeight = registry.targetWeightOf(token);

            weightFeeBps = _weightFeeBps(currentWeight, targetWeight, nextWeight);
            uint256 effectiveUsd = _applyFee(usdIn, weightFeeBps, type(uint256).max);
            rbdxOut = (effectiveUsd * 1e18) / indexPricePre;
        }

        if (rbdxOut < minRbdxOut) revert SlippageExceeded(rbdxOut, minRbdxOut);

        lastMintTimestamp[msg.sender] = block.timestamp;
        rbdx.mint(msg.sender, rbdxOut);

        emit Minted(msg.sender, token, amount, rbdxOut, weightFeeBps);
    }

    // ── Core: redeem ─────────────────────────────────────────────────────────

    /// @notice Burn `rbdxAmount` of RBDX to redeem `token` (need not still be
    /// listed — a delisted holding can still be redeemed out).
    function redeem(address token, uint256 rbdxAmount, uint256 minAmountOut)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 amountOut)
    {
        if (rbdxAmount == 0) revert ZeroAmount();
        uint256 cooldownEnds = mintCooldownEnds(msg.sender);
        if (block.timestamp < cooldownEnds) revert CooldownActive(msg.sender, cooldownEnds);

        uint256 price = registry.priceOf(token);
        uint256 balancePre = IERC20(token).balanceOf(address(this));
        if (balancePre == 0) revert InsufficientVaultBalance(token);

        uint256 navPre = _nav();
        uint256 supplyPre = rbdx.totalSupply();
        if (supplyPre == 0 || rbdxAmount > supplyPre) revert InvalidRedeemAmount();
        uint256 indexPricePre = (navPre * 1e18) / supplyPre;

        uint256 usdAmount = (rbdxAmount * indexPricePre) / 1e18;
        uint256 notionalTokenOut = (usdAmount * 1e18) / price;
        if (notionalTokenOut > balancePre) revert InsufficientVaultBalance(token);

        // SECURITY: guard against dividing by a zero navPre (e.g. redeeming a
        // token that was never tracked via mint()/heldTokens, or a degenerate
        // near-fully-drained vault) — mirrors the same navPre==0 guard already
        // used in mint()'s non-bootstrap branch, instead of an unhandled panic.
        uint256 currentWeight = navPre == 0 ? 0 : (balancePre * price / 1e18) * 1e18 / navPre;
        uint256 navAfter = navPre - usdAmount;
        uint256 nextBalanceValue = ((balancePre - notionalTokenOut) * price) / 1e18;
        uint256 nextWeight = navAfter == 0 ? 0 : (nextBalanceValue * 1e18) / navAfter;
        uint256 targetWeight = registry.targetWeightOf(token);

        int256 weightFeeBps = _weightFeeBps(currentWeight, targetWeight, nextWeight);
        // Rebates on redeem are additionally capped so the vault never tries to pay
        // out more of `token` than it actually holds, regardless of reserve size.
        uint256 maxRebateUsd = ((balancePre - notionalTokenOut) * price) / 1e18;
        uint256 effectiveUsd = _applyFee(usdAmount, weightFeeBps, maxRebateUsd);
        uint256 rawTokenOut = (effectiveUsd * 1e18) / price;

        rbdx.burn(msg.sender, rbdxAmount);

        amountOut = _splitDevFee(token, rawTokenOut, price);
        if (amountOut < minAmountOut) revert SlippageExceeded(amountOut, minAmountOut);

        IERC20(token).safeTransfer(msg.sender, amountOut);
        if (IERC20(token).balanceOf(address(this)) == 0) heldTokens.remove(token);

        emit Redeemed(msg.sender, token, rbdxAmount, amountOut, weightFeeBps);
    }

    // ── Internal: fee mechanics ──────────────────────────────────────────────

    /// @dev The flat 0.1% dev fee, shared by both mint (fee taken from the deposit)
    /// and redeem (fee taken from the payout) — same split either way: part leaves
    /// to `devTreasury` immediately, part (`rebateFundingBps`) is deliberately left
    /// in the vault's balance (i.e. simply not transferred out) to physically back
    /// the `rebateReserve` credit it generates.
    function _splitDevFee(address token, uint256 grossAmount, uint256 price) internal returns (uint256 netAmount) {
        uint256 devFeeAmount = (grossAmount * devFeeBps) / BPS_DENOMINATOR;
        uint256 devFeeToTreasury = (devFeeAmount * (BPS_DENOMINATOR - rebateFundingBps)) / BPS_DENOMINATOR;
        uint256 devFeeToReserve = devFeeAmount - devFeeToTreasury;

        if (devFeeToTreasury > 0) IERC20(token).safeTransfer(devTreasury, devFeeToTreasury);
        if (devFeeToReserve > 0) rebateReserve += (devFeeToReserve * price) / 1e18;

        netAmount = grossAmount - devFeeAmount;
    }

    /// @dev THE anti-drain guard. Positive feeBps (penalty) always succeeds in full
    /// and *funds* the reserve. Negative feeBps (rebate) is clamped to whatever is
    /// smaller of the reserve balance and `maxRebateUsd` (a physical-balance limit
    /// the caller supplies for redeem; unlimited for mint, see solvency invariant
    /// doc comment above the contract).
    function _applyFee(uint256 usdAmount, int256 feeBps, uint256 maxRebateUsd) internal returns (uint256 effectiveUsd) {
        if (feeBps >= 0) {
            uint256 penaltyUsd = (usdAmount * uint256(feeBps)) / BPS_DENOMINATOR;
            rebateReserve += penaltyUsd;
            effectiveUsd = usdAmount - penaltyUsd;
        } else {
            uint256 wantedRebateUsd = (usdAmount * uint256(-feeBps)) / BPS_DENOMINATOR;
            uint256 actualRebateUsd = wantedRebateUsd;
            if (actualRebateUsd > rebateReserve) actualRebateUsd = rebateReserve;
            if (actualRebateUsd > maxRebateUsd) actualRebateUsd = maxRebateUsd;
            rebateReserve -= actualRebateUsd;
            effectiveUsd = usdAmount + actualRebateUsd;
        }
    }

    /// @dev Default linear curve: sign = whether the trade moves the token's
    /// weight closer to (rebate) or farther from (penalty) target; magnitude scales
    /// linearly with the post-trade deviation relative to the target weight itself,
    /// capped at `maxWeightFeeBps`. Deliberately simple and tunable — see
    /// docs/DESIGN.md for the rationale and for what a future curve upgrade would
    /// touch (this is the one function most likely to be revisited pre-audit).
    function _weightFeeBps(uint256 currentWeight, uint256 targetWeight, uint256 nextWeight)
        internal
        view
        returns (int256 feeBps)
    {
        uint256 devBefore = currentWeight > targetWeight ? currentWeight - targetWeight : targetWeight - currentWeight;
        uint256 devAfter = nextWeight > targetWeight ? nextWeight - targetWeight : targetWeight - nextWeight;

        uint256 referenceWeight = targetWeight > 0 ? targetWeight : 1e17; // 10% fallback (e.g. delisted asset)
        uint256 magnitudeBps = (devAfter * maxWeightFeeBps) / referenceWeight;
        if (magnitudeBps > maxWeightFeeBps) magnitudeBps = maxWeightFeeBps;

        // Exact ties (e.g. topping up the sole asset in a single-asset vault,
        // whose weight is pinned at 100% either side of the trade) are neutral —
        // the trade didn't change relative alignment, so it earns neither a
        // rebate nor a penalty. Only a strict improvement/worsening does.
        if (devAfter == devBefore) {
            feeBps = 0;
        } else {
            feeBps = devAfter < devBefore ? -int256(magnitudeBps) : int256(magnitudeBps);
        }
    }

    /// @dev SECURITY: values each held token through an external self-call
    /// (`this.tokenValue`) wrapped in try/catch, so that ONE token whose
    /// `balanceOf()` reverts (blacklist, pause, a buggy/self-destructed token) or
    /// whose price feed reverts (stale/invalid oracle) does not brick NAV -- and
    /// therefore mint/redeem -- for every OTHER asset, forever, with no admin
    /// recovery path. A skipped token's value is simply excluded from NAV until it
    /// (or an admin re-listing it with a fixed feed) recovers; minting/redeeming
    /// THAT SPECIFIC token is unaffected by this and still reverts on its own
    /// (mint/redeem call `registry.priceOf(token)` directly), so this only
    /// protects cross-asset availability, not the broken asset's own correctness.
    function _nav() internal view returns (uint256 total) {
        uint256 len = heldTokens.length();
        for (uint256 i = 0; i < len; i++) {
            address t = heldTokens.at(i);
            try this.tokenValue(t) returns (uint256 value) {
                total += value;
            } catch {
                // Skip -- see dev-comment above.
            }
        }
    }

    /// @notice USD-1e18 value of the vault's current balance of `token`. Marked
    /// `external` (rather than merely `internal`/`private`) specifically so
    /// `_nav()` can call it via `this.tokenValue(t)` and try/catch a per-asset
    /// failure -- not intended to be called directly for accounting; use `nav()`.
    function tokenValue(address token) external view returns (uint256) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal == 0) return 0;
        return (bal * registry.priceOf(token)) / 1e18;
    }

    // ── Views ───────────────────────────────────────────────────────────────

    function nav() external view returns (uint256) {
        return _nav();
    }

    function indexPrice() external view returns (uint256) {
        uint256 supply = rbdx.totalSupply();
        if (supply == 0) return GENESIS_PRICE;
        return (_nav() * 1e18) / supply;
    }

    /// @notice Called by RBDXToken._update on every transfer/burn to gate a
    /// recently-minted wallet. Also used internally by `redeem`.
    function mintCooldownEnds(address account) public view returns (uint256) {
        uint256 last = lastMintTimestamp[account];
        return last == 0 ? 0 : last + mintRedeemCooldown;
    }

    function heldTokensList() external view returns (address[] memory) {
        return heldTokens.values();
    }

    // ── Admin ───────────────────────────────────────────────────────────────

    function setDevTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        devTreasury = newTreasury;
        emit ParamsUpdated();
    }

    /// @notice Capped at 1% so this can never be (mis)configured into a de facto
    /// rug via the fee path.
    function setDevFeeBps(uint256 newBps) external onlyRole(PARAM_ADMIN_ROLE) {
        if (newBps > 100) revert FeeTooHigh();
        devFeeBps = newBps;
        emit ParamsUpdated();
    }

    function setRebateFundingBps(uint256 newBps) external onlyRole(PARAM_ADMIN_ROLE) {
        if (newBps > BPS_DENOMINATOR) revert FeeTooHigh();
        rebateFundingBps = newBps;
        emit ParamsUpdated();
    }

    /// @notice Capped at 5% as a sanity ceiling on the ±band itself.
    function setMaxWeightFeeBps(uint256 newBps) external onlyRole(PARAM_ADMIN_ROLE) {
        if (newBps > 500) revert FeeTooHigh();
        maxWeightFeeBps = newBps;
        emit ParamsUpdated();
    }

    function setMintRedeemCooldown(uint256 newCooldown) external onlyRole(PARAM_ADMIN_ROLE) {
        if (newCooldown > 1 days) revert FeeTooHigh();
        mintRedeemCooldown = newCooldown;
        emit ParamsUpdated();
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
