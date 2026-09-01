// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Implemented by RBDXVault. Used only for the mint-cooldown transfer gate
/// below — kept as a minimal interface so the token doesn't need the vault's full
/// source.
interface IMintCooldown {
    function mintCooldownEnds(address account) external view returns (uint256);
}

/// @title RBDXToken
/// @notice The RobinIndex share token. Mint/burn is restricted to the RBDXVault
/// contract only. Secondary-market trading (DEXes, wallets that didn't just mint)
/// is completely unrestricted.
///
/// The ONE restriction: a wallet that minted via the vault cannot transfer (or be
/// burned/redeemed) for `mintRedeemCooldown` afterwards — see `_update` below. This
/// mirrors GMX's GLP cooldown precedent and exists specifically to close a hole a
/// naive "only gate the vault's redeem() call" design would leave open: without
/// this, a user could mint, immediately send the fresh tokens to a second wallet
/// that never minted (so its own cooldown timer reads zero), and have that second
/// wallet redeem right away — bypassing the cooldown entirely. Gating transfer-out
/// (not just redeem) on the *sender's* cooldown closes that path. It does mean a
/// freshly-minted balance can't be flipped on a DEX for the first
/// `mintRedeemCooldown` (default 15 min) either — an accepted, deliberate trade-off,
/// not a bug.
contract RBDXToken is ERC20, Ownable {
    address public vault;

    event VaultUpdated(address indexed previousVault, address indexed newVault);

    error OnlyVault();
    error VaultAlreadySet();
    error ZeroAddress();
    error MintCooldownActive(address account, uint256 cooldownEnds);

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(address initialOwner) ERC20("RobinIndex", "RBDX") Ownable(initialOwner) {}

    function _update(address from, address to, uint256 value) internal override {
        // from == address(0) is a mint — never gated here (the vault decides mint
        // eligibility itself). Every other case (ordinary transfer, or a burn where
        // to == address(0)) requires the SENDER to be past their own cooldown.
        if (from != address(0) && vault != address(0)) {
            uint256 cooldownEnds = IMintCooldown(vault).mintCooldownEnds(from);
            if (block.timestamp < cooldownEnds) revert MintCooldownActive(from, cooldownEnds);
        }
        super._update(from, to, value);
    }

    /// @notice One-time wiring of the vault address, done right after both contracts
    /// are deployed. Kept mutable (owner-only) rather than immutable-at-construction
    /// so the token can be deployed first and handed to the vault's constructor.
    function setVault(address newVault) external onlyOwner {
        if (newVault == address(0)) revert ZeroAddress();
        if (vault != address(0)) revert VaultAlreadySet();
        emit VaultUpdated(vault, newVault);
        vault = newVault;
    }

    function mint(address to, uint256 amount) external onlyVault {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyVault {
        _burn(from, amount);
    }
}
