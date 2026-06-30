import type { JobRecord } from "../types.js";

const TIER_LABELS: Record<string, string> = {
  realtime: "Realtime",
  standard: "Standard",
  batch: "Batch",
  confidential: "Confidential",
};

const TIER_COLORS: Record<string, string> = {
  realtime: "var(--orange)",
  standard: "var(--green)",
  batch: "var(--text-secondary)",
  confidential: "var(--purple)",
};

export interface BillingTierRow {
  tier: string;
  tier_id: string;
  requests: number;
  spend: number;
  pct: number;
  color: string;
}

export interface BillingModelRow {
  model: string;
  requests: number;
  tokens: number;
  spend: number;
  pct: number;
}

export interface BillingKeyRow {
  id: string;
  name: string;
  key_prefix: string;
  requests: number;
  spend: number;
}

export interface BillingSummary {
  period: {
    start: string;
    end: string;
    label: string;
  };
  mtd_spend_lock: number;
  mtd_requests: number;
  mtd_tokens: number;
  penalties_credited_lock: number;
  credit_balance_lock: number | null;
  by_tier: BillingTierRow[];
  by_model: BillingModelRow[];
  by_api_key: BillingKeyRow[];
}

export function monthStartTs(now = new Date()): number {
  return Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
}

export function monthPeriod(now = new Date()): BillingSummary["period"] {
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  const label = start.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    label,
  };
}

export function jobBelongsToWallet(job: JobRecord, wallet: string): boolean {
  if (job.owner_wallet === wallet) return true;
  if (job.customer === wallet) return true;
  return false;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

export function aggregateBilling(
  jobs: JobRecord[],
  wallet: string,
  sinceTs: number,
  keyNames: Map<string, { name: string; key_prefix: string }> = new Map(),
): BillingSummary {
  const period = monthPeriod();
  const mtdJobs = jobs.filter(
    (j) => jobBelongsToWallet(j, wallet) && j.ts >= sinceTs,
  );

  const mtdSpend = mtdJobs.reduce((sum, j) => sum + (j.fee ?? 0), 0);
  const mtdRequests = mtdJobs.length;
  const mtdTokens = mtdJobs.reduce(
    (sum, j) => sum + (j.prompt_tokens ?? 0) + (j.completion_tokens ?? 0),
    0,
  );
  const penaltiesCredited = mtdJobs.reduce(
    (sum, j) => sum + (j.penalty_paid ?? 0),
    0,
  );

  const tierMap = new Map<string, { requests: number; spend: number }>();
  const modelMap = new Map<string, { requests: number; tokens: number; spend: number }>();
  const keyMap = new Map<string, { requests: number; spend: number }>();

  for (const job of mtdJobs) {
    const tierId = job.sla_tier ?? "standard";
    const tierRow = tierMap.get(tierId) ?? { requests: 0, spend: 0 };
    tierRow.requests += 1;
    tierRow.spend += job.fee ?? 0;
    tierMap.set(tierId, tierRow);

    const modelId = job.model ?? "unknown";
    const modelRow = modelMap.get(modelId) ?? { requests: 0, tokens: 0, spend: 0 };
    modelRow.requests += 1;
    modelRow.tokens += (job.prompt_tokens ?? 0) + (job.completion_tokens ?? 0);
    modelRow.spend += job.fee ?? 0;
    modelMap.set(modelId, modelRow);

    if (job.api_key_id) {
      const keyRow = keyMap.get(job.api_key_id) ?? { requests: 0, spend: 0 };
      keyRow.requests += 1;
      keyRow.spend += job.fee ?? 0;
      keyMap.set(job.api_key_id, keyRow);
    }
  }

  const byTier: BillingTierRow[] = [...tierMap.entries()]
    .map(([tierId, row]) => ({
      tier_id: tierId,
      tier: TIER_LABELS[tierId] ?? tierId,
      requests: row.requests,
      spend: round4(row.spend),
      pct: pct(row.spend, mtdSpend),
      color: TIER_COLORS[tierId] ?? "var(--text-muted)",
    }))
    .sort((a, b) => b.spend - a.spend);

  const byModel: BillingModelRow[] = [...modelMap.entries()]
    .map(([model, row]) => ({
      model,
      requests: row.requests,
      tokens: row.tokens,
      spend: round4(row.spend),
      pct: pct(row.spend, mtdSpend),
    }))
    .sort((a, b) => b.spend - a.spend);

  const byApiKey: BillingKeyRow[] = [...keyMap.entries()]
    .map(([id, row]) => {
      const meta = keyNames.get(id);
      return {
        id,
        name: meta?.name ?? "API key",
        key_prefix: meta?.key_prefix ?? id.slice(0, 8),
        requests: row.requests,
        spend: round4(row.spend),
      };
    })
    .sort((a, b) => b.spend - a.spend);

  return {
    period,
    mtd_spend_lock: round4(mtdSpend),
    mtd_requests: mtdRequests,
    mtd_tokens: mtdTokens,
    penalties_credited_lock: round4(penaltiesCredited),
    credit_balance_lock: null,
    by_tier: byTier,
    by_model: byModel,
    by_api_key: byApiKey,
  };
}

export function mergeJobsById(...lists: JobRecord[][]): JobRecord[] {
  const byId = new Map<string, JobRecord>();
  for (const list of lists) {
    for (const job of list) {
      byId.set(job.id, job);
    }
  }
  return [...byId.values()];
}
