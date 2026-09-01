// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AggregatorV3Interface} from "../interfaces/AggregatorV3Interface.sol";

/// @notice Shared Chainlink-reading helper used by both RBDXVault (pricing held
/// balances) and AssetRegistry (pricing market cap for target weights), so the
/// staleness check and decimal-normalization logic exists in exactly one place.
library OracleLib {
    error StalePrice(address feed, uint256 updatedAt, uint256 nowTs, uint256 maxStaleness);
    error InvalidPrice(address feed, int256 answer);

    uint256 internal constant PRICE_PRECISION = 1e18;

    /// @param feed The Chainlink AggregatorV3Interface for a Stock Token.
    /// @param maxStaleness Max allowed age (seconds) of the feed's last update.
    ///        Stock feeds update 24/5 during market hours (see docs.robinhood.com/
    ///        chain/oracles-and-price-feeds) — callers must size `maxStaleness` to
    ///        tolerate normal off-hours gaps, or mint/burn will revert outside
    ///        market hours. That trade-off is deliberately left to governance
    ///        (see Open Questions in docs/DESIGN.md) rather than hardcoded here.
    /// @return price The feed price normalized to 18 decimals.
    function getPrice1e18(AggregatorV3Interface feed, uint256 maxStaleness) internal view returns (uint256 price) {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0) revert InvalidPrice(address(feed), answer);
        if (block.timestamp > updatedAt && block.timestamp - updatedAt > maxStaleness) {
            revert StalePrice(address(feed), updatedAt, block.timestamp, maxStaleness);
        }

        uint8 feedDecimals = feed.decimals();
        if (feedDecimals == 18) {
            price = uint256(answer);
        } else if (feedDecimals < 18) {
            price = uint256(answer) * (10 ** (18 - feedDecimals));
        } else {
            price = uint256(answer) / (10 ** (feedDecimals - 18));
        }
    }
}
