import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import {
  dbCreateWorkerPayout,
  dbGetWorkerEarningsSummary,
  dbInsertWorkerEarning,
  dbListWorkerPayouts,
  dbMarkWorkerPayoutCompleted,
  dbMarkWorkerPayoutFailed,
  supabaseConfigured,
} from "../db.js";
import { getWorkerBoostInfo } from "../staking/worker-boost.js";
import { creditsToLamports, isTreasuryPayoutConfigured, sendSolPayout } from "./sol-payout.js";
import { creditsToSol } from "./pricing.js";

interface MemoryEarning {
  id: string;
  worker_wallet: string;
  job_id: string;
  fee_credits: number;
  share_bps: number;
  earning_credits: number;
  boosted: boolean;
  created_at: string;
}

interface MemoryPayout {
  id: string;
  worker_wallet: string;
  amount_credits: number;
  amount_lamports: bigint;
  dest_address: string;
  status: "pending_transfer" | "completed" | "failed";
  tx_signature: string | null;
  created_at: string;
  completed_at: string | null;
}

const memoryEarnings: MemoryEarning[] = [];
const memoryPayouts: MemoryPayout[] = [];

export interface WorkerEarningsSummary {
  worker_wallet: string;
  pending_credits: number;
  pending_sol: number;
  total_earned_credits: number;
  total_paid_credits: number;
  today_credits: number;
  week_credits: number;
  boost: Awaited<ReturnType<typeof getWorkerBoostInfo>>;
  payouts_enabled: boolean;
  min_withdrawal_credits: number;
  min_withdrawal_sol: number;
}

export async function recordWorkerEarning(
  workerWallet: string,
  jobId: string,
  feeCredits: number,
): Promise<number> {
  if (feeCredits <= 0) return 0;

  const boost = await getWorkerBoostInfo(workerWallet);
  const shareBps = boost.effective_share_bps;
  const earning = Math.round(feeCredits * (shareBps / 10_000) * 10000) / 10000;
  if (earning <= 0) return 0;

  if (supabaseConfigured()) {
    const inserted = await dbInsertWorkerEarning({
      worker_wallet: workerWallet,
      job_id: jobId,
      fee_credits: feeCredits,
      share_bps: shareBps,
      earning_credits: earning,
      boosted: boost.boost_active,
    });
    if (!inserted) return 0;
  } else {
    if (memoryEarnings.some((e) => e.job_id === jobId)) return 0;
    memoryEarnings.push({
      id: randomUUID(),
      worker_wallet: workerWallet,
      job_id: jobId,
      fee_credits: feeCredits,
      share_bps: shareBps,
      earning_credits: earning,
      boosted: boost.boost_active,
      created_at: new Date().toISOString(),
    });
  }

  return earning;
}

async function memorySummary(wallet: string): Promise<Omit<WorkerEarningsSummary, "boost">> {
  const now = Date.now();
  const dayStart = now - 86400_000;
  const weekStart = now - 7 * 86400_000;
  const earned = memoryEarnings.filter((e) => e.worker_wallet === wallet);
  const paid = memoryPayouts.filter(
    (p) => p.worker_wallet === wallet && (p.status === "completed" || p.status === "pending_transfer"),
  );
  const totalEarned = earned.reduce((s, e) => s + e.earning_credits, 0);
  const totalPaid = paid.reduce((s, p) => s + p.amount_credits, 0);
  const today = earned
    .filter((e) => new Date(e.created_at).getTime() >= dayStart)
    .reduce((s, e) => s + e.earning_credits, 0);
  const week = earned
    .filter((e) => new Date(e.created_at).getTime() >= weekStart)
    .reduce((s, e) => s + e.earning_credits, 0);
  const pending = Math.max(0, Math.round((totalEarned - totalPaid) * 10000) / 10000);
  return {
    worker_wallet: wallet,
    pending_credits: pending,
    pending_sol: creditsToSol(pending),
    total_earned_credits: Math.round(totalEarned * 10000) / 10000,
    total_paid_credits: Math.round(totalPaid * 10000) / 10000,
    today_credits: Math.round(today * 10000) / 10000,
    week_credits: Math.round(week * 10000) / 10000,
    payouts_enabled: config.workerPayoutsEnabled && isTreasuryPayoutConfigured(),
    min_withdrawal_credits: config.workerMinWithdrawalCredits,
    min_withdrawal_sol: creditsToSol(config.workerMinWithdrawalCredits),
  };
}

