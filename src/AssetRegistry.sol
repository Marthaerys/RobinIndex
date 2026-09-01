// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {OracleLib} from "./libraries/OracleLib.sol";

/// @title AssetRegistry
/// @notice Governance-controlled list of Stock Tokens the vault accepts, their
/// Chainlink feeds, and their (off-chain-sourced, admin-updated) shares outstanding
/// — the one input Robinhood Chain does NOT expose on-chain (only price-per-token
/// is available, see docs.robinhood.com/chain/oracles-and-price-feeds).
///
/// `DEFAULT_ADMIN_ROLE` (intended: a Gnosis Safe behind a timelock, never an EOA)
/// controls listing/delisting assets. `ASSET_MANAGER_ROLE` (intended: same Safe, or
/// a narrower operational key/keeper) may only *update* sharesOutstanding for an
/// already-listed asset, and only within `maxUpdateChangeBps` of the previous value
/// per call — a compromised ASSET_MANAGER key can nudge weights, not instantly
/// reweight the whole index in one transaction.
contract AssetRegistry is AccessControl {
    using OracleLib for AggregatorV3Interface;

    bytes32 public constant ASSET_MANAGER_ROLE = keccak256("ASSET_MANAGER_ROLE");

    struct Asset {
        AggregatorV3Interface priceFeed;
        uint256 sharesOutstanding; // 18 decimals, matches Stock Token decimals
        uint256 maxOracleStaleness; // seconds; see OracleLib.getPrice1e18
        bool listed;
    }

    mapping(address token => Asset) public assets;
    address[] public assetList;

    /// @notice Bounds how much a single updateSharesOutstanding() call may move an
    /// asset's sharesOutstanding, in bps of the previous value. Default 10% (1000 bps).
    uint256 public maxUpdateChangeBps = 1000;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    event AssetListed(address indexed token, address indexed priceFeed, uint256 initialSharesOutstanding);
    event AssetDelisted(address indexed token);
    event SharesOutstandingUpdated(address indexed token, uint256 previousShares, uint256 newShares);
    event MaxUpdateChangeBpsUpdated(uint256 previousBps, uint256 newBps);

    error AlreadyListed(address token);
    error NotListed(address token);
    error ZeroAddress();
    error ZeroShares();
    error ChangeTooLarge(uint256 previousShares, uint256 requestedShares, uint256 maxChangeBps);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ASSET_MANAGER_ROLE, admin);
    }

    // ── Governance: list management ────────────────────────────────────────

    function addAsset(address token, address priceFeed, uint256 initialSharesOutstanding, uint256 maxOracleStaleness)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (token == address(0) || priceFeed == address(0)) revert ZeroAddress();
        if (assets[token].listed) revert AlreadyListed(token);
        if (initialSharesOutstanding == 0) revert ZeroShares();

        assets[token] = Asset({
            priceFeed: AggregatorV3Interface(priceFeed),
            sharesOutstanding: initialSharesOutstanding,
            maxOracleStaleness: maxOracleStaleness,
            listed: true
        });
        assetList.push(token);

        emit AssetListed(token, priceFeed, initialSharesOutstanding);
    }

    /// @notice Delists an asset from *target-weight* accounting going forward (its
    /// targetWeight becomes 0, so mints of it are always "away from target" and
    /// redemptions of it are always "toward target" — steering the vault to run it
    /// down naturally). Does NOT freeze a vault balance the vault may still hold;
    /// that unwind happens through the normal fee-incentivized redemption path.
    function delistAsset(address token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (!assets[token].listed) revert NotListed(token);
        assets[token].listed = false;

        uint256 len = assetList.length;
        for (uint256 i = 0; i < len; i++) {
            if (assetList[i] == token) {
                assetList[i] = assetList[len - 1];
                assetList.pop();
                break;
            }
        }

        emit AssetDelisted(token);
    }

    function setMaxUpdateChangeBps(uint256 newBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit MaxUpdateChangeBpsUpdated(maxUpdateChangeBps, newBps);
        maxUpdateChangeBps = newBps;
    }

    // ── Asset manager: periodic shares-outstanding refresh ─────────────────

    function updateSharesOutstanding(address token, uint256 newShares) external onlyRole(ASSET_MANAGER_ROLE) {
        Asset storage a = assets[token];
        if (!a.listed) revert NotListed(token);
        if (newShares == 0) revert ZeroShares();

        uint256 previous = a.sharesOutstanding;
        uint256 diff = newShares > previous ? newShares - previous : previous - newShares;
        uint256 maxDiff = (previous * maxUpdateChangeBps) / BPS_DENOMINATOR;
        if (diff > maxDiff) revert ChangeTooLarge(previous, newShares, maxUpdateChangeBps);

        a.sharesOutstanding = newShares;
        emit SharesOutstandingUpdated(token, previous, newShares);
    }

    // ── Views used by the vault ─────────────────────────────────────────────

    function getAssetList() external view returns (address[] memory) {
        return assetList;
    }

    function isListed(address token) external view returns (bool) {
        return assets[token].listed;
    }

    /// @notice Price for ANY asset that was ever added, listed or not — the vault
    /// needs this to value a delisted asset it may still be holding/unwinding.
    /// Reverts only if the token was never added at all.
    function priceOf(address token) public view returns (uint256 price) {
        Asset storage a = assets[token];
        if (address(a.priceFeed) == address(0)) revert NotListed(token);
        price = a.priceFeed.getPrice1e18(a.maxOracleStaleness);
    }

    /// @return marketCap The listed asset's market cap (sharesOutstanding * price),
    /// in 18-decimal USD. Reverts on stale/invalid oracle data. Only meaningful (and
    /// only callable) for currently-listed assets — see `priceOf` for delisted ones.
    function marketCapOf(address token) public view returns (uint256 marketCap) {
        Asset storage a = assets[token];
        if (!a.listed) revert NotListed(token);
        marketCap = (a.sharesOutstanding * priceOf(token)) / 1e18;
    }

    /// @notice Sum of market cap across every listed asset — the denominator of
    /// every targetWeight_i = marketCapOf(i) / totalMarketCap().
    function totalMarketCap() public view returns (uint256 total) {
        uint256 len = assetList.length;
        for (uint256 i = 0; i < len; i++) {
            total += marketCapOf(assetList[i]);
        }
    }

    /// @return weight1e18 targetWeight_i scaled to 1e18 (1e18 == 100%). Returns 0
    /// (rather than reverting) for a delisted or never-listed token, so the vault
    /// can still price a "move away from target" redemption of a delisted holding.
    function targetWeightOf(address token) external view returns (uint256 weight1e18) {
        if (!assets[token].listed) return 0;
        uint256 total = totalMarketCap();
        if (total == 0) return 0;
        weight1e18 = (marketCapOf(token) * 1e18) / total;
    }
}
