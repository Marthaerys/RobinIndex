#!/usr/bin/env python3
"""Regenerate the Safe Transaction Builder batch that re-lists every mainnet
asset with the `maxStaleness` currently recorded in script/config/assets.mainnet.json.

WHY A BATCH AND NOT A SETTER: AssetRegistry has no setMaxStaleness() -- an
asset's `maxOracleStaleness` is only ever written by addAsset(), and addAsset()
reverts with AlreadyListed on a listed token. So retuning it means
delistAsset(token) immediately followed by addAsset(token, feed, staleness),
per token. Adding a real setter would mean redeploying AssetRegistry, and
RBDXVault holds `registry` as an immutable, so that would drag the vault (and a
full balance migration) along with it -- far more risk than a parameter change
warrants.

WHY IT MUST BE ONE BATCH: between the delist and the add, the asset's
targetWeightOf() is 0 and isListed() is false, which would (briefly) skew every
other asset's target weight and freeze mint/redeem of this one. Executed as a
single Safe multisend the whole sequence is atomic, so no external caller ever
observes that intermediate state.

Admin on AssetRegistry is the 2-of-3 Safe (see script/DeployRBDXMainnet.s.sol's
ADMIN_ADDRESS), so this cannot be broadcast from a forge script -- it has to be
proposed in the Safe UI and co-signed.

Usage:
    python3 script/safe/build_staleness_batch.py            # -> script/safe/set-maxstaleness.json
    python3 script/safe/build_staleness_batch.py out.json

Then in the Safe UI (Apps -> Transaction Builder -> Load/drag the JSON),
review, propose, and collect the second signature.
"""

import json
import os
import sys
import time

# Chain/contract constants -- must match frontend/src/config/contracts.ts and
# the addresses recorded in script/config/assets.mainnet.json's header.
CHAIN_ID = "4663"
REGISTRY = "0x6b61Aa9576Eb6Cbb19ac6aB350519Ac37f9CCE79"
SAFE = "0x904B8B54b3734C2Bb0E26b06ab41E1d22a459eF8"

# First 4 bytes of keccak256 of the signature. Verify with:
#   cast sig 'delistAsset(address)'              -> 0x7605bbb0
#   cast sig 'addAsset(address,address,uint256)' -> 0xf399a83e
SEL_DELIST = "7605bbb0"
SEL_ADD = "f399a83e"

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CONFIG = os.path.join(REPO_ROOT, "script", "config", "assets.mainnet.json")
DEFAULT_OUT = os.path.join(REPO_ROOT, "script", "safe", "set-maxstaleness.json")


def word(value):
    """ABI-encode one 32-byte word from an address or an int."""
    if isinstance(value, str):
        value = int(value, 16)
    if not 0 <= value < 2**256:
        raise ValueError(f"out of range for a uint256 word: {value}")
    return f"{value:064x}"


def tx(data):
    # contractMethod/contractInputsValues are null because `data` is already the
    # complete calldata; the Transaction Builder decodes and displays it from
    # the verified contract ABI on import.
    return {
        "to": REGISTRY,
        "value": "0",
        "data": "0x" + data,
        "contractMethod": None,
        "contractInputsValues": None,
    }


def main():
    out_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT
    with open(CONFIG, encoding="utf-8") as fh:
        assets = json.load(fh)["assets"]

    transactions = []
    for a in assets:
        # Order matters: addAsset() reverts with AlreadyListed unless the token
        # was delisted first.
        transactions.append(tx(SEL_DELIST + word(a["token"])))
        transactions.append(
            tx(SEL_ADD + word(a["token"]) + word(a["chainlinkFeed"]) + word(a["maxStaleness"]))
        )

    values = sorted({a["maxStaleness"] for a in assets})
    summary = (
        f"{values[0]}s ({values[0] / 86400:g} days)"
        if len(values) == 1
        else f"per-asset ({min(values)}-{max(values)}s)"
    )

    batch = {
        "version": "1.0",
        "chainId": CHAIN_ID,
        "createdAt": int(time.time() * 1000),
        "meta": {
            "name": f"RBDX: set maxOracleStaleness to {summary}",
            "description": (
                f"Re-lists all {len(assets)} mainnet assets with maxOracleStaleness = {summary}, "
                "by delistAsset + addAsset per token (AssetRegistry has no setter). "
                "Feed addresses are unchanged. Generated from script/config/assets.mainnet.json "
                "by script/safe/build_staleness_batch.py."
            ),
            "txBuilderVersion": "1.16.5",
            "createdFromSafeAddress": SAFE,
        },
        "transactions": transactions,
    }

    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(batch, fh, indent=2)
        fh.write("\n")

    print(f"{len(assets)} assets -> {len(transactions)} calls, maxStaleness {summary}")
    print(f"written: {out_path}")


if __name__ == "__main__":
    main()
