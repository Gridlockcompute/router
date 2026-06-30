import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";
import { config } from "./config.js";
import type { ApiKeyRecord, BillingInvoiceRecord, JobRecord, WorkerRecord } from "./types.js";

let sbClient: SupabaseClient | null = null;

function getClient(): SupabaseClient | null {
  if (sbClient) return sbClient;
  if (!config.supabaseUrl || !config.supabaseKey) return null;
  try {
    sbClient = createClient(config.supabaseUrl, config.supabaseKey, {
      realtime: { transport: ws },
    });
    console.log("[supabase] client ready");
    return sbClient;
  } catch (error) {
    console.log(`[supabase] init failed: ${error}`);
    return null;
  }
}

function formatSupabaseError(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { message?: string; code?: string; details?: string };
    return [e.code, e.message, e.details].filter(Boolean).join(": ") || JSON.stringify(error);
  }
  return String(error);
}

/** Map Supabase `jobs` row to in-memory JobRecord. */
function rowToJob(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    customer: String(row.customer ?? ""),
    model: String(row.model ?? ""),
    sla_tier: String(row.sla_tier ?? "standard"),
    ttft_ms: Number(row.ttft_ms ?? 0),
    tpot_ms: Number(row.tpot_ms ?? 0),
    sla_met: Boolean(row.sla_met),
    confidential: Boolean(row.confidential),
    worker: String(row.worker ?? ""),
    worker_address: String(row.worker_address ?? ""),
    ts: Number(row.ts ?? 0),
    penalty_paid: row.penalty_paid != null ? Number(row.penalty_paid) : null,
    fee: Number(row.fee ?? 0),
    status: String(row.status ?? "settled"),
    attestation_hash: row.attestation_hash ? String(row.attestation_hash) : null,
    owner_wallet: row.owner_wallet ? String(row.owner_wallet) : null,
    api_key_id: row.api_key_id ? String(row.api_key_id) : null,
    prompt_tokens: Number(row.prompt_tokens ?? 0),
    completion_tokens: Number(row.completion_tokens ?? 0),
    settlement_tx: row.settlement_tx ? String(row.settlement_tx) : null,
    escrow_customer_wallet: row.escrow_customer_wallet
      ? String(row.escrow_customer_wallet)
      : null,
  };
}

/** Map in-memory job to Supabase `jobs` row. */
function jobToRow(job: JobRecord): Record<string, unknown> {
  return {
    id: job.id,
    customer: job.customer,
    model: job.model,
    sla_tier: job.sla_tier,
    ttft_ms: job.ttft_ms,
    tpot_ms: job.tpot_ms,
    sla_met: job.sla_met,
    confidential: job.confidential,
    worker: job.worker,
    worker_address: job.worker_address,
    ts: job.ts,
    penalty_paid: job.penalty_paid ?? null,
    fee: job.fee,
    status: job.status,
    attestation_hash: job.attestation_hash ?? null,
    owner_wallet: job.owner_wallet ?? null,
    api_key_id: job.api_key_id ?? null,
    prompt_tokens: job.prompt_tokens ?? 0,
    completion_tokens: job.completion_tokens ?? 0,
    settlement_tx: job.settlement_tx ?? null,
    escrow_customer_wallet: job.escrow_customer_wallet ?? null,
  };
}

export async function dbInsertJob(job: JobRecord): Promise<void> {
  const sb = getClient();
  if (!sb) return;
  try {
    const row = jobToRow(job);
    const { error } = await sb.from("jobs").upsert(row, { onConflict: "id" });
    if (error) throw error;
    console.log(`[supabase] job saved ${job.id.slice(0, 8)} (${job.status})`);
  } catch (error) {
    console.log(`[supabase] insert_job failed: ${formatSupabaseError(error)}`);
  }
}

