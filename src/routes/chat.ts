import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { resolveJobAttestation, slaMetWithAttestation } from "../attestation.js";
import { config, computeFee, PENALTY_MULT, SLA_TARGETS } from "../config.js";
import { billingApplies, chargeJobFee, insufficientCreditsResponse } from "../billing/credits.js";
import { cacheSetTtl, cacheWarmCheck } from "../cache.js";
import { dbIncrementApiKeyUsage } from "../db.js";
import { getApiKeyContext, resolveApiKeyContext } from "../middleware/api-key-auth.js";
import { settleJob, watcherSample } from "../settlement.js";
import { anchorAssignWorker, anchorOpenJob } from "../solana-settlement.js";
import { appendJob } from "../state.js";
import { createDispatchPayload, workerHub } from "../ws/hub.js";
import { noWorkerResponse } from "../tee-capacity.js";
import { hashPrefix, pickDecodeWorker, pickPrefillWorker } from "../workers.js";
import type { ApiKeyContext, ChatCompletionRequest, JobRecord, WorkerRecord } from "../types.js";

export const chatRoutes = new Hono();

async function* readSseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) yield line;
  }
  if (buffer) yield buffer;
}

function buildVllmPayload(req: ChatCompletionRequest) {
  return {
    model: req.model,
    messages: req.messages,
    stream: true,
    max_tokens: req.max_tokens ?? 512,
    temperature: req.temperature ?? 1.0,
  };
}

function vllmHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.vllmApiKey) headers.Authorization = `Bearer ${config.vllmApiKey}`;
  return headers;
}

function createJobRecord(
  partial: Omit<JobRecord, "status"> & { status?: string },
): JobRecord {
  return { status: "settling", ...partial };
}

function billingFields(
  apiKey: ApiKeyContext | undefined,
  promptTokens: number,
  completionTokens: number,
): Pick<
  JobRecord,
  "owner_wallet" | "api_key_id" | "prompt_tokens" | "completion_tokens" | "escrow_customer_wallet"
> {
  const ownerWallet = apiKey?.owner_wallet ?? null;
  return {
    owner_wallet: ownerWallet,
    api_key_id: apiKey?.source === "database" ? apiKey.id : null,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    escrow_customer_wallet:
      config.perCustomerEscrowTracking && ownerWallet ? ownerWallet : null,
  };
}

function finalizeAttestation(params: {
  confidential: boolean;
  worker: WorkerRecord;
  jobId: string;
  response: string;
  workerAttestationHash?: string | null;
  ttftMs: number;
  tpotMs: number;
  targetTtft: number;
  targetTpot: number;
}) {
  const latencyMet = params.ttftMs <= params.targetTtft && params.tpotMs <= params.targetTpot;
  const attestation = resolveJobAttestation({
    confidential: params.confidential,
    worker: params.worker,
    jobId: params.jobId,
    response: params.response,
    workerAttestationHash: params.workerAttestationHash,
  });
  const slaMet = slaMetWithAttestation(latencyMet, params.confidential, attestation);
  return { attestation, slaMet, latencyMet };
}