export async function getWorkerEarningsSummary(wallet: string): Promise<WorkerEarningsSummary> {
  const boost = await getWorkerBoostInfo(wallet);
  const base = supabaseConfigured()
    ? await dbGetWorkerEarningsSummary(wallet)
    : await memorySummary(wallet);
  return { ...base, boost };
}

export type WithdrawResult =
  | { ok: true; amount_credits: number; amount_sol: number; tx_signature: string }
  | { ok: false; reason: "below_min" | "insufficient" | "in_flight" | "disabled" | "not_worker" };

export async function withdrawWorkerEarnings(
  workerWallet: string,
  destAddress: string,
  amountCredits: number,
): Promise<WithdrawResult> {
  if (!config.workerPayoutsEnabled) return { ok: false, reason: "disabled" };
  if (!isTreasuryPayoutConfigured()) return { ok: false, reason: "disabled" };
  if (amountCredits < config.workerMinWithdrawalCredits) return { ok: false, reason: "below_min" };

  const summary = await getWorkerEarningsSummary(workerWallet);
  if (summary.pending_credits < amountCredits) return { ok: false, reason: "insufficient" };

  const lamports = creditsToLamports(amountCredits);
  if (lamports <= 0n) return { ok: false, reason: "below_min" };

  let payoutId: string;
  if (supabaseConfigured()) {
    const created = await dbCreateWorkerPayout({
      worker_wallet: workerWallet,
      amount_credits: amountCredits,
      amount_lamports: lamports,
      dest_address: destAddress,
    });
    if (!created.ok) return { ok: false, reason: created.reason };
    payoutId = created.payoutId;
  } else {
    if (memoryPayouts.some((p) => p.worker_wallet === workerWallet && p.status === "pending_transfer")) {
      return { ok: false, reason: "in_flight" };
    }
    payoutId = randomUUID();
    memoryPayouts.push({
      id: payoutId,
      worker_wallet: workerWallet,
      amount_credits: amountCredits,
      amount_lamports: lamports,
      dest_address: destAddress,
      status: "pending_transfer",
      tx_signature: null,
      created_at: new Date().toISOString(),
      completed_at: null,
    });
  }

  try {
    const tx = await sendSolPayout(destAddress, amountCredits);
    if (supabaseConfigured()) {
      await dbMarkWorkerPayoutCompleted(payoutId, tx);
    } else {
      const row = memoryPayouts.find((p) => p.id === payoutId);
      if (row) {
        row.status = "completed";
        row.tx_signature = tx;
        row.completed_at = new Date().toISOString();
      }
    }
    return {
      ok: true,
      amount_credits: amountCredits,
      amount_sol: creditsToSol(amountCredits),
      tx_signature: tx,
    };
  } catch (err) {
    console.error("[worker-payout] transfer failed:", err);
    if (supabaseConfigured()) {
      await dbMarkWorkerPayoutFailed(payoutId);
    } else {
      const row = memoryPayouts.find((p) => p.id === payoutId);
      if (row) {
        row.status = "failed";
        row.completed_at = new Date().toISOString();
      }
    }
    throw err;
  }
}

export async function listWorkerPayoutHistory(wallet: string, limit = 20) {
  if (supabaseConfigured()) return dbListWorkerPayouts(wallet, limit);
  return memoryPayouts
    .filter((p) => p.worker_wallet === wallet)
    .slice(-limit)
    .reverse()
    .map((p) => ({
      id: p.id,
      amount_credits: p.amount_credits,
      amount_sol: creditsToSol(p.amount_credits),
      dest_address: p.dest_address,
      status: p.status,
      tx_signature: p.tx_signature,
      created_at: p.created_at,
      completed_at: p.completed_at,
    }));
}
