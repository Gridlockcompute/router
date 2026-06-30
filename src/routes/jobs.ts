import { Hono } from "hono";
import { jobsStore, workersRegistry } from "../state.js";
import { workerHub } from "../ws/hub.js";

export const jobRoutes = new Hono();

jobRoutes.get("/v1/jobs", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const offset = Number(c.req.query("offset") ?? 0);
  const slaTier = c.req.query("sla_tier");
  const slaMetRaw = c.req.query("sla_met");
  const workerFilter = c.req.query("worker");

  let jobs = [...jobsStore].reverse();
  if (slaTier) jobs = jobs.filter((j) => j.sla_tier === slaTier);
  if (slaMetRaw !== undefined) {
    const slaMet = slaMetRaw === "true";
    jobs = jobs.filter((j) => j.sla_met === slaMet);
  }
  if (workerFilter) {
    jobs = jobs.filter((j) => j.worker_address === workerFilter);
  }

  return c.json({ jobs: jobs.slice(offset, offset + limit), total: jobs.length, limit, offset });
});

/** Poll next job for a worker (HTTP fallback; WS workers receive push). */
jobRoutes.get("/v1/jobs/next", (c) => {
  const workerAddress = c.req.query("worker_address") ?? "";
  if (!workerAddress) return c.json({ error: "worker_address required" }, 400);

  const worker = workersRegistry.find((w) => w.address.startsWith(workerAddress));
  if (!worker) return c.json({ error: "Worker not found" }, 404);

  const next = workerHub.pollNext(worker.address);
  if (!next) return c.json({ job: null });

  return c.json({
    job: {
      id: next.jobId,
      model: next.model,
      messages: next.messages,
      sla_tier: next.slaTier,
      output_tokens: next.maxTokens,
      customer: next.customer,
    },
  });
});

/** Complete a polled or WS-assigned job. */
jobRoutes.post("/v1/jobs/complete", async (c) => {
  const body = (await c.req.json()) as {
    job_id: string;
    worker_address: string;
    ttft_ms: number;
    tpot_ms: number;
    output_tokens: number;
    response?: string;
  };

  if (!body.job_id || !body.worker_address) {
    return c.json({ error: "job_id and worker_address required" }, 400);
  }

  const worker = workersRegistry.find((w) => w.address.startsWith(body.worker_address));
  if (!worker) return c.json({ error: "Worker not found" }, 404);

  const ok = workerHub.completeFromRest(body.job_id, worker.address, {
    ttft_ms: body.ttft_ms,
    tpot_ms: body.tpot_ms,
    output_tokens: body.output_tokens,
    response: body.response,
  });

  if (!ok) return c.json({ error: "Job not found or not assigned to worker" }, 404);
  return c.json({ ok: true });
});

jobRoutes.get("/v1/jobs/:jobId", (c) => {
  const job = jobsStore.find((j) => j.id === c.req.param("jobId"));
  if (!job) return c.json({ error: `Job ${c.req.param("jobId")} not found` }, 404);
  return c.json(job);
});
