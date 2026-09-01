// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal Chainlink price feed interface, matching the feeds Robinhood
/// Chain deploys per Stock Token (see docs.robinhood.com/chain/oracles-and-price-feeds).
/// Vendored directly instead of pulling the full chainlink contracts package,
/// since this is the only piece of it this project needs.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);

    function description() external view returns (string memory);

    function version() external view returns (uint256);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
