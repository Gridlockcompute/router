import { Hono } from "hono";
import { config } from "../config.js";
import { dbUpsertWorker } from "../db.js";
import { anchorRegisterWorker } from "../solana.js";
import { jobsStore, workersRegistry } from "../state.js";
import type { HeartbeatRequest, RegisterWorkerRequest, SetWorkerStatusRequest, WorkerRecord } from "../types.js";
import { recomputeWorkerStats } from "../worker-stats.js";
import { slaTiersForWorker } from "../tee-capacity.js";
import { workerHub } from "../ws/hub.js";

export const workerRoutes = new Hono();

workerRoutes.get("/v1/workers", (c) => {
  const role = c.req.query("role");
  const status = c.req.query("status");
  const teeRaw = c.req.query("tee_capable");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);

  let workers = workersRegistry.map((w) => ({ ...w }));
  if (role) workers = workers.filter((w) => w.role.toLowerCase() === role.toLowerCase());
  if (status) workers = workers.filter((w) => w.status.toLowerCase() === status.toLowerCase());
  if (teeRaw !== undefined) {
    const tee = teeRaw === "true";
    workers = workers.filter((w) => w.tee_capable === tee);
  }

  return c.json({ workers: workers.slice(0, limit), total: workers.length });
});

workerRoutes.get("/v1/workers/:address", (c) => {
  const address = c.req.param("address");
  const worker = workersRegistry.find((w) => w.address === address);
  if (!worker) return c.json({ error: `Worker ${address} not found` }, 404);
  recomputeWorkerStats(worker);
  const recent = jobsStore
    .filter((j) => j.worker_address === address)
    .slice(-20)
    .reverse();
  const conn = workerHub.getConnectionInfo(address);
  return c.json({
    ...worker,
    ...conn,
    recent_jobs: recent,
    in_flight: workerHub.inFlightCount(address),
  });
});

workerRoutes.post("/v1/workers/register", async (c) => {
  const req = (await c.req.json()) as RegisterWorkerRequest;
  if (workersRegistry.some((w) => w.address === req.operator_pubkey)) {
    return c.json({ error: "Worker already registered" }, 409);
  }

  const tee = req.tee_capable ?? false;

  const tx = await anchorRegisterWorker(
    req.operator_pubkey,
    req.role,
    req.hardware_tier,
    tee,
  );

  const newWorker: WorkerRecord = {
    address: req.operator_pubkey,
    role: req.role,
    endpoint: req.endpoint || config.vllmEndpoint,
    sla_tiers: slaTiersForWorker(tee),
    tee_capable: tee,
    reliability_score: 5000,
    goodput_score: 0,
    sla_pass_rate: 100.0,
    p99_ttft_ms: 0,
    status: "Active",
    staked_lock: 0,
    hardware_tier: req.hardware_tier,
    jobs_today: 0,
    earnings_today: 0,
    penalties_paid: 0,
    is_confidential: req.is_confidential ?? tee,
    stake_token_account: config.defaultWorkerStake || undefined,
    last_heartbeat: Date.now() / 1000,
    registered_at: Date.now() / 1000,
  };

  workersRegistry.push(newWorker);
  void dbUpsertWorker(newWorker);
  return c.json({ success: true, address: req.operator_pubkey, tx_sig: tx });
});

workerRoutes.post("/v1/workers/heartbeat", async (c) => {
  const req = (await c.req.json()) as HeartbeatRequest;
  const worker = workersRegistry.find((w) => w.address === req.worker_address);
  if (!worker) return c.json({ error: "Worker not found" }, 404);

  worker.last_heartbeat = Date.now() / 1000;
  if (worker.status === "AutoGated") {
    worker.status = "Active";
    console.log(`[heartbeat] ${req.worker_address.slice(0, 8)}… recovered`);
  }
  if (req.goodput_score !== undefined) worker.goodput_score = req.goodput_score;
  if (req.p99_ttft_ms !== undefined) worker.p99_ttft_ms = req.p99_ttft_ms;

  void dbUpsertWorker(worker);
  return c.json({ ok: true, ts: worker.last_heartbeat, status: worker.status });
});

const RUNTIME_STATUSES = new Set(["Active", "Paused", "Stopping"]);

workerRoutes.post("/v1/workers/:address/status", async (c) => {
  const address = c.req.param("address");
  const worker = workersRegistry.find((w) => w.address === address);
  if (!worker) return c.json({ error: "Worker not found" }, 404);

  const req = (await c.req.json()) as SetWorkerStatusRequest;
  if (!RUNTIME_STATUSES.has(req.status)) {
    return c.json({ error: `Invalid status. Allowed: ${[...RUNTIME_STATUSES].join(", ")}` }, 400);
  }

  worker.status = req.status;
  if (req.status === "Paused") {
    workerHub.disconnectWorker(address);
  }

  void dbUpsertWorker(worker);
  return c.json({
    ok: true,
    status: worker.status,
    in_flight: workerHub.inFlightCount(address),
  });
});

workerRoutes.patch("/v1/workers/:address/confidential", async (c) => {
  const address = c.req.param("address");
  const worker = workersRegistry.find((w) => w.address === address);
  if (!worker) return c.json({ error: "Worker not found" }, 404);

  const body = (await c.req.json()) as { enabled?: boolean };
  if (typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled (boolean) is required" }, 400);
  }
  if (body.enabled && !worker.tee_capable) {
    return c.json({ error: "Worker is not TEE-capable — re-register with tee_capable: true" }, 400);
  }

  worker.is_confidential = body.enabled;
  void dbUpsertWorker(worker);
  return c.json({ ok: true, is_confidential: worker.is_confidential });
});