export async function dbUpsertWorker(worker: WorkerRecord): Promise<void> {
  const sb = getClient();
  if (!sb) return;
  try {
    const payload = {
      address: worker.address,
      role: worker.role,
      endpoint: worker.endpoint,
      sla_tiers: JSON.stringify(worker.sla_tiers),
      tee_capable: worker.tee_capable,
      reliability_score: Math.round(worker.reliability_score),
      goodput_score: Math.round(worker.goodput_score),
      sla_pass_rate: worker.sla_pass_rate,
      p99_ttft_ms: Math.round(worker.p99_ttft_ms),
      status: worker.status,
      staked_lock: Math.round(worker.staked_lock),
      hardware_tier: worker.hardware_tier,
      jobs_today: Math.round(worker.jobs_today),
      earnings_today: worker.earnings_today,
      penalties_paid: Math.round(worker.penalties_paid),
      is_confidential: worker.is_confidential,
      last_heartbeat: worker.last_heartbeat,
      registered_at: worker.registered_at,
    };
    const { error } = await sb.from("workers").upsert(payload, { onConflict: "address" });
    if (error) throw error;
  } catch (error) {
    console.log(`[supabase] upsert_worker failed: ${formatSupabaseError(error)}`);
  }
}

export async function dbLoadJobs(): Promise<JobRecord[]> {
  const sb = getClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from("jobs")
      .select("*")
      .order("ts", { ascending: false })
      .limit(1000);
    if (error) throw error;
    return (data ?? []).map((row) => rowToJob(row as Record<string, unknown>));
  } catch (error) {
    console.log(`[supabase] load_jobs failed: ${error}`);
    return [];
  }
}

export async function dbLoadWorkers(): Promise<WorkerRecord[]> {
  const sb = getClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb.from("workers").select("*");
    if (error) throw error;
    return (data ?? []).map((row) => {
      const worker = row as WorkerRecord & { sla_tiers: string | string[] };
      if (typeof worker.sla_tiers === "string") {
        worker.sla_tiers = JSON.parse(worker.sla_tiers) as string[];
      }
      return worker;
    });
  } catch (error) {
    console.log(`[supabase] load_workers failed: ${error}`);
    return [];
  }
}

export function supabaseConfigured(): boolean {
  return Boolean(config.supabaseUrl && config.supabaseKey);
}

function toApiKeyRecord(row: Record<string, unknown>): ApiKeyRecord {
  return {
    id: String(row.id),
    key_hash: String(row.key_hash),
    key_prefix: String(row.key_prefix),
    owner_wallet: String(row.owner_wallet),
    name: String(row.name),
    default_sla: String(row.default_sla),
    tee_required: Boolean(row.tee_required),
    allowed_ips: Array.isArray(row.allowed_ips) ? row.allowed_ips.map(String) : null,
    request_count: Number(row.request_count ?? 0),
    is_active: Boolean(row.is_active),
    created_at: String(row.created_at),
    last_used_at: row.last_used_at ? String(row.last_used_at) : null,
  };
}

export function toPublicApiKey(row: ApiKeyRecord) {
  const { key_hash: _h, is_active: _a, ...rest } = row;
  return rest;
}

export async function dbHasActiveApiKeys(): Promise<boolean> {
  const sb = getClient();
  if (!sb) return false;
  try {
    const { count, error } = await sb
      .from("api_keys")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true);
    if (error) throw error;
    return (count ?? 0) > 0;
  } catch (error) {
    console.log(`[supabase] has_active_api_keys failed: ${formatSupabaseError(error)}`);
    return false;
  }
}

export async function dbGetApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null> {
  const sb = getClient();
  if (!sb) return null;
  try {
    const { data, error } = await sb
      .from("api_keys")
      .select("*")
      .eq("key_hash", keyHash)
      .eq("is_active", true)
      .maybeSingle();
    if (error) throw error;
    return data ? toApiKeyRecord(data as Record<string, unknown>) : null;
  } catch (error) {
    console.log(`[supabase] get_api_key failed: ${formatSupabaseError(error)}`);
    return null;
  }
}

export async function dbListApiKeysByWallet(wallet: string): Promise<ApiKeyRecord[]> {
  const sb = getClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from("api_keys")
      .select("*")
      .eq("owner_wallet", wallet)
      .eq("is_active", true)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row) => toApiKeyRecord(row as Record<string, unknown>));
  } catch (error) {
    console.log(`[supabase] list_api_keys failed: ${formatSupabaseError(error)}`);
    return [];
  }
}

