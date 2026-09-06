// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal fee-on-transfer ERC-20, used only to test that RBDXVault.mint()
/// prices off what it actually received rather than the caller-declared `amount`.
/// Real Robinhood Chain Stock Tokens are plain, non-fee-on-transfer ERC-20s today
/// — this mock exists purely as a forward-looking regression test in case that
/// assumption is ever wrong for some future listed asset.
contract MockFeeOnTransferToken is ERC20 {
    uint256 public immutable feeBps; // e.g. 1000 = 10%, taken out of every transfer

    constructor(string memory name_, string memory symbol_, uint256 feeBps_) ERC20(name_, symbol_) {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && feeBps > 0) {
            uint256 fee = (value * feeBps) / 10_000;
            super._update(from, address(0), fee); // fee is burned
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}
