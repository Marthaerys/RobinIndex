/**
 * Off-chain re-implementation of RBDXVault's fee/rebate math, used ONLY to
 * show a live preview before the user submits a transaction. It mirrors
 * `_weightFeeBps` / `_applyFee` / `_splitDevFee` in src/RBDXVault.sol
 * line-for-line (same bigint truncating division as Solidity's uint256 math),
 * using on-chain state read at preview time.
 *
 * This is a preview, not a guarantee: on-chain state (price, NAV, reserve)
 * can move between the preview and the actual transaction, so the real
 * result may differ slightly. The mint/redeem calls always pass a
 * `minOut` slippage guard derived from this preview, never trust it blindly.
 */

const BPS_DENOMINATOR = 10_000n;
const ONE = 10n ** 18n;
export const MIN_FIRST_DEPOSIT_USD = 100n * ONE;
export const DEAD_SHARES = 1000n;

export interface VaultParams {
  devFeeBps: bigint;
  rebateFundingBps: bigint;
  maxWeightFeeBps: bigint;
  rebateReserve: bigint;
}

export interface AssetParams {
  price: bigint; // 1e18 USD
  balancePre: bigint; // vault's current balance of this token
  targetWeight: bigint; // 1e18 == 100%
}

export interface PoolParams {
  navPre: bigint;
  supplyPre: bigint;
}

/** grossAmount -> (netAmount kept for NAV, devFeeToTreasury, devFeeToReserveUsd) */
function splitDevFee(grossAmount: bigint, price: bigint, params: VaultParams) {
  const devFeeAmount = (grossAmount * params.devFeeBps) / BPS_DENOMINATOR;
  const devFeeToTreasury = (devFeeAmount * (BPS_DENOMINATOR - params.rebateFundingBps)) / BPS_DENOMINATOR;
  const devFeeToReserve = devFeeAmount - devFeeToTreasury;
  const netAmount = grossAmount - devFeeAmount;
  const devFeeToReserveUsd = (devFeeToReserve * price) / ONE;
  return { netAmount, devFeeAmount, devFeeToTreasury, devFeeToReserveUsd };
}

/** Sign = direction (toward/away from target), magnitude scales with post-trade deviation. */
function weightFeeBps(currentWeight: bigint, targetWeight: bigint, nextWeight: bigint, maxWeightFeeBps: bigint): bigint {
  const devBefore = currentWeight > targetWeight ? currentWeight - targetWeight : targetWeight - currentWeight;
  const devAfter = nextWeight > targetWeight ? nextWeight - targetWeight : targetWeight - nextWeight;
  const referenceWeight = targetWeight > 0n ? targetWeight : ONE / 10n; // 10% fallback
  let magnitudeBps = (devAfter * maxWeightFeeBps) / referenceWeight;
  if (magnitudeBps > maxWeightFeeBps) magnitudeBps = maxWeightFeeBps;
  if (devAfter === devBefore) return 0n;
  return devAfter < devBefore ? -magnitudeBps : magnitudeBps;
}

/** feeBps >= 0 always succeeds (penalty); feeBps < 0 clamped to reserve & maxRebateUsd. */
function applyFee(usdAmount: bigint, feeBps: bigint, maxRebateUsd: bigint, rebateReserve: bigint) {
  if (feeBps >= 0n) {
    const penaltyUsd = (usdAmount * feeBps) / BPS_DENOMINATOR;
    return { effectiveUsd: usdAmount - penaltyUsd, reserveDelta: penaltyUsd, clamped: false };
  }
  const wantedRebateUsd = (usdAmount * -feeBps) / BPS_DENOMINATOR;
  let actualRebateUsd = wantedRebateUsd;
  let clamped = false;
  if (actualRebateUsd > rebateReserve) {
    actualRebateUsd = rebateReserve;
    clamped = true;
  }
  if (actualRebateUsd > maxRebateUsd) {
    actualRebateUsd = maxRebateUsd;
    clamped = true;
  }
  return { effectiveUsd: usdAmount + actualRebateUsd, reserveDelta: -actualRebateUsd, clamped };
}

export type MintPreview =
  | { ok: false; reason: "zero" }
  | { ok: false; reason: "below-min-first-deposit"; usdIn: bigint }
  | {
      ok: true;
      bootstrap: boolean;
      usdIn: bigint;
      rbdxOut: bigint;
      weightFeeBps: bigint; // positive = penalty, negative = rebate/discount, 0 = neutral
      currentWeight: bigint;
      nextWeight: bigint;
      targetWeight: bigint;
      devFeeToReserveUsd: bigint;
      rebateClamped: boolean;
    };

