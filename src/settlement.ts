import { config, PENALTY_MULT } from "./config.js";
import { creditSlaPenalty } from "./billing/credits.js";
import { dbInsertJob } from "./db.js";
import { addLockBurned, broadcastEvent, jobsStore } from "./state.js";
import type { WorkerRecord } from "./types.js";
import { onWorkerJobSettled } from "./worker-stats.js";
import { runOnChainSettlement } from "./solana-settlement.js";

let settlementSkipLogged = false;

export async function settleJob(
  jobId: string,
  slaTier: string,
  ttftMs: number,
  tpotMs: number,
  slaMet: boolean,
  confidential: boolean,
  worker: WorkerRecord,
  fee: number,
  attestationHash: string | null = null,
): Promise<void> {
  const penalty = slaMet ? null : fee * PENALTY_MULT[slaTier]!;

  console.log(`[receipt] ${jobId.slice(0, 12)} tier=${slaTier} ttft=${ttftMs}ms ${slaMet ? "MET" : "MISS"}`);

  addLockBurned(fee * 0.1);

  const job = jobsStore.find((j) => j.id === jobId);
  if (job) {
    job.status = "settled";
    if (!slaMet && penalty != null) job.penalty_paid = Math.round(penalty * 10000) / 10000;

    if (config.solanaSettlementEnabled) {
      const tx = await runOnChainSettlement(
        jobId,
        slaTier,
        ttftMs,
        tpotMs,
        slaMet,
        confidential,
        worker,
        fee,
        attestationHash,
      );
      if (tx) job.settlement_tx = tx;
    } else if (!settlementSkipLogged) {
      settlementSkipLogged = true;
      console.log(
        "[solana] on-chain settlement skipped (SOLANA_SETTLEMENT_ENABLED=false). " +
          "Jobs still settle locally; enable after LOCK mint + vaults are initialized.",
      );
    }

    await dbInsertJob(job);

    if (!slaMet && penalty != null && job.owner_wallet) {
      await creditSlaPenalty(job.owner_wallet, penalty, jobId);
    }
  }

  await onWorkerJobSettled(worker);

  broadcastEvent({
    type: "job",
    id: jobId,
    sla_tier: slaTier,
    ttft_ms: ttftMs,
    tpot_ms: tpotMs,
    sla_met: slaMet,
    penalty,
    worker: worker.address.slice(0, 8),
    ts: Date.now() / 1000,
  });
}

export { watcherSample } from "./watcher.js";
