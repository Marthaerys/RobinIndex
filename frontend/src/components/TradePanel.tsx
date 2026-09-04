import { useEffect, useMemo, useState } from "react";
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import type { VaultData } from "../hooks/useVaultData";
import { useUserAsset } from "../hooks/useUserAsset";
import { useRbdxBalance } from "../hooks/useRbdxBalance";
import { useRedeemCooldown } from "../hooks/useRedeemCooldown";
import { previewMint, previewRedeem } from "../lib/math";
import { fmtToken, fmtUsd, fmtBpsSigned, parseTokenAmount } from "../lib/format";
import { CONTRACTS, RBDX_SYMBOL } from "../config/contracts";
import { RBDXVaultAbi } from "../abis/RBDXVault";
import { Erc20Abi } from "../abis/Erc20";

const SLIPPAGE_BPS = 50n; // 0.5% tolerance between preview and on-chain minOut

type Mode = "mint" | "redeem";

export function TradePanel({ data, onRefetch }: { data: VaultData; onRefetch: () => void }) {
  const { address, isConnected } = useAccount();
  const [mode, setMode] = useState<Mode>("mint");
  const [assetIndex, setAssetIndex] = useState(0);
  const [amountStr, setAmountStr] = useState("");

  const asset = data.assets[assetIndex];
  const amount = parseTokenAmount(amountStr) ?? 0n;

  const vaultParams = {
    devFeeBps: data.devFeeBps,
    rebateFundingBps: data.rebateFundingBps,
    maxWeightFeeBps: data.maxWeightFeeBps,
    rebateReserve: data.rebateReserve,
  };
  const poolParams = { navPre: data.nav, supplyPre: data.totalSupply };
  const assetParams = { price: asset.price, balancePre: asset.vaultBalance, targetWeight: asset.targetWeight };

  const mintPreview = useMemo(() => previewMint(amount, vaultParams, assetParams, poolParams), [amount, data, assetIndex]);
  const redeemPreview = useMemo(() => previewRedeem(amount, vaultParams, assetParams, poolParams), [amount, data, assetIndex]);
  const preview = mode === "mint" ? mintPreview : redeemPreview;

  const userAsset = useUserAsset(asset.address, address);
  const rbdx = useRbdxBalance(address);
  const cooldown = useRedeemCooldown(address);
  const cooldownActive = cooldown.cooldownEnds > BigInt(Math.floor(Date.now() / 1000));

  const needsApproval = mode === "mint" && amount > 0n && userAsset.allowance < amount;

  const approveTx = useWriteContract();
  const approveReceipt = useWaitForTransactionReceipt({ hash: approveTx.data });
  const actionTx = useWriteContract();
  const actionReceipt = useWaitForTransactionReceipt({ hash: actionTx.data });

  useEffect(() => {
    if (approveReceipt.isSuccess) userAsset.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveReceipt.isSuccess]);

  useEffect(() => {
    if (actionReceipt.isSuccess) {
      onRefetch();
      userAsset.refetch();
      rbdx.refetch();
      cooldown.refetch();
      setAmountStr("");
      actionTx.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionReceipt.isSuccess]);

  function handleApprove() {
    approveTx.writeContract({
      address: asset.address,
      abi: Erc20Abi,
      functionName: "approve",
      args: [CONTRACTS.vault, amount],
    });
  }

  function handleSubmit() {
    if (mode === "mint" && mintPreview.ok) {
      const minOut = (mintPreview.rbdxOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      actionTx.writeContract({
        address: CONTRACTS.vault,
        abi: RBDXVaultAbi,
        functionName: "mint",
        args: [asset.address, amount, minOut],
      });
    } else if (mode === "redeem" && redeemPreview.ok) {
      const minOut = (redeemPreview.amountOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      actionTx.writeContract({
        address: CONTRACTS.vault,
        abi: RBDXVaultAbi,
        functionName: "redeem",
        args: [asset.address, amount, minOut],
      });
    }
  }

  const busy = approveTx.isPending || approveReceipt.isFetching || actionTx.isPending || actionReceipt.isFetching;

  return (
    <div className="card">
      <div className="tabs">
        <button className={`tab ${mode === "mint" ? "tab-active" : ""}`} onClick={() => setMode("mint")}>
          Add shares
        </button>
        <button className={`tab ${mode === "redeem" ? "tab-active" : ""}`} onClick={() => setMode("redeem")}>
          Redeem RBDX
        </button>
      </div>

      <div className="trade-body">
        <label className="field-label">Asset</label>
        <select className="select" value={assetIndex} onChange={(e) => setAssetIndex(Number(e.target.value))}>
          {data.assets.map((a, i) => (
            <option key={a.address} value={i}>
              {a.symbol} — {fmtUsd(a.price)}
            </option>
          ))}
        </select>

        <label className="field-label">
          {mode === "mint" ? `Amount of ${asset.symbol} to deposit` : `Amount of ${RBDX_SYMBOL} to burn`}
        </label>
        <input
          className="input"
          type="text"
          inputMode="decimal"
          placeholder="0.0"
          value={amountStr}
          onChange={(e) => setAmountStr(e.target.value)}
        />
        <div className="balance-hint">
          {mode === "mint"
            ? isConnected && `Balance: ${fmtToken(userAsset.balance)} ${asset.symbol}`
            : isConnected && `Balance: ${fmtToken(rbdx.balance)} ${RBDX_SYMBOL}`}
        </div>

        <PreviewPanel mode={mode} mintPreview={mintPreview} redeemPreview={redeemPreview} symbol={asset.symbol} />

        {mode === "redeem" && cooldownActive && (
          <div className="notice notice-warn">
            Redeem cooldown active until {new Date(Number(cooldown.cooldownEnds) * 1000).toLocaleTimeString()} (15 min
            after your last mint).
          </div>
        )}

        {!isConnected ? (
          <div className="notice">Connect your wallet to trade.</div>
        ) : mode === "mint" && needsApproval ? (
          <button className="btn btn-primary btn-block" disabled={busy || amount === 0n} onClick={handleApprove}>
            {approveTx.isPending || approveReceipt.isFetching ? "Approving…" : `Approve ${asset.symbol}`}
          </button>
        ) : (
          <button
            className="btn btn-primary btn-block"
            disabled={busy || amount === 0n || !preview.ok || (mode === "redeem" && cooldownActive)}
            onClick={handleSubmit}
          >
            {actionTx.isPending || actionReceipt.isFetching
              ? "Confirming…"
              : mode === "mint"
                ? "Mint RBDX"
                : `Redeem ${asset.symbol}`}
          </button>
        )}

        {actionReceipt.isSuccess && <div className="notice notice-ok">Done — balances updated below.</div>}
      </div>
    </div>
  );
}

function PreviewPanel({
  mode,
  mintPreview,
  redeemPreview,
  symbol,
}: {
  mode: Mode;
  mintPreview: ReturnType<typeof previewMint>;
  redeemPreview: ReturnType<typeof previewRedeem>;
  symbol: string;
}) {
  if (mode === "mint") {
    if (!mintPreview.ok) {
      const message =
        mintPreview.reason === "zero"
          ? "Enter an amount to see the expected discount / penalty and output."
          : `This would be the very first deposit — needs to be worth at least $100 (currently ~${fmtUsd(mintPreview.usdIn)}).`;
      return <div className="preview preview-empty">{message}</div>;
    }
    return (
      <PreviewBody
        usdValue={mintPreview.usdIn}
        feeBps={mintPreview.weightFeeBps}
        feeLabel={mintPreview.bootstrap ? "n/a (first deposit)" : undefined}
        rebateClamped={mintPreview.rebateClamped}
        outAmount={mintPreview.rbdxOut}
        outSymbol={RBDX_SYMBOL}
      />
    );
  }

  if (!redeemPreview.ok) {
    const message =
      redeemPreview.reason === "zero"
        ? "Enter an amount to see the expected discount / penalty and output."
        : redeemPreview.reason === "empty-vault-balance"
          ? `The vault doesn't hold any ${symbol} to redeem right now.`
          : redeemPreview.reason === "exceeds-supply"
            ? "Amount exceeds total RBDX supply."
            : "Vault doesn't hold enough of this asset to cover that redemption.";
    return <div className="preview preview-empty">{message}</div>;
  }
  return (
    <PreviewBody
      usdValue={redeemPreview.usdAmount}
      feeBps={redeemPreview.weightFeeBps}
      rebateClamped={redeemPreview.rebateClamped}
      outAmount={redeemPreview.amountOut}
      outSymbol={symbol}
    />
  );
}

function PreviewBody({
  usdValue,
  feeBps,
  feeLabel,
  rebateClamped,
  outAmount,
  outSymbol,
}: {
  usdValue: bigint;
  feeBps: bigint;
  feeLabel?: string;
  rebateClamped: boolean;
  outAmount: bigint;
  outSymbol: string;
}) {
  const isPenalty = feeBps > 0n;
  const isRebate = feeBps < 0n;

  return (
    <div className="preview">
      <div className="preview-row">
        <span>Value</span>
        <span className="mono">{fmtUsd(usdValue)}</span>
      </div>
      <div className="preview-row">
        <span>Weight-deviation {isPenalty ? "penalty" : isRebate ? "discount" : "adjustment"}</span>
        <span className={`mono ${isPenalty ? "text-bad" : isRebate ? "text-good" : ""}`}>
          {feeLabel ?? fmtBpsSigned(feeBps)}
        </span>
      </div>
      {rebateClamped && <div className="preview-note">Discount capped by the current rebate reserve.</div>}
      <div className="preview-row preview-row-total">
        <span>
          You receive <span className="fee-note-inline">(est., incl. 0.1% protocol fee)</span>
        </span>
        <span className="mono">
          {fmtToken(outAmount)} {outSymbol}
        </span>
      </div>
    </div>
  );
}