export function previewMint(amount: bigint, vault: VaultParams, asset: AssetParams, pool: PoolParams): MintPreview {
  if (amount <= 0n) return { ok: false, reason: "zero" };

  const { netAmount, devFeeToReserveUsd } = splitDevFee(amount, asset.price, vault);
  const usdIn = (netAmount * asset.price) / ONE;

  if (pool.supplyPre === 0n) {
    if (usdIn < MIN_FIRST_DEPOSIT_USD) return { ok: false, reason: "below-min-first-deposit", usdIn };
    return {
      ok: true,
      bootstrap: true,
      usdIn,
      rbdxOut: usdIn - DEAD_SHARES,
      weightFeeBps: 0n,
      currentWeight: 0n,
      nextWeight: ONE,
      targetWeight: asset.targetWeight,
      devFeeToReserveUsd,
      rebateClamped: false,
    };
  }

  const indexPricePre = (pool.navPre * ONE) / pool.supplyPre;
  const currentWeight = pool.navPre === 0n ? 0n : ((asset.balancePre * asset.price) / ONE) * ONE / pool.navPre;
  const navAfter = pool.navPre + usdIn;
  const nextBalanceValue = ((asset.balancePre + netAmount) * asset.price) / ONE;
  const nextWeight = navAfter === 0n ? 0n : (nextBalanceValue * ONE) / navAfter;

  const feeBps = weightFeeBps(currentWeight, asset.targetWeight, nextWeight, vault.maxWeightFeeBps);
  const { effectiveUsd, clamped } = applyFee(usdIn, feeBps, 2n ** 255n, vault.rebateReserve);
  const rbdxOut = (effectiveUsd * ONE) / indexPricePre;

  return {
    ok: true,
    bootstrap: false,
    usdIn,
    rbdxOut,
    weightFeeBps: feeBps,
    currentWeight,
    nextWeight,
    targetWeight: asset.targetWeight,
    devFeeToReserveUsd,
    rebateClamped: clamped,
  };
}

export type RedeemPreview =
  | { ok: false; reason: "zero" }
  | { ok: false; reason: "empty-vault-balance" }
  | { ok: false; reason: "exceeds-supply" }
  | { ok: false; reason: "exceeds-vault-balance" }
  | {
      ok: true;
      usdAmount: bigint;
      amountOut: bigint;
      weightFeeBps: bigint;
      currentWeight: bigint;
      nextWeight: bigint;
      targetWeight: bigint;
      rebateClamped: boolean;
    };

export function previewRedeem(rbdxAmount: bigint, vault: VaultParams, asset: AssetParams, pool: PoolParams): RedeemPreview {
  if (rbdxAmount <= 0n) return { ok: false, reason: "zero" };
  if (asset.balancePre === 0n) return { ok: false, reason: "empty-vault-balance" };
  if (pool.supplyPre === 0n || rbdxAmount > pool.supplyPre) return { ok: false, reason: "exceeds-supply" };

  const indexPricePre = (pool.navPre * ONE) / pool.supplyPre;
  const usdAmount = (rbdxAmount * indexPricePre) / ONE;
  const notionalTokenOut = (usdAmount * ONE) / asset.price;
  if (notionalTokenOut > asset.balancePre) return { ok: false, reason: "exceeds-vault-balance" };

  const currentWeight = ((asset.balancePre * asset.price) / ONE) * ONE / pool.navPre;
  const navAfter = pool.navPre - usdAmount;
  const nextBalanceValue = ((asset.balancePre - notionalTokenOut) * asset.price) / ONE;
  const nextWeight = navAfter === 0n ? 0n : (nextBalanceValue * ONE) / navAfter;

  const feeBps = weightFeeBps(currentWeight, asset.targetWeight, nextWeight, vault.maxWeightFeeBps);
  const maxRebateUsd = ((asset.balancePre - notionalTokenOut) * asset.price) / ONE;
  const { effectiveUsd, clamped } = applyFee(usdAmount, feeBps, maxRebateUsd, vault.rebateReserve);
  const rawTokenOut = (effectiveUsd * ONE) / asset.price;
  const { netAmount: amountOut } = splitDevFee(rawTokenOut, asset.price, vault);

  return {
    ok: true,
    usdAmount,
    amountOut,
    weightFeeBps: feeBps,
    currentWeight,
    nextWeight,
    targetWeight: asset.targetWeight,
    rebateClamped: clamped,
  };
}
