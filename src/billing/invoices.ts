import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { jobBelongsToWallet, mergeJobsById } from "./aggregate.js";
import {
  dbListInvoicesByWallet,
  dbLoadAllJobsForWallet,
  dbUpsertInvoice,
  supabaseConfigured,
} from "../db.js";
import { jobsStore } from "../state.js";
import type { BillingInvoiceRecord, JobRecord } from "../types.js";

export interface InvoicePeriod {
  year: number;
  month: number;
  label: string;
  startTs: number;
  endTs: number;
}

const memInvoices = new Map<string, BillingInvoiceRecord[]>();

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function invoicePeriodFromDate(d: Date): InvoicePeriod {
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const start = new Date(year, d.getMonth(), 1);
  const end = new Date(year, d.getMonth() + 1, 0, 23, 59, 59, 999);
  const label = start.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  return {
    year,
    month,
    label,
    startTs: Math.floor(start.getTime() / 1000),
    endTs: Math.floor(end.getTime() / 1000),
  };
}

export function currentInvoicePeriod(now = new Date()): InvoicePeriod {
  return invoicePeriodFromDate(now);
}

function jobsInPeriod(jobs: JobRecord[], wallet: string, period: InvoicePeriod): JobRecord[] {
  return jobs.filter(
    (j) =>
      jobBelongsToWallet(j, wallet)
      && j.ts >= period.startTs
      && j.ts <= period.endTs,
  );
}

function aggregateInvoiceJobs(jobs: JobRecord[]): Omit<
  BillingInvoiceRecord,
  "id" | "owner_wallet" | "period_year" | "period_month" | "period_label" | "created_at"
> {
  const amount = jobs.reduce((s, j) => s + (j.fee ?? 0), 0);
  const penalties = jobs.reduce((s, j) => s + (j.penalty_paid ?? 0), 0);
  const tokens = jobs.reduce(
    (s, j) => s + (j.prompt_tokens ?? 0) + (j.completion_tokens ?? 0),
    0,
  );
  const settlementTx = [...jobs].reverse().find((j) => j.settlement_tx)?.settlement_tx ?? null;

  return {
    amount_lock: round4(amount),
    penalties_credited_lock: round4(penalties),
    request_count: jobs.length,
    token_count: tokens,
    status: settlementTx ? "paid" : "paid_offchain",
    settlement_tx: settlementTx,
    settled_at: new Date().toISOString(),
  };
}

function buildOpenInvoice(wallet: string, period: InvoicePeriod, jobs: JobRecord[]): BillingInvoiceRecord {
  const agg = aggregateInvoiceJobs(jobs);
  return {
    id: `open-${wallet.slice(0, 8)}-${period.year}-${period.month}`,
    owner_wallet: wallet,
    period_year: period.year,
    period_month: period.month,
    period_label: period.label,
    ...agg,
    status: "open",
    settlement_tx: null,
    settled_at: null,
    created_at: new Date().toISOString(),
  };
}

async function loadAllWalletJobs(wallet: string): Promise<JobRecord[]> {
  const memory = jobsStore.filter((j) => jobBelongsToWallet(j, wallet));
  const dbJobs = supabaseConfigured() ? await dbLoadAllJobsForWallet(wallet) : [];
  return mergeJobsById(dbJobs, memory);
}

function monthKeysFromJobs(jobs: JobRecord[]): InvoicePeriod[] {
  const keys = new Map<string, InvoicePeriod>();
  for (const job of jobs) {
    const period = invoicePeriodFromDate(new Date(job.ts * 1000));
    keys.set(`${period.year}-${period.month}`, period);
  }
  return [...keys.values()].sort((a, b) =>
    b.year !== a.year ? b.year - a.year : b.month - a.month,
  );
}

export async function syncInvoicesForWallet(wallet: string): Promise<BillingInvoiceRecord[]> {
  const jobs = await loadAllWalletJobs(wallet);
  const current = currentInvoicePeriod();
  const currentKey = `${current.year}-${current.month}`;

  const existing = supabaseConfigured()
    ? await dbListInvoicesByWallet(wallet)
    : (memInvoices.get(wallet) ?? []);

  const byKey = new Map(
    existing.map((inv) => [`${inv.period_year}-${inv.period_month}`, inv]),
  );

  for (const period of monthKeysFromJobs(jobs)) {
    const key = `${period.year}-${period.month}`;
    if (key === currentKey) continue;

    const periodJobs = jobsInPeriod(jobs, wallet, period);
    if (!periodJobs.length) continue;

    const prior = byKey.get(key);
    if (prior && prior.status !== "open") continue;

    const agg = aggregateInvoiceJobs(periodJobs);
    const record: BillingInvoiceRecord = {
      id: prior?.id ?? randomUUID(),
      owner_wallet: wallet,
      period_year: period.year,
      period_month: period.month,
      period_label: period.label,
      ...agg,
      created_at: prior?.created_at ?? new Date().toISOString(),
    };

    if (supabaseConfigured()) {
      await dbUpsertInvoice(record);
    }
    byKey.set(key, record);
  }

  const currentJobs = jobsInPeriod(jobs, wallet, current);
  const openInvoice = buildOpenInvoice(wallet, current, currentJobs);
  byKey.set(currentKey, openInvoice);

  const sorted = [...byKey.values()].sort((a, b) =>
    b.period_year !== a.period_year ? b.period_year - a.period_year : b.period_month - a.period_month,
  );

  if (!supabaseConfigured()) {
    memInvoices.set(wallet, sorted.filter((inv) => inv.status !== "open"));
    return sorted;
  }

  return sorted;
}

export function solscanTxUrl(signature: string): string {
  const cluster = config.solanaCluster;
  if (cluster === "mainnet-beta" || cluster === "mainnet") {
    return `https://solscan.io/tx/${signature}`;
  }
  return `https://solscan.io/tx/${signature}?cluster=${cluster}`;
}
