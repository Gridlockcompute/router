import type { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { workersRegistry } from "../state.js";
import type { Message, WorkerRecord } from "../types.js";

export type WorkerConnectionType = "browser" | "native" | "desktop";

export interface WsWorkerSession {
  address: string;
  ws: WebSocket;
  type: WorkerConnectionType;
  model: string;
  tokPerSec: number;
  status: "idle" | "busy";
  connectedAt: number;
}

export interface DispatchJobPayload {
  jobId: string;
  model: string;
  messages: Message[];
  slaTier: string;
  maxTokens: number;
  customer: string;
  confidential?: boolean;
}

interface PendingJob {
  payload: DispatchJobPayload;
  resolve: (result: JobResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  assignedAddress?: string;
}

export interface JobResult {
  content: string;
  tokensGenerated: number;
  ttftMs: number;
  tpotMs: number;
  attestationHash?: string | null;
}

/** Jobs waiting for a worker (REST poll or WS push). */
interface QueuedJob {
  payload: DispatchJobPayload;
  assignedAddress?: string;
}

const JOB_TIMEOUT_MS = 180_000;

class WorkerHub {
  private sessions = new Map<string, WsWorkerSession>();
  private pending = new Map<string, PendingJob>();
  private queue: QueuedJob[] = [];
  private pollWaiters = new Map<string, QueuedJob[]>();

  private touchHeartbeatForWs(ws: WebSocket) {
    for (const [addr, session] of this.sessions) {
      if (session.ws === ws) {
        this.touchHeartbeat(addr);
        return;
      }
    }
  }

  private touchHeartbeat(address: string) {
    const worker = workersRegistry.find((w) => w.address === address);
    if (!worker) return;
    worker.last_heartbeat = Date.now() / 1000;
    if (worker.status === "AutoGated") {
      worker.status = "Active";
    }
  }

  attach(ws: WebSocket) {
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as Record<string, unknown>;
        this.handleMessage(ws, msg);
      } catch {
        this.send(ws, { type: "error", message: "Invalid JSON" });
      }
    });

    ws.on("close", () => {
      for (const [addr, session] of this.sessions) {
        if (session.ws === ws) {
          this.sessions.delete(addr);
          console.log(`[ws] disconnected ${addr.slice(0, 8)}…`);
          this.requeueWorkerJobs(addr);
        }
      }
      this.broadcastStats();
    });
  }

  private handleMessage(ws: WebSocket, msg: Record<string, unknown>) {
    switch (msg.type) {
      case "worker:register":
        this.register(ws, msg);
        break;
      case "worker:unregister":
        if (typeof msg.worker_address === "string") {
          this.unregister(msg.worker_address);
        }
        break;
      case "job:complete":
        this.completeJob(msg);
        break;
      case "job:error":
        this.failJob(msg);
        break;
      case "ping":
        this.touchHeartbeatForWs(ws);
        this.send(ws, { type: "pong", ts: Date.now() });
        break;
      default:
        this.send(ws, { type: "error", message: `Unknown type: ${msg.type}` });
    }
  }

  private register(ws: WebSocket, msg: Record<string, unknown>) {
    const address = String(msg.worker_address ?? "");
    if (!address) {
      this.send(ws, { type: "error", message: "worker_address required" });
      return;
    }

    const worker = workersRegistry.find((w) => w.address === address);
    if (!worker) {
      this.send(ws, { type: "error", message: "Worker not registered — POST /v1/workers/register first" });
      return;
    }

    const existing = this.sessions.get(address);
    if (existing) existing.ws.close();

    const session: WsWorkerSession = {
      address,
      ws,
      type: (msg.worker_type as WorkerConnectionType) ?? "browser",
      model: String(msg.model ?? "llama-3.2-1B-Instruct-q4f16_1-MLC"),
      tokPerSec: Number(msg.tok_per_sec ?? 0),
      status: "idle",
      connectedAt: Date.now(),
    };
    this.sessions.set(address, session);
    this.touchHeartbeat(address);

    console.log(`[ws] registered ${address.slice(0, 8)}… (${session.type})`);
    this.send(ws, { type: "worker:registered", worker_address: address });
    this.broadcastStats();
    this.tryDispatchIdle(session);
  }

  private unregister(address: string) {
    const session = this.sessions.get(address);
    if (session) {
      session.ws.close();
      this.sessions.delete(address);
    }
    this.requeueWorkerJobs(address);
    this.broadcastStats();
  }

  private completeJob(msg: Record<string, unknown>) {
    const jobId = String(msg.job_id ?? "");
    const pending = this.pending.get(jobId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(jobId);

    const session = pending.assignedAddress
      ? this.sessions.get(pending.assignedAddress)
      : undefined;
    if (session) {
      session.status = "idle";
      this.touchHeartbeat(session.address);
    }

    const content = String(msg.response ?? msg.content ?? "");
    const tokensGenerated = Number(msg.tokens_generated ?? msg.output_tokens ?? 0);
    const ttftMs = Number(msg.ttft_ms ?? 0);
    const tpotMs = Number(msg.tpot_ms ?? 0);
    const attestationHash = typeof msg.attestation_hash === "string" ? msg.attestation_hash : null;

    pending.resolve({ content, tokensGenerated, ttftMs, tpotMs, attestationHash });
    this.tryDispatchAllIdle();
    this.broadcastStats();
  }

  private failJob(msg: Record<string, unknown>) {
    const jobId = String(msg.job_id ?? "");
    const pending = this.pending.get(jobId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pending.delete(jobId);

    const session = pending.assignedAddress
      ? this.sessions.get(pending.assignedAddress)
      : undefined;
    if (session) session.status = "idle";

    pending.reject(new Error(String(msg.error ?? "Job failed")));
    this.tryDispatchAllIdle();
    this.broadcastStats();
  }

  /** Dispatch chat job — prefer live WS worker, else queue. */
  dispatch(payload: DispatchJobPayload): Promise<JobResult> {
    const worker = this.pickIdleWorker(payload.slaTier);
    if (worker) {
      return this.assignToWorker(worker, payload);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(payload.jobId);
        const idx = this.queue.findIndex((q) => q.payload.jobId === payload.jobId);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new Error("Job timed out waiting for worker"));
      }, JOB_TIMEOUT_MS);

      this.pending.set(payload.jobId, { payload, resolve, reject, timer });
      this.queue.push({ payload });
      this.broadcastStats();
    });
  }

  private assignToWorker(session: WsWorkerSession, payload: DispatchJobPayload): Promise<JobResult> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(payload.jobId);
        session.status = "idle";
        reject(new Error("Job timed out"));
        this.tryDispatchAllIdle();
      }, JOB_TIMEOUT_MS);

      this.pending.set(payload.jobId, {
        payload,
        resolve,
        reject,
        timer,
        assignedAddress: session.address,
      });

      session.status = "busy";
      this.pushJob(session, payload);
      this.broadcastStats();
    });
  }

  private pushJob(session: WsWorkerSession, payload: DispatchJobPayload) {
    this.send(session.ws, {
      type: "job:new",
      job_id: payload.jobId,
      model: payload.model,
      messages: payload.messages,
      sla_tier: payload.slaTier,
      max_tokens: payload.maxTokens,
      confidential: payload.confidential ?? false,
    });
  }

  /** REST poll — next job for worker. */
  pollNext(workerAddress: string): DispatchJobPayload | null {
    const direct = this.queue.find((q) => q.assignedAddress === workerAddress);
    if (direct) {
      this.queue.splice(this.queue.indexOf(direct), 1);
      return direct.payload;
    }

    const worker = workersRegistry.find((w) => w.address === workerAddress);
    if (!worker || !this.registryEligible(worker)) return null;

    const openIdx = this.queue.findIndex((q) => {
      if (q.assignedAddress) return false;
      if (!worker.sla_tiers.includes(q.payload.slaTier)) return false;
      if (q.payload.confidential && !worker.tee_capable) return false;
      return true;
    });
    if (openIdx < 0) return null;

    const open = this.queue.splice(openIdx, 1)[0]!;
    open.assignedAddress = workerAddress;

    const session = this.sessions.get(workerAddress);
    if (session && session.status === "idle") {
      session.status = "busy";
      this.pushJob(session, open.payload);
    }

    return open.payload;
  }

  /** REST complete — same as WS job:complete. */
  completeFromRest(
    jobId: string,
    workerAddress: string,
    body: {
      ttft_ms: number;
      tpot_ms: number;
      output_tokens: number;
      response?: string;
      attestation_hash?: string | null;
    },
  ): boolean {
    const pending = this.pending.get(jobId);
    if (!pending) return false;
    if (pending.assignedAddress && pending.assignedAddress !== workerAddress) return false;

    this.completeJob({
      type: "job:complete",
      job_id: jobId,
      response: body.response ?? "",
      tokens_generated: body.output_tokens,
      ttft_ms: body.ttft_ms,
      tpot_ms: body.tpot_ms,
      attestation_hash: body.attestation_hash ?? null,
    });
    return true;
  }

  private registryEligible(worker: WorkerRecord): boolean {
    if (worker.status === "Active") return true;
    return worker.status === "AutoGated" && this.sessions.has(worker.address);
  }

  pickIdleWorker(slaTier: string, confidential = false): WsWorkerSession | null {
    const candidates = [...this.sessions.values()].filter((s) => {
      if (s.status !== "idle") return false;
      const w = workersRegistry.find((r) => r.address === s.address);
      return (
        w
        && this.registryEligible(w)
        && w.sla_tiers.includes(slaTier)
        && (!confidential || w.tee_capable)
      );
    });
    if (!candidates.length) return null;
    return candidates.sort((a, b) => b.tokPerSec - a.tokPerSec)[0]!;
  }

  getIdleSession(address: string): WsWorkerSession | null {
    const session = this.sessions.get(address);
    if (!session || session.status !== "idle") return null;
    const worker = workersRegistry.find((w) => w.address === address);
    if (!worker || !this.registryEligible(worker)) return null;
    return session;
  }

  isConnected(address: string): boolean {
    return this.sessions.has(address);
  }

  getConnectionInfo(address: string): {
    ws_online: boolean;
    ws_worker_type: WorkerConnectionType | null;
    ws_busy: boolean;
    ws_model: string | null;
    ws_tok_per_sec: number;
  } {
    const session = this.sessions.get(address);
    if (!session) {
      return {
        ws_online: false,
        ws_worker_type: null,
        ws_busy: false,
        ws_model: null,
        ws_tok_per_sec: 0,
      };
    }
    return {
      ws_online: true,
      ws_worker_type: session.type,
      ws_busy: session.status === "busy",
      ws_model: session.model,
      ws_tok_per_sec: session.tokPerSec,
    };
  }

  dispatchToWorker(address: string, payload: DispatchJobPayload): Promise<JobResult> {
    const session = this.getIdleSession(address);
    if (!session) {
      return Promise.reject(new Error(`Worker ${address.slice(0, 8)} not connected`));
    }
    return this.assignToWorker(session, payload);
  }

  hasWsWorker(slaTier: string, confidential = false): boolean {
    return this.pickIdleWorker(slaTier, confidential) !== null || this.queue.length > 0;
  }

  hasConnectedWorkers(slaTier: string, confidential = false): boolean {
    return [...this.sessions.values()].some((s) => {
      const w = workersRegistry.find((r) => r.address === s.address);
      return (
        w
        && this.registryEligible(w)
        && w.sla_tiers.includes(slaTier)
        && (!confidential || w.tee_capable)
      );
    });
  }

  /** Force-disconnect a worker WebSocket (e.g. when paused from dashboard). */
  disconnectWorker(address: string) {
    this.unregister(address);
  }

  inFlightCount(address: string): number {
    let count = 0;
    for (const pending of this.pending.values()) {
      if (pending.assignedAddress === address) count += 1;
    }
    return count;
  }

  getStats() {
    const online = this.sessions.size;
    const busy = [...this.sessions.values()].filter((s) => s.status === "busy").length;
    const browser = [...this.sessions.values()].filter((s) => s.type === "browser").length;
    const native = [...this.sessions.values()].filter((s) => s.type === "native").length;
    return {
      ws_workers_online: online,
      ws_workers_busy: busy,
      ws_browser_workers: browser,
      ws_native_workers: native,
      jobs_in_queue: this.queue.length,
      jobs_inflight: this.pending.size,
    };
  }

  private tryDispatchIdle(session: WsWorkerSession) {
    if (session.status !== "idle") return;
    const worker = workersRegistry.find((w) => w.address === session.address);
    if (!worker || worker.status !== "Active") return;

    const idx = this.queue.findIndex((q) => {
      if (q.assignedAddress && q.assignedAddress !== session.address) return false;
      if (!worker.sla_tiers.includes(q.payload.slaTier)) return false;
      if (q.payload.confidential && !worker.tee_capable) return false;
      return true;
    });
    if (idx < 0) return;

    const item = this.queue.splice(idx, 1)[0]!;
    const pending = this.pending.get(item.payload.jobId);
    if (!pending) return;

    pending.assignedAddress = session.address;
    session.status = "busy";
    this.pushJob(session, item.payload);
  }

  private tryDispatchAllIdle() {
    for (const session of this.sessions.values()) {
      if (session.status === "idle") this.tryDispatchIdle(session);
    }
  }

  private requeueWorkerJobs(address: string) {
    for (const [jobId, pending] of this.pending) {
      if (pending.assignedAddress === address) {
        clearTimeout(pending.timer);
        this.pending.delete(jobId);
        pending.reject(new Error("Worker disconnected"));
        this.queue.push({ payload: pending.payload });
      }
    }
  }

  private broadcastStats() {
    const stats = this.getStats();
    const msg = JSON.stringify({ type: "stats:update", ...stats });
    for (const session of this.sessions.values()) {
      if (session.ws.readyState === 1) session.ws.send(msg);
    }
  }

  private send(ws: WebSocket, data: Record<string, unknown>) {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
  }
}

export const workerHub = new WorkerHub();

export function createDispatchPayload(
  partial: Omit<DispatchJobPayload, "jobId"> & { jobId?: string },
): DispatchJobPayload {
  return { ...partial, jobId: partial.jobId ?? randomUUID() };
}