chatRoutes.post("/v1/chat/completions", async (c) => {
  const req = (await c.req.json()) as ChatCompletionRequest;
  const jobId = randomUUID();

  let apiKey = getApiKeyContext(c);
  if (!apiKey) {
    const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    if (token) {
      apiKey = (await resolveApiKeyContext(token)) ?? undefined;
    }
  }

  const slaFromRequest =
    req.gridlock?.sla && SLA_TARGETS[req.gridlock.sla] ? req.gridlock.sla : null;
  const slaTier =
    slaFromRequest
    ?? (apiKey?.default_sla && SLA_TARGETS[apiKey.default_sla] ? apiKey.default_sla : "standard");

  let confidential = (req.gridlock?.privacy ?? false) || slaTier === "confidential";
  if (apiKey?.tee_required && !confidential) {
    return c.json(
      { error: "This API key requires confidential (TEE) requests. Set gridlock.privacy: true." },
      403,
    );
  }
  if (apiKey?.tee_required) confidential = true;

  const prompt = req.messages.map((m) => m.content).join(" ");
  const promptTokens = prompt.split(/\s+/).filter(Boolean).length;
  const fee = computeFee(req.model, slaTier, promptTokens);
  const targetTtft = SLA_TARGETS[slaTier]!.ttft;
  const targetTpot = SLA_TARGETS[slaTier]!.tpot;
  const auth = c.req.header("Authorization") ?? "";
  const customer =
    (apiKey?.owner_wallet ?? auth.replace(/^Bearer\s+/i, "").slice(0, 12)) || "anonymous";

  if (apiKey?.source === "database") {
    void dbIncrementApiKeyUsage(apiKey.id);
  }

  if (billingApplies(apiKey)) {
    const wallet = apiKey!.owner_wallet;
    const charge = await chargeJobFee(wallet, fee, jobId);
    if (!charge.ok) {
      return c.json(insufficientCreditsResponse(charge.balance, fee), 402);
    }
  }

  const prefixKey = hashPrefix(prompt);
  const warm = await cacheWarmCheck(prefixKey);

  const worker = pickPrefillWorker(slaTier, confidential, warm);
  if (!worker) {
    return c.json(noWorkerResponse(confidential), 503);
  }
  const workerAddress = worker.address;

  const tryWsDispatch = !req.stream && workerHub.getIdleSession(worker.address);

  async function anchorJobOnChain(): Promise<void> {
    if (!config.solanaSettlementEnabled) return;
    try {
      await anchorOpenJob(jobId, slaTier, fee, confidential);
      await anchorAssignWorker(jobId, workerAddress);
    } catch (err) {
      console.log(`[chat] solana anchor failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (tryWsDispatch) {
    await anchorJobOnChain();

    const acceptTs = performance.now();
    try {
      const dispatch = createDispatchPayload({
        jobId,
        model: req.model,
        messages: req.messages,
        slaTier,
        maxTokens: req.max_tokens ?? 512,
        customer,
        confidential,
      });

      const result = await workerHub.dispatchToWorker(worker.address, dispatch);
      const decodeWorker = pickDecodeWorker(slaTier, confidential);
      const ttftMs = result.ttftMs || Math.floor(performance.now() - acceptTs);
      const tpotMs = result.tpotMs || 0;
      const { attestation, slaMet } = finalizeAttestation({
        confidential,
        worker,
        jobId,
        response: result.content,
        workerAttestationHash: result.attestationHash,
        ttftMs,
        tpotMs,
        targetTtft,
        targetTpot,
      });
      const penalty = slaMet ? null : fee * PENALTY_MULT[slaTier]!;

      await cacheSetTtl(prefixKey, worker.address);

      const jobRecord = createJobRecord({
        id: jobId,
        customer,
        model: req.model,
        sla_tier: slaTier,
        ttft_ms: ttftMs,
        tpot_ms: tpotMs,
        sla_met: slaMet,
        confidential,
        worker: worker.address.slice(0, 8),
        worker_address: worker.address,
        decode_worker: decodeWorker?.address.slice(0, 8) ?? null,
        ts: Date.now() / 1000,
        penalty_paid: penalty,
        fee,
        cache_warm: warm !== null,
        attestation_hash: attestation.hash,
        ...billingFields(apiKey, promptTokens, result.tokensGenerated),
      });
      appendJob(jobRecord);
      void settleJob(jobId, slaTier, ttftMs, tpotMs, slaMet, confidential, worker, fee, attestation.hash);
      watcherSample(jobId, ttftMs);

      return c.json({
        id: `chatcmpl-${jobId}`,
        object: "chat.completion",
        model: req.model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: result.content || "(no response)" },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: result.tokensGenerated,
          total_tokens: promptTokens + result.tokensGenerated,
        },
        gridlock: {
          job_id: jobId,
          ttft_ms: ttftMs,
          tpot_ms: tpotMs,
          sla_tier: slaTier,
          sla_met: slaMet,
          sla_target_ttft_ms: targetTtft,
          worker: worker.address,
          decode_worker: decodeWorker?.address ?? null,
          confidential,
          penalty_due_lock: penalty,
          fee_lock: fee,
          cache_warm: warm !== null,
          attestation_hash: attestation.hash,
        },
      });
    } catch (err) {
      console.log(`[chat] WS dispatch failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  const decodeWorker = pickDecodeWorker(slaTier, confidential);
  const vllmPayload = buildVllmPayload(req);

  await anchorJobOnChain();

  if (req.stream) {
    return streamSSE(c, async (stream) => {
      const acceptTs = performance.now();
      let firstTs: number | null = null;
      let tokenCount = 0;

      try {
        const resp = await fetch(`${worker.endpoint}/v1/chat/completions`, {
          method: "POST",
          headers: vllmHeaders(),
          body: JSON.stringify(vllmPayload),
          signal: AbortSignal.timeout(60_000),
        });

        if (resp.ok && resp.body) {
          for await (const line of readSseLines(resp.body)) {
            if (!line.startsWith("data:")) continue;
            const chunk = line.slice(5).trim();
            if (chunk === "[DONE]") {
              await stream.writeSSE({ data: "[DONE]" });
              break;
            }
            if (firstTs === null) firstTs = performance.now();
            tokenCount += 1;
            await stream.writeSSE({ data: chunk });
          }
        } else {
          throw new Error("upstream error");
        }
      } catch {
        if (firstTs === null) firstTs = performance.now();
        const stub = JSON.stringify({
          id: `chatcmpl-${jobId}`,
          object: "chat.completion.chunk",
          model: req.model,
          choices: [{ index: 0, delta: { content: "vLLM not connected." }, finish_reason: "stop" }],
        });
        await stream.writeSSE({ data: stub });
        await stream.writeSSE({ data: "[DONE]" });
      }

      const ttftMs = firstTs !== null ? Math.floor(firstTs - acceptTs) : 0;
      const responseText = "streamed";
      const { attestation, slaMet } = finalizeAttestation({
        confidential,
        worker,
        jobId,
        response: responseText,
        ttftMs,
        tpotMs: 0,
        targetTtft,
        targetTpot,
      });
      const rec = createJobRecord({
        id: jobId,
        customer,
        model: req.model,
        sla_tier: slaTier,
        ttft_ms: ttftMs,
        tpot_ms: 0,
        sla_met: slaMet,
        confidential,
        worker: worker.address.slice(0, 8),
        worker_address: worker.address,
        decode_worker: decodeWorker?.address.slice(0, 8) ?? null,
        ts: Date.now() / 1000,
        penalty_paid: slaMet ? null : Math.round(fee * PENALTY_MULT[slaTier]! * 10000) / 10000,
        fee,
        cache_warm: warm !== null,
        attestation_hash: attestation.hash,
        ...billingFields(apiKey, promptTokens, tokenCount),
      });
      appendJob(rec);
      await cacheSetTtl(prefixKey, worker.address);
      void settleJob(jobId, slaTier, ttftMs, 0, slaMet, confidential, worker, fee, attestation.hash);
      watcherSample(jobId, ttftMs);
    });
  }

  const acceptTs = performance.now();
  let firstTokenTs: number | null = null;
  const tokens: string[] = [];
  let ttftMs = 0;
  let tpotMs = 0;

  try {
    const resp = await fetch(`${worker.endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: vllmHeaders(),
      body: JSON.stringify(vllmPayload),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.log(`[backend] HTTP ${resp.status}: ${text.slice(0, 200)}`);
      tokens.push(`Backend error ${resp.status}`);
      firstTokenTs = performance.now();
      ttftMs = Math.floor(firstTokenTs - acceptTs);
    } else if (resp.body) {
      for await (const line of readSseLines(resp.body)) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (raw === "[DONE]") break;
        const now = performance.now();
        if (firstTokenTs === null) {
          firstTokenTs = now;
          ttftMs = Math.floor(now - acceptTs);
        }
        try {
          const data = JSON.parse(raw) as { choices?: { delta?: { content?: string } }[] };
          const text = data.choices?.[0]?.delta?.content ?? "";
          if (text) tokens.push(text);
        } catch {
          /* ignore malformed chunk */
        }
      }
    }
  } catch {
    await new Promise((r) => setTimeout(r, 150));
    firstTokenTs = performance.now();
    ttftMs = Math.floor(firstTokenTs - acceptTs);
    for (const t of ["Gridlock ", "router ", "running. ", "vLLM ", "not ", "connected."]) {
      await new Promise((r) => setTimeout(r, 20));
      tokens.push(t);
    }
    tpotMs = 20;
  }

  if (firstTokenTs !== null && tokens.length > 1) {
    tpotMs = Math.floor(((performance.now() - firstTokenTs) / Math.max(tokens.length, 1)) * 1000);
  }

  const responseText = tokens.join("") || "(no response)";
  const { attestation, slaMet } = finalizeAttestation({
    confidential,
    worker,
    jobId,
    response: responseText,
    ttftMs,
    tpotMs,
    targetTtft,
    targetTpot,
  });
  const penalty = slaMet ? null : fee * PENALTY_MULT[slaTier]!;

  await cacheSetTtl(prefixKey, worker.address);

  const jobRecord = createJobRecord({
    id: jobId,
    customer,
    model: req.model,
    sla_tier: slaTier,
    ttft_ms: ttftMs,
    tpot_ms: tpotMs,
    sla_met: slaMet,
    confidential,
    worker: worker.address.slice(0, 8),
    worker_address: worker.address,
    decode_worker: decodeWorker?.address.slice(0, 8) ?? null,
    ts: Date.now() / 1000,
    penalty_paid: penalty,
    fee,
    cache_warm: warm !== null,
    attestation_hash: attestation.hash,
    ...billingFields(apiKey, promptTokens, tokens.length),
  });
  appendJob(jobRecord);

  void settleJob(jobId, slaTier, ttftMs, tpotMs, slaMet, confidential, worker, fee, attestation.hash);
  watcherSample(jobId, ttftMs);

  return c.json({
    id: `chatcmpl-${jobId}`,
    object: "chat.completion",
    model: req.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: responseText },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: tokens.length,
      total_tokens: promptTokens + tokens.length,
    },
    gridlock: {
      job_id: jobId,
      ttft_ms: ttftMs,
      tpot_ms: tpotMs,
      sla_tier: slaTier,
      sla_met: slaMet,
      sla_target_ttft_ms: targetTtft,
      worker: worker.address,
      decode_worker: decodeWorker?.address ?? null,
      confidential,
      penalty_due_lock: penalty,
      fee_lock: fee,
      cache_warm: warm !== null,
      attestation_hash: attestation.hash,
    },
  });
});
