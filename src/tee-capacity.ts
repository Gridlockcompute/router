import type { WorkerRecord } from "./types.js";
import { workerHub } from "./ws/hub.js";

export function slaTiersForWorker(teeCapable: boolean): string[] {
  return teeCapable
    ? ["batch", "standard", "realtime", "confidential"]
    : ["batch", "standard", "realtime"];
}

export function noWorkerResponse(confidential: boolean): { error: string; code: string } {
  if (confidential) {
    return {
      error:
        "No TEE-capable workers are online. Enable a worker with GRIDLOCK_TEE_CAPABLE=true or wait for datacenter providers.",
      code: "no_tee_workers",
    };
  }
  return {
    error: "No eligible workers for this SLA tier.",
    code: "no_workers",
  };
}

export function getTeeCapacity(workers: WorkerRecord[]) {
  const teeRegistered = workers.filter((w) => w.tee_capable);
  const teeOnline = teeRegistered.filter((w) => {
    if (w.status !== "Active") return false;
    return workerHub.isConnected(w.address);
  });
  return {
    tee_workers_registered: teeRegistered.length,
    tee_workers_online: teeOnline.length,
    can_serve_confidential: teeOnline.length > 0,
    online_addresses: teeOnline.map((w) => w.address.slice(0, 8)),
  };
}