export async function dbGetApiKeyById(id: string, wallet: string): Promise<ApiKeyRecord | null> {
  const sb = getClient();
  if (!sb) return null;
  try {
    const { data, error } = await sb
      .from("api_keys")
      .select("*")
      .eq("id", id)
      .eq("owner_wallet", wallet)
      .eq("is_active", true)
      .maybeSingle();
    if (error) throw error;
    return data ? toApiKeyRecord(data as Record<string, unknown>) : null;
  } catch (error) {
    console.log(`[supabase] get_api_key_by_id failed: ${formatSupabaseError(error)}`);
    return null;
  }
}

export async function dbInsertApiKey(
  row: Omit<ApiKeyRecord, "id" | "request_count" | "is_active" | "created_at" | "last_used_at">,
): Promise<ApiKeyRecord | null> {
  const sb = getClient();
  if (!sb) return null;
  try {
    const { data, error } = await sb
      .from("api_keys")
      .insert({
        key_hash: row.key_hash,
        key_prefix: row.key_prefix,
        owner_wallet: row.owner_wallet,
        name: row.name,
        default_sla: row.default_sla,
        tee_required: row.tee_required,
        allowed_ips: row.allowed_ips,
      })
      .select("*")
      .single();
    if (error) throw error;
    return toApiKeyRecord(data as Record<string, unknown>);
  } catch (error) {
    console.log(`[supabase] insert_api_key failed: ${formatSupabaseError(error)}`);
    return null;
  }
}

export async function dbUpdateApiKey(
  id: string,
  wallet: string,
  patch: Partial<Pick<ApiKeyRecord, "name" | "default_sla" | "tee_required" | "allowed_ips">>,
): Promise<ApiKeyRecord | null> {
  const sb = getClient();
  if (!sb) return null;
  try {
    const { data, error } = await sb
      .from("api_keys")
      .update(patch)
      .eq("id", id)
      .eq("owner_wallet", wallet)
      .eq("is_active", true)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return data ? toApiKeyRecord(data as Record<string, unknown>) : null;
  } catch (error) {
    console.log(`[supabase] update_api_key failed: ${formatSupabaseError(error)}`);
    return null;
  }
}

export async function dbRevokeApiKey(id: string, wallet: string): Promise<boolean> {
  const sb = getClient();
  if (!sb) return false;
  try {
    const { error } = await sb
      .from("api_keys")
      .update({ is_active: false })
      .eq("id", id)
      .eq("owner_wallet", wallet)
      .eq("is_active", true);
    if (error) throw error;
    return true;
  } catch (error) {
    console.log(`[supabase] revoke_api_key failed: ${formatSupabaseError(error)}`);
    return false;
  }
}

