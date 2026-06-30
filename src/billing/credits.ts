import { config } from "../config.js";
import {
  dbApplyCredit,
  dbChargeCustomer,
  dbEnsureCustomerBalance,
  dbGetCustomerBalance,
  supabaseConfigured,
} from "../db.js";
import type { ApiKeyContext } from "../types.js";

export interface ChargeResult {
  ok: boolean;
  balance: number;
}

const memBalances = new Map<string, number>();
const memChargedJobs = new Set<string>();
const memPenaltyCredited = new Set<string>();

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** Bill only wallet-owned DB API keys (not env bootstrap keys). */
export function billingApplies(apiKey: ApiKeyContext | undefined): boolean {
  return (
    config.billingEnabled
    && apiKey?.source === "database"
    && Boolean(apiKey.owner_wallet)
  );
}

function ensureMemBalance(wallet: string): number {
  if (!memBalances.has(wallet)) {
    memBalances.set(wallet, config.startingCreditLock);
  }
  return memBalances.get(wallet)!;
}

export async function getCreditBalance(wallet: string): Promise<number> {
  if (supabaseConfigured()) {
    await dbEnsureCustomerBalance(wallet, config.startingCreditLock);
    return dbGetCustomerBalance(wallet);
  }
  return round4(ensureMemBalance(wallet));
}

export async function chargeJobFee(
  wallet: string,
  fee: number,
  jobId: string,
): Promise<ChargeResult> {
  const amount = round4(fee);
  if (amount <= 0) {
    return { ok: true, balance: await getCreditBalance(wallet) };
  }

  if (supabaseConfigured()) {
    await dbEnsureCustomerBalance(wallet, config.startingCreditLock);
    return dbChargeCustomer(wallet, amount, jobId);
  }

  if (memChargedJobs.has(jobId)) {
    return { ok: true, balance: round4(ensureMemBalance(wallet)) };
  }

  const balance = ensureMemBalance(wallet);
  if (balance < amount) {
    return { ok: false, balance: round4(balance) };
  }

  memBalances.set(wallet, round4(balance - amount));
  memChargedJobs.add(jobId);
  return { ok: true, balance: round4(memBalances.get(wallet)!) };
}

export async function creditSlaPenalty(
  wallet: string,
  amount: number,
  jobId: string,
): Promise<number> {
  const credit = round4(amount);
  if (credit <= 0) return getCreditBalance(wallet);

  if (supabaseConfigured()) {
    await dbEnsureCustomerBalance(wallet, config.startingCreditLock);
    return dbApplyCredit(wallet, credit, jobId, "penalty_credit", "SLA penalty credit");
  }

  if (memPenaltyCredited.has(jobId)) {
    return round4(ensureMemBalance(wallet));
  }
  memPenaltyCredited.add(jobId);
  memBalances.set(wallet, round4(ensureMemBalance(wallet) + credit));
  return round4(memBalances.get(wallet)!);
}

export async function topupCredits(wallet: string, amount: number): Promise<number> {
  const credit = round4(amount);
  if (credit <= 0) return getCreditBalance(wallet);

  if (supabaseConfigured()) {
    await dbEnsureCustomerBalance(wallet, config.startingCreditLock);
    return dbApplyCredit(wallet, credit, null, "topup", "Dev top-up");
  }

  memBalances.set(wallet, round4(ensureMemBalance(wallet) + credit));
  return round4(memBalances.get(wallet)!);
}

const memDeposits = new Set<string>();

export async function creditFromOnChainDeposit(
  wallet: string,
  amount: number,
  txSignature: string,
): Promise<number> {
  const credit = round4(amount);
  if (credit <= 0) return getCreditBalance(wallet);

  if (memDeposits.has(txSignature)) {
    return getCreditBalance(wallet);
  }

  if (supabaseConfigured()) {
    await dbEnsureCustomerBalance(wallet, 0);
    const balance = await dbApplyCredit(
      wallet,
      credit,
      null,
      "deposit",
      `On-chain deposit ${txSignature.slice(0, 8)}…`,
    );
    return balance;
  }

  memDeposits.add(txSignature);
  memBalances.set(wallet, round4(ensureMemBalance(wallet) + credit));
  return round4(memBalances.get(wallet)!);
}

export function insufficientCreditsResponse(balance: number, fee: number) {
  return {
    error: `Insufficient $LOCK credit balance (${balance.toFixed(4)} available, ${fee.toFixed(4)} required)`,
    code: "insufficient_credits" as const,
    balance_lock: balance,
    fee_lock: fee,
  };
}
