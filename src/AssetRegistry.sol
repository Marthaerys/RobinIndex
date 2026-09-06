// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AggregatorV3Interface} from "./interfaces/AggregatorV3Interface.sol";
import {OracleLib} from "./libraries/OracleLib.sol";

/// @title AssetRegistry
/// @notice Governance-controlled list of Stock Tokens the vault accepts, and their
/// Chainlink feeds.
///
/// IMPORTANT — what "target weight" means here, by deliberate product decision:
/// this is NOT weighted by each underlying company's real-world market cap.
/// Robinhood Chain doesn't expose real shares-outstanding on-chain (see
/// docs/DESIGN.md), and rather than sourcing that off-chain, RBDX instead tracks
/// each Stock Token's own on-chain `totalSupply()` — its "circulating value" =
/// totalSupply * Chainlink price. Minting a Stock Token isn't a free permissionless
/// action (only Robinhood's Authorized Participant can do it, against real
/// underlying value), so circulating value is an honest signal of how much real
/// capital is actually deployed into that tokenized asset on Robinhood Chain — an
/// AUM/adoption-weighted index of the *chain's* tokenized-equity ecosystem, not a
/// mirror of a real-world index. That's why something like a tokenized SpaceX can
/// carry real weight here despite not appearing in something like the S&P 500 at
/// all. A useful side effect: target weight is now fully computed on-chain, live,
/// every block, from data nobody has to curate — the only governance surface left
/// is which assets are *listed* in the first place (addAsset/delistAsset below).
contract AssetRegistry is AccessControl {
    using OracleLib for AggregatorV3Interface;

    struct Asset {
        AggregatorV3Interface priceFeed;
        uint256 maxOracleStaleness; // seconds; see OracleLib.getPrice1e18
        bool listed;
    }

    mapping(address token => Asset) public assets;
    address[] public assetList;

    event AssetListed(address indexed token, address indexed priceFeed);
    event AssetDelisted(address indexed token);

    error AlreadyListed(address token);
    error NotListed(address token);
    error ZeroAddress();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ── Governance: list management ────────────────────────────────────────

    function addAsset(address token, address priceFeed, uint256 maxOracleStaleness)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (token == address(0) || priceFeed == address(0)) revert ZeroAddress();
        if (assets[token].listed) revert AlreadyListed(token);

        assets[token] =
            Asset({priceFeed: AggregatorV3Interface(priceFeed), maxOracleStaleness: maxOracleStaleness, listed: true});
        assetList.push(token);

        emit AssetListed(token, priceFeed);
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

    /// @return value The token's on-chain circulating value (totalSupply * price,
    /// 18-decimal USD) — see the contract header for why this drives target
    /// weight instead of real-world market cap. Reverts on stale/invalid oracle
    /// data, or for a delisted/never-listed token.
    function circulatingValueOf(address token) public view returns (uint256 value) {
        Asset storage a = assets[token];
        if (!a.listed) revert NotListed(token);
        value = (IERC20(token).totalSupply() * priceOf(token)) / 1e18;
    }

    /// @notice Sum of circulating value across every listed asset — the
    /// denominator of every targetWeight_i = circulatingValueOf(i) / totalCirculatingValue().
    /// @dev SECURITY: values each asset through an external self-call
    /// (`this.circulatingValueOf`) wrapped in try/catch, mirroring
    /// RBDXVault._nav(). Without this, ONE listed asset's reverting price feed
    /// (stale/invalid oracle) or reverting totalSupply() would block weight
    /// computation — and therefore mint/redeem — for every OTHER listed asset too,
    /// even ones the vault doesn't hold, with no admin recovery path. A skipped
    /// asset's value is excluded from this total until it recovers or is
    /// delisted/re-added; that asset's OWN weight/mint/redeem still correctly
    /// reverts (its own circulatingValueOf/priceOf call fails directly), so this
    /// only protects cross-asset availability.
    function totalCirculatingValue() public view returns (uint256 total) {
        uint256 len = assetList.length;
        for (uint256 i = 0; i < len; i++) {
            try this.circulatingValueOf(assetList[i]) returns (uint256 value) {
                total += value;
            } catch {
                // Skip -- see dev-comment above.
            }
        }
    }

    /// @return weight1e18 targetWeight_i scaled to 1e18 (1e18 == 100%). Returns 0
    /// (rather than reverting) for a delisted or never-listed token, so the vault
    /// can still price a "move away from target" redemption of a delisted holding.
    function targetWeightOf(address token) external view returns (uint256 weight1e18) {
        if (!assets[token].listed) return 0;
        uint256 total = totalCirculatingValue();
        if (total == 0) return 0;
        weight1e18 = (circulatingValueOf(token) * 1e18) / total;
    }
}