export async function dbIncrementApiKeyUsage(id: string): Promise<void> {
  const sb = getClient();
  if (!sb || id === "env") return;
  try {
    const { data, error: readError } = await sb
      .from("api_keys")
      .select("request_count")
      .eq("id", id)
      .maybeSingle();
    if (readError) throw readError;
    if (!data) return;
    const next = Number((data as { request_count: number }).request_count ?? 0) + 1;
    const { error } = await sb
      .from("api_keys")
      .update({ request_count: next, last_used_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
  } catch (error) {
    console.log(`[supabase] increment_api_key_usage failed: ${formatSupabaseError(error)}`);
  }
}

export async function dbLoadJobsForWallet(wallet: string, sinceTs: number): Promise<JobRecord[]> {
  const sb = getClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from("jobs")
      .select("*")
      .or(`owner_wallet.eq.${wallet},customer.eq.${wallet}`)
      .gte("ts", sinceTs)
      .order("ts", { ascending: false })
      .limit(5000);
    if (error) throw error;
    return (data ?? []).map((row) => rowToJob(row as Record<string, unknown>));
  } catch (error) {
    console.log(`[supabase] load_jobs_for_wallet failed: ${formatSupabaseError(error)}`);
    return [];
  }
}

// ─── Customer credits (Phase B) ───────────────────────────────────────────────

export async function dbEnsureCustomerBalance(
  wallet: string,
  startingCredit: number,
): Promise<void> {
  const sb = getClient();
  if (!sb) return;
  try {
    const { data } = await sb
      .from("customer_balances")
      .select("owner_wallet")
      .eq("owner_wallet", wallet)
      .maybeSingle();
    if (data) return;

    const start = Math.max(0, startingCredit);
    const { error: insertError } = await sb.from("customer_balances").insert({
      owner_wallet: wallet,
      balance_lock: start,
    });
    if (insertError) throw insertError;

    if (start > 0) {
      await sb.from("credit_ledger").insert({
        owner_wallet: wallet,
        kind: "starting_credit",
        amount_lock: start,
        balance_after: start,
        note: "Welcome credits",
      });
    }
  } catch (error) {
    console.log(`[supabase] ensure_customer_balance failed: ${formatSupabaseError(error)}`);
  }
}

export async function dbGetCustomerBalance(wallet: string): Promise<number> {
  const sb = getClient();
  if (!sb) return 0;
  try {
    const { data, error } = await sb
      .from("customer_balances")
      .select("balance_lock")
      .eq("owner_wallet", wallet)
      .maybeSingle();
    if (error) throw error;
    return Math.round(Number(data?.balance_lock ?? 0) * 10000) / 10000;
  } catch (error) {
    console.log(`[supabase] get_customer_balance failed: ${formatSupabaseError(error)}`);
    return 0;
  }
}

export async function dbChargeCustomer(
  wallet: string,
  amount: number,
  jobId: string,
): Promise<{ ok: boolean; balance: number }> {
  const sb = getClient();
  if (!sb) return { ok: false, balance: 0 };

  try {
    const { data: prior } = await sb
      .from("credit_ledger")
      .select("id")
      .eq("job_id", jobId)
      .eq("kind", "charge")
      .maybeSingle();
    if (prior) {
      const balance = await dbGetCustomerBalance(wallet);
      return { ok: true, balance };
    }

    const { data: row, error: readError } = await sb
      .from("customer_balances")
      .select("balance_lock")
      .eq("owner_wallet", wallet)
      .maybeSingle();
    if (readError) throw readError;

    const current = Number(row?.balance_lock ?? 0);
    if (current < amount) {
      return { ok: false, balance: Math.round(current * 10000) / 10000 };
    }

    const next = Math.round((current - amount) * 10000) / 10000;
    const { data: after, error: writeError } = await sb
      .from("customer_balances")
      .update({ balance_lock: next, updated_at: new Date().toISOString() })
      .eq("owner_wallet", wallet)
      .gte("balance_lock", amount)
      .select("balance_lock")
      .maybeSingle();
    if (writeError) throw writeError;
    if (!after) {
      const balance = await dbGetCustomerBalance(wallet);
      return { ok: false, balance };
    }

    const { error: ledgerError } = await sb.from("credit_ledger").insert({
      owner_wallet: wallet,
      job_id: jobId,
      kind: "charge",
      amount_lock: -amount,
      balance_after: Number(after.balance_lock),
      note: "Inference fee",
    });
    if (ledgerError) throw ledgerError;

    return { ok: true, balance: Number(after.balance_lock) };
  } catch (error) {
    console.log(`[supabase] charge_customer failed: ${formatSupabaseError(error)}`);
    const balance = await dbGetCustomerBalance(wallet);
    return { ok: false, balance };
  }
}

export async function dbApplyCredit(
  wallet: string,
  amount: number,
  jobId: string | null,
  kind: string,
  note: string,
): Promise<number> {
  const sb = getClient();
  if (!sb) return 0;

  try {
    if (jobId) {
      const { data: prior } = await sb
        .from("credit_ledger")
        .select("id")
        .eq("job_id", jobId)
        .eq("kind", kind)
        .maybeSingle();
      if (prior) return dbGetCustomerBalance(wallet);
    }

    const current = await dbGetCustomerBalance(wallet);
    const next = Math.round((current + amount) * 10000) / 10000;

    const { data: after, error } = await sb
      .from("customer_balances")
      .update({ balance_lock: next, updated_at: new Date().toISOString() })
      .eq("owner_wallet", wallet)
      .select("balance_lock")
      .maybeSingle();
    if (error) throw error;
    if (!after) throw new Error("balance row missing");

    await sb.from("credit_ledger").insert({
      owner_wallet: wallet,
      job_id: jobId,
      kind,
      amount_lock: amount,
      balance_after: Number(after.balance_lock),
      note,
    });

    return Number(after.balance_lock);
  } catch (error) {
    console.log(`[supabase] apply_credit failed: ${formatSupabaseError(error)}`);
    return dbGetCustomerBalance(wallet);
  }
}

function rowToInvoice(row: Record<string, unknown>): BillingInvoiceRecord {
  return {
    id: String(row.id),
    owner_wallet: String(row.owner_wallet),
    period_year: Number(row.period_year),
    period_month: Number(row.period_month),
    period_label: String(row.period_label),
    amount_lock: Number(row.amount_lock ?? 0),
    penalties_credited_lock: Number(row.penalties_credited_lock ?? 0),
    request_count: Number(row.request_count ?? 0),
    token_count: Number(row.token_count ?? 0),
    status: String(row.status) as BillingInvoiceRecord["status"],
    settlement_tx: row.settlement_tx ? String(row.settlement_tx) : null,
    settled_at: row.settled_at ? String(row.settled_at) : null,
    created_at: String(row.created_at),
  };
}

export async function dbLoadAllJobsForWallet(wallet: string): Promise<JobRecord[]> {
  const sb = getClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from("jobs")
      .select("*")
      .or(`owner_wallet.eq.${wallet},customer.eq.${wallet}`)
      .order("ts", { ascending: false })
      .limit(10000);
    if (error) throw error;
    return (data ?? []).map((row) => rowToJob(row as Record<string, unknown>));
  } catch (error) {
    console.log(`[supabase] load_all_jobs_for_wallet failed: ${formatSupabaseError(error)}`);
    return [];
  }
}

