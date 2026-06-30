import { dbUpsertWorker } from "./db.js";
import { jobsStore } from "./state.js";
import type { WorkerRecord } from "./types.js";

/** Worker share of job fee after distribute_fees (20% WORKER_BPS). */
const WORKER_FEE_SHARE = 0.2;

export function recomputeWorkerStats(worker: WorkerRecord): void {
  const now = Date.now() / 1000;
  const dayStart = now - 86400;
  const workerJobs = jobsStore.filter(
    (j) => j.worker_address === worker.address && j.ts >= dayStart && j.status === "settled",
  );

  worker.jobs_today = workerJobs.length;
  worker.earnings_today =
    Math.round(workerJobs.reduce((sum, j) => sum + j.fee * WORKER_FEE_SHARE, 0) * 10000) / 10000;
  worker.penalties_paid =
    Math.round(workerJobs.reduce((sum, j) => sum + (j.penalty_paid ?? 0), 0) * 10000) / 10000;

  if (workerJobs.length > 0) {
    const met = workerJobs.filter((j) => j.sla_met).length;
    worker.sla_pass_rate = Math.round((met / workerJobs.length) * 1000) / 10;

    const ttfts = workerJobs.map((j) => j.ttft_ms).sort((a, b) => a - b);
    const p99Idx = Math.min(ttfts.length - 1, Math.floor(ttfts.length * 0.99));
    worker.p99_ttft_ms = ttfts[p99Idx] ?? 0;
  }

  const hourJobs = workerJobs.filter((j) => now - j.ts < 3600);
  worker.goodput_score = hourJobs.length * 100;
}

export async function onWorkerJobSettled(worker: WorkerRecord): Promise<void> {
  recomputeWorkerStats(worker);
  await dbUpsertWorker(worker);
}
