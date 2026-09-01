// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice A Robinhood Chain "Stock Token". Plain ERC-20 (18 decimals) that also
/// implements ERC-8056 (Scaled UI Amount Extension) for corporate actions
/// (dividends/splits) via an onchain multiplier.
///
/// IMPORTANT: the vault never needs to read `uiMultiplier()` itself — per Robinhood
/// Chain docs, the Chainlink price feed for each Stock Token already prices in the
/// multiplier ("the oracle automatically incorporates the multiplier into the
/// price"), so `rawBalance * chainlinkPrice` is already a correct fair USD value.
/// The getter is exposed here only for UI/display purposes, not used in vault math.
interface IStockToken is IERC20 {
    function uiMultiplier() external view returns (uint256);
}