export async function dbListInvoicesByWallet(wallet: string): Promise<BillingInvoiceRecord[]> {
  const sb = getClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from("billing_invoices")
      .select("*")
      .eq("owner_wallet", wallet)
      .order("period_year", { ascending: false })
      .order("period_month", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((row) => rowToInvoice(row as Record<string, unknown>));
  } catch (error) {
    console.log(`[supabase] list_invoices failed: ${formatSupabaseError(error)}`);
    return [];
  }
}

export async function dbUpsertInvoice(invoice: BillingInvoiceRecord): Promise<void> {
  const sb = getClient();
  if (!sb) return;
  try {
    const row = {
      id: invoice.id,
      owner_wallet: invoice.owner_wallet,
      period_year: invoice.period_year,
      period_month: invoice.period_month,
      period_label: invoice.period_label,
      amount_lock: invoice.amount_lock,
      penalties_credited_lock: invoice.penalties_credited_lock,
      request_count: invoice.request_count,
      token_count: invoice.token_count,
      status: invoice.status,
      settlement_tx: invoice.settlement_tx,
      settled_at: invoice.settled_at,
    };
    const { error } = await sb
      .from("billing_invoices")
      .upsert(row, { onConflict: "owner_wallet,period_year,period_month" });
    if (error) throw error;
  } catch (error) {
    console.log(`[supabase] upsert_invoice failed: ${formatSupabaseError(error)}`);
  }
}

export async function dbGetDepositByTx(txSignature: string): Promise<boolean> {
  const sb = getClient();
  if (!sb) return false;
  try {
    const { data, error } = await sb
      .from("billing_deposits")
      .select("tx_signature")
      .eq("tx_signature", txSignature)
      .maybeSingle();
    if (error) throw error;
    return Boolean(data);
  } catch (error) {
    console.log(`[supabase] get_deposit failed: ${formatSupabaseError(error)}`);
    return false;
  }
}

export async function dbInsertDeposit(row: {
  tx_signature: string;
  owner_wallet: string;
  amount_lock: number;
  deposit_vault: string;
}): Promise<boolean> {
  const sb = getClient();
  if (!sb) return true;
  try {
    const { error } = await sb.from("billing_deposits").insert(row);
    if (error) {
      if (String(error.code) === "23505") return false;
      throw error;
    }
    return true;
  } catch (error) {
    console.log(`[supabase] insert_deposit failed: ${formatSupabaseError(error)}`);
    return false;
  }
}

