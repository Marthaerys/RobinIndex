import { formatUnits, parseUnits } from "viem";

export function fmtUsd(value: bigint, decimals = 18, fractionDigits = 2): string {
  const n = Number(formatUnits(value, decimals));
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: fractionDigits });
}

export function fmtToken(value: bigint, decimals = 18, fractionDigits = 4): string {
  const n = Number(formatUnits(value, decimals));
  return n.toLocaleString("en-US", { maximumFractionDigits: fractionDigits });
}

export function fmtPct(weight1e18: bigint, fractionDigits = 2): string {
  const n = Number(formatUnits(weight1e18, 18)) * 100;
  return `${n.toFixed(fractionDigits)}%`;
}

/** bps as signed int (positive = penalty, negative = rebate) -> "+0.42%" / "-0.71%" */
export function fmtBpsSigned(bps: bigint): string {
  const n = Number(bps) / 100;
  const sign = n > 0 ? "+" : n < 0 ? "" : "±";
  return `${sign}${n.toFixed(2)}%`;
}

export function parseTokenAmount(input: string, decimals = 18): bigint | null {
  if (!input || Number.isNaN(Number(input))) return null;
  try {
    return parseUnits(input as `${number}`, decimals);
  } catch {
    return null;
  }
}

export function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
