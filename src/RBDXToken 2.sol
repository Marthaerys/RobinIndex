// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title RBDXToken
/// @notice The RobinIndex share token. Mint/burn is restricted to the RBDXVault
/// contract only. Otherwise this is a completely plain, unrestricted ERC-20 — no
/// transfer gating, no cooldown — so it can be bought/sold on DEXes immediately,
/// including tokens someone just minted. That's a deliberate choice: arbitrageurs
/// need to be able to react instantly to correct a DEX-price/NAV gap, which is the
/// whole point of letting RBDX trade freely.
///
/// An earlier version of this contract also gated ordinary transfers on a
/// mint-cooldown (mirroring GMX's GLP), to close a "mint on wallet A, hand off to
/// fresh wallet B, redeem instantly from B" loophole. On reflection that loophole
/// doesn't need closing: RBDXVault's `rebateReserve` clamp (see RBDXVault.sol) is
/// what actually bounds how much value any redemption can extract, regardless of
/// which wallet calls it or how fast — so gating transfers bought no real safety
/// margin, it only cost arbitrage speed. RBDXVault.redeem() still has its own
/// optional per-wallet cooldown (`mintRedeemCooldown`, governance-configurable,
/// can be set to 0) as a minor speed bump against same-wallet round-trips through
/// the vault specifically — it does not and cannot touch DEX transfers.
contract RBDXToken is ERC20, Ownable {
    address public vault;

    event VaultUpdated(address indexed previousVault, address indexed newVault);

    error OnlyVault();
    error VaultAlreadySet();
    error ZeroAddress();

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    constructor(address initialOwner) ERC20("RobinIndex", "RBDX") Ownable(initialOwner) {}

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
