import { createHash, randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";
import { config, computeFee, PENALTY_MULT, SLA_TARGETS } from "./config.js";
import { dbUpsertWorker } from "./db.js";
import { isValidSolanaPubkey } from "./solana.js";
import { appendJob, jobsStore, setWorkersRegistry, workersRegistry } from "./state.js";
import { slaTiersForWorker } from "./tee-capacity.js";
import type { JobRecord, WorkerRecord } from "./types.js";
import { workerHub } from "./ws/hub.js";

/** Active in registry, or AutoGated but still connected over WebSocket. */
export function isWorkerEligibleForJobs(worker: WorkerRecord): boolean {
  if (worker.status === "Active") return true;
  return worker.status === "AutoGated" && workerHub.isConnected(worker.address);
}

const HARDWARE_TIERS = ["RTX 4090", "RTX 3090", "A100 80G", "H100 SXM", "RTX 5090", "A6000"];
const ROLES = ["Prefill", "Decode", "Cache", "Router"];

function randomAddress(): string {
  return randomBytes(33).toString("base64url").slice(0, 44);
}

function randomChoice<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

export function hashPrefix(prompt: string): string {
  return createHash("sha256").update(prompt.slice(0, 256)).digest("hex");
}

export function seedWorkers(): WorkerRecord[] {
  const out: WorkerRecord[] = [];
  for (let i = 0; i < 20; i++) {
    const role = ROLES[i % 4]!;
    const tee = Math.random() > 0.45;
    out.push({
      address: randomAddress(),
      role,
      endpoint: config.vllmEndpoint,
      sla_tiers: slaTiersForWorker(tee),
      tee_capable: tee,
      reliability_score: Math.floor(Math.random() * 3400) + 6500,
      goodput_score: Math.floor(Math.random() * 1600) + 200,
      sla_pass_rate: Math.round((Math.random() * 11.5 + 88) * 10) / 10,
      p99_ttft_ms: Math.floor(Math.random() * 360) + 120,
      status: Math.random() > 0.15 ? "Active" : "Paused",
      staked_lock: Math.floor(Math.random() * 75000) + 5000,
      hardware_tier: randomChoice(HARDWARE_TIERS),
      jobs_today: Math.floor(Math.random() * 11200) + 800,
      earnings_today: Math.round((Math.random() * 408 + 12) * 100) / 100,
      penalties_paid: Math.floor(Math.random() * 501),
      is_confidential: tee && Math.random() > 0.4,
      last_heartbeat: Date.now() / 1000 - Math.random() * 60,
      registered_at: Date.now() / 1000 - Math.random() * 86400 * 30,
    });
  }
  return out;
}

export function seedJobs(workers: WorkerRecord[]): void {
  const models = ["llama-3.1-70b", "llama-3.1-8b", "mistral-7b", "qwen2.5-72b"];
  const tiersPool = ["realtime", "realtime", "standard", "batch", "confidential"];
  for (let i = 0; i < 80; i++) {
    const tier = randomChoice(tiersPool);
    const ttft = Math.floor(Math.random() * 820) + 80;
    const tpot = Math.floor(Math.random() * 120) + 30;
    const met = ttft <= SLA_TARGETS[tier]!.ttft;
    const model = randomChoice(models);
    const tokens = Math.floor(Math.random() * 960) + 64;
    const fee = computeFee(model, tier, tokens);
    const worker = randomChoice(workers);
    const jobId = randomUUID();
    appendJob({
      id: jobId,
      customer: randomBytes(6).toString("hex"),
      model,
      sla_tier: tier,
      ttft_ms: ttft,
      tpot_ms: tpot,
      sla_met: met,
      confidential: tier === "confidential",
      worker: worker.address.slice(0, 8),
      worker_address: worker.address,
      ts: Date.now() / 1000 - Math.random() * 3600,
      penalty_paid: met ? null : Math.round(fee * PENALTY_MULT[tier]! * 10000) / 10000,
      fee,
      status: "settled",
      attestation_hash: null,
    });
  }
}

function activeForTier(slaTier: string, confidential: boolean): WorkerRecord[] {
  let pool = workersRegistry.filter(
    (w) =>
      isWorkerEligibleForJobs(w) &&
      w.sla_tiers.includes(slaTier) &&
      (!confidential || w.tee_capable),
  );
  if (config.solanaSettlementEnabled) {
    const valid = pool.filter((w) => isValidSolanaPubkey(w.address));
    if (valid.length) pool = valid;
  }
  return pool;
}

export function pickPrefillWorker(
  slaTier: string,
  confidential: boolean,
  warmAddr: string | null,
): WorkerRecord | null {
  let pool = activeForTier(slaTier, confidential).filter((w) => w.role === "Prefill");
  if (!pool.length) pool = activeForTier(slaTier, confidential);
  if (!pool.length) return null;
  if (warmAddr) {
    const warm = pool.find((w) => w.address === warmAddr);
    if (warm) return warm;
  }
  return pool.reduce((best, w) => (w.goodput_score > best.goodput_score ? w : best));
}

export function pickDecodeWorker(
  slaTier: string,
  confidential: boolean,
): WorkerRecord | null {
  const pool = activeForTier(slaTier, confidential).filter((w) => w.role === "Decode");
  if (!pool.length) return null;
  return pool.reduce((best, w) => (w.reliability_score > best.reliability_score ? w : best));
}

export function startHeartbeatWatcher(): void {
  setInterval(() => {
    const now = Date.now() / 1000;
    for (const w of workersRegistry) {
      const stale = now - w.last_heartbeat > 120;
      if (w.status === "Active" && stale) {
        w.status = "AutoGated";
        console.log(`[watcher] AutoGated ${w.address.slice(0, 8)}… (${Math.floor(now - w.last_heartbeat)}s silent)`);
        void dbUpsertWorker(w);
      } else if (w.status === "AutoGated" && !stale) {
        w.status = "Active";
        console.log(`[watcher] Recovered ${w.address.slice(0, 8)}…`);
        void dbUpsertWorker(w);
      }
    }
  }, 60_000);
}

export async function initWorkersAndJobs(
  loadWorkers: () => Promise<WorkerRecord[]>,
  loadJobs: () => Promise<JobRecord[]>,
): Promise<void> {
  const dbWorkers = await loadWorkers();
  if (dbWorkers.length) {
    const now = Date.now() / 1000;
    for (const w of dbWorkers) {
      w.last_heartbeat = now;
      w.status = "Active";
    }
    setWorkersRegistry(dbWorkers);
    console.log(`[startup] ${dbWorkers.length} workers from Supabase (heartbeats reset)`);
  } else {
    setWorkersRegistry(seedWorkers());
    console.log(`[startup] ${workersRegistry.length} workers seeded (no Supabase)`);
  }

  const dbJobs = await loadJobs();
  if (dbJobs.length) {
    for (const j of dbJobs) appendJob(j);
    console.log(`[startup] ${dbJobs.length} jobs from Supabase`);
  } else {
    seedJobs(workersRegistry);
    console.log(`[startup] ${jobsStore.length} jobs seeded (no Supabase)`);
  }
}