export async function dbListBillingWallets(): Promise<string[]> {
  const sb = getClient();
  if (!sb) return [];
  try {
    const wallets = new Set<string>();
    const { data: keys, error: keysError } = await sb
      .from("api_keys")
      .select("owner_wallet")
      .eq("is_active", true);
    if (keysError) throw keysError;
    for (const row of keys ?? []) {
      if (row.owner_wallet) wallets.add(String(row.owner_wallet));
    }

    const { data: jobs, error: jobsError } = await sb
      .from("jobs")
      .select("owner_wallet, customer")
      .not("owner_wallet", "is", null)
      .limit(5000);
    if (jobsError) throw jobsError;
    for (const row of jobs ?? []) {
      if (row.owner_wallet) wallets.add(String(row.owner_wallet));
      else if (row.customer && String(row.customer).length >= 32) {
        wallets.add(String(row.customer));
      }
    }

    return [...wallets];
  } catch (error) {
    console.log(`[supabase] list_billing_wallets failed: ${formatSupabaseError(error)}`);
    return [];
  }
}

export async function dbGetStakeDepositByTx(txSignature: string): Promise<boolean> {
  const sb = getClient();
  if (!sb) return false;
  try {
    const { data, error } = await sb
      .from("stake_deposits")
      .select("tx_signature")
      .eq("tx_signature", txSignature)
      .maybeSingle();
    if (error) throw error;
    return Boolean(data);
  } catch (error) {
    console.log(`[supabase] get_stake_deposit failed: ${formatSupabaseError(error)}`);
    return false;
  }
}

export async function dbInsertStakeDeposit(row: {
  tx_signature: string;
  owner_wallet: string;
  amount_lock: number;
  vault_ata: string;
}): Promise<boolean> {
  const sb = getClient();
  if (!sb) return true;
  try {
    const { error } = await sb.from("stake_deposits").insert(row);
    if (error) {
      if (String(error.code) === "23505") return false;
      throw error;
    }
    return true;
  } catch (error) {
    console.log(`[supabase] insert_stake_deposit failed: ${formatSupabaseError(error)}`);
    return false;
  }
}

export interface StakeUnstakeRow {
  id: string;
  owner_wallet: string;
  amount_lock: number;
  requested_at: string;
  unlock_at: string;
  status: string;
}

export async function dbGetPendingUnstakeForWallet(
  wallet: string,
): Promise<StakeUnstakeRow | null> {
  const sb = getClient();
  if (!sb) return null;
  try {
    const { data, error } = await sb
      .from("stake_unstake_requests")
      .select("id, owner_wallet, amount_lock, requested_at, unlock_at, status")
      .eq("owner_wallet", wallet)
      .eq("status", "pending")
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      id: String(data.id),
      owner_wallet: String(data.owner_wallet),
      amount_lock: Number(data.amount_lock),
      requested_at: String(data.requested_at),
      unlock_at: String(data.unlock_at),
      status: String(data.status),
    };
  } catch (error) {
    console.log(`[supabase] get_pending_unstake failed: ${formatSupabaseError(error)}`);
    return null;
  }
}

export async function dbInsertUnstakeRequest(
  wallet: string,
  amountLock: number,
  unlockAt: string,
): Promise<boolean> {
  const sb = getClient();
  if (!sb) return true;
  try {
    const { error } = await sb.from("stake_unstake_requests").insert({
      owner_wallet: wallet,
      amount_lock: amountLock,
      unlock_at: unlockAt,
      status: "pending",
    });
    if (error) throw error;
    return true;
  } catch (error) {
    console.log(`[supabase] insert_unstake_request failed: ${formatSupabaseError(error)}`);
    return false;
  }
}

export async function dbMarkUnstakeClaimed(id: string, claimTx: string): Promise<boolean> {
  const sb = getClient();
  if (!sb) return true;
  try {
    const { error } = await sb
      .from("stake_unstake_requests")
      .update({
        status: "claimed",
        claim_tx: claimTx,
        claimed_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("status", "pending");
    if (error) throw error;
    return true;
  } catch (error) {
    console.log(`[supabase] mark_unstake_claimed failed: ${formatSupabaseError(error)}`);
    return false;
  }
}
