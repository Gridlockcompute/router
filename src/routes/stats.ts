import { Hono } from "hono";
import { getCacheStats, getRedis, redisStatus } from "../cache.js";
import { config, PROGRAM_IDS } from "../config.js";
import { supabaseConfigured } from "../db.js";
import { getRecentSlots } from "../solana.js";
import { workersRegistry } from "../state.js";
import { getTeeCapacity } from "../tee-capacity.js";
import { inflightCount, jobsStore, totalLockBurned } from "../state.js";

export const statsRoutes = new Hono();

statsRoutes.get("/health", async (c) => {
  const slot = await getRecentSlots();
  const active = workersRegistry.filter((w) => w.status === "Active");
  const redis = await getRedis();
  return c.json({
    status: "ok",
    active_workers: active.length,
    total_workers: workersRegistry.length,
    jobs_tracked: jobsStore.length,
    solana_slot: slot,
    solana_rpc: config.solanaRpcUrl,
    redis: redisStatus(Boolean(redis)),
    supabase: supabaseConfigured() ? "configured" : "not configured",
    programs: {
      provider_registry: PROGRAM_IDS.providerRegistry,
      job_scheduler: PROGRAM_IDS.jobScheduler,
      sla_registry: PROGRAM_IDS.slaRegistry,
      sla_enforcer: PROGRAM_IDS.slaEnforcer,
      fee_collector: PROGRAM_IDS.feeCollector,
    },
  });
});

statsRoutes.get("/v1/network/stats", async (c) => {
  const now = Date.now() / 1000;
  const active = workersRegistry.filter((w) => w.status === "Active");
  const idle = workersRegistry.filter((w) => w.status === "Paused");
  const jobs = [...jobsStore];
  const hour = jobs.filter((j) => now - j.ts < 3600);
  const today = jobs.filter((j) => now - j.ts < 86400);

  const passRate = Math.round((today.filter((j) => j.sla_met).length / Math.max(today.length, 1)) * 1000) / 10;
  const penalties = jobs.reduce((sum, j) => sum + (j.penalty_paid ?? 0), 0);
  const p99 = hour.slice(-100).reduce((max, j) => Math.max(max, j.ttft_ms), 0) || 245;
  const cacheStats = await getCacheStats();
  const warmRate = Math.round((jobs.filter((j) => j.cache_warm).length / Math.max(jobs.length, 1)) * 1000) / 10;

  return c.json({
    active_workers: active.length,
    idle_workers: idle.length,
    tee_workers: active.filter((w) => w.tee_capable).length,
    jobs_total: jobs.length,
    jobs_1h: hour.length,
    sla_pass_rate: passRate,
    p99_ttft_ms: p99,
    total_penalties_lock: Math.round(penalties * 10000) / 10000,
    confidential_share: Math.round((hour.filter((j) => j.confidential).length / Math.max(hour.length, 1)) * 1000) / 10,
    lock_burned: Math.round(totalLockBurned * 10000) / 10000,
    total_workers: workersRegistry.length,
    requests_today: today.length,
    cache_hit_entries: cacheStats.entries,
    cache_hit_rate: cacheStats.hit_rate,
    warm_path_rate: warmRate,
    prefill_workers: active.filter((w) => w.role === "Prefill").length,
    decode_workers: active.filter((w) => w.role === "Decode").length,
  });
});

statsRoutes.get("/v1/leaderboard", (c) => {
  const metric = c.req.query("metric") ?? "goodput";
  const limit = Math.min(Number(c.req.query("limit") ?? 25), 100);
  const workers = workersRegistry.map((w) => ({ ...w }));

  let ranked: typeof workers;
  if (metric === "reliability") {
    ranked = workers.sort((a, b) => b.reliability_score - a.reliability_score);
  } else if (metric === "confidential") {
    ranked = workers.sort(
      (a, b) => Number(b.is_confidential) - Number(a.is_confidential) || b.goodput_score - a.goodput_score,
    );
  } else if (metric === "earnings") {
    ranked = workers.sort((a, b) => b.earnings_today - a.earnings_today);
  } else {
    ranked = workers.sort((a, b) => b.goodput_score - a.goodput_score);
  }

  ranked.forEach((w, i) => {
    const rank = i + 1;
    const base = metric === "goodput" ? w.goodput_score * 10 : w.reliability_score;
    w.grid_points = Math.max(0, Math.floor(base / (rank * 0.5)));
  });

  return c.json({ metric, ranked: ranked.slice(0, limit), total: ranked.length });
});

statsRoutes.get("/v1/autoscale/signal", (c) => {
  const active = workersRegistry.filter((w) => w.status === "Active");
  const jobsHour = jobsStore.filter((j) => Date.now() / 1000 - j.ts < 3600);
  const recent = jobsHour.slice(-50);
  const avgTtft = recent.length ? recent.reduce((s, j) => s + j.ttft_ms, 0) / recent.length : 0;
  const p99Ttft = jobsHour.slice(-100).reduce((max, j) => Math.max(max, j.ttft_ms), 0);

  const prefillWorkers = active.filter((w) => w.role === "Prefill");
  const decodeWorkers = active.filter((w) => w.role === "Decode");
  const cacheWorkers = active.filter((w) => w.role === "Cache");

  const ttftPressure = p99Ttft ? Math.min(p99Ttft / 300, 1) : 0;
  const queuePressure = Math.min(inflightCount / Math.max(active.length, 1) / 5, 1);
  const overallPressure = Math.round(Math.max(ttftPressure, queuePressure) * 1000) / 1000;

  let recommendation = "stable";
  if (overallPressure > 0.8) recommendation = "scale_up_prefill";
  else if (overallPressure > 0.6) recommendation = "scale_up_decode";
  else if (overallPressure < 0.2 && active.length > 10) recommendation = "scale_down";

  return c.json({
    overall_pressure: overallPressure,
    ttft_pressure: Math.round(ttftPressure * 1000) / 1000,
    queue_pressure: Math.round(queuePressure * 1000) / 1000,
    inflight_jobs: inflightCount,
    active_workers: active.length,
    prefill_workers: prefillWorkers.length,
    decode_workers: decodeWorkers.length,
    cache_workers: cacheWorkers.length,
    avg_ttft_ms: Math.round(avgTtft),
    p99_ttft_ms: p99Ttft,
    recommendation,
    scale_target: {
      prefill: Math.max(prefillWorkers.length, Math.floor(active.length * 0.5)),
      decode: Math.max(decodeWorkers.length, Math.floor(active.length * 0.35)),
      cache: Math.max(cacheWorkers.length, Math.floor(active.length * 0.1)),
    },
  });
});

statsRoutes.get("/v1/models", (c) => {
  const models = [
    {
      id: "llama-3.1-8b-instant",
      provider: "Meta via Groq",
      context_window: 131072,
      parameters: "8B",
      base_fee_lock_per_1m: 2.0,
      tier_multipliers: { batch: 0.4, standard: 1.0, realtime: 2.0, confidential: 2.5 },
    },
    {
      id: "llama-3.1-70b-versatile",
      provider: "Meta via Groq",
      context_window: 131072,
      parameters: "70B",
      base_fee_lock_per_1m: 8.0,
      tier_multipliers: { batch: 0.4, standard: 1.0, realtime: 2.0, confidential: 2.5 },
    },
    {
      id: "mixtral-8x7b-32768",
      provider: "Mistral via Groq",
      context_window: 32768,
      parameters: "56B (MoE)",
      base_fee_lock_per_1m: 2.0,
      tier_multipliers: { batch: 0.4, standard: 1.0, realtime: 2.0, confidential: 2.5 },
    },
  ];
  return c.json({ models, total: models.length });
});

statsRoutes.get("/v1/capacity/tee", (c) => {
  return c.json(getTeeCapacity(workersRegistry));
});

statsRoutes.get("/v1/stats/cache", async (c) => {
  const stats = await getCacheStats();
  return c.json({
    ...stats,
    cache_ttl_secs: 3600,
    strategy: "prompt-prefix SHA-256 (first 256 chars)",
  });
});

statsRoutes.get("/v1/stats/pd", (c) => {
  const prefillWorkers = workersRegistry.filter((w) => w.role === "Prefill" && w.status === "Active");
  const decodeWorkers = workersRegistry.filter((w) => w.role === "Decode" && w.status === "Active");
  const cacheWorkers = workersRegistry.filter((w) => w.role === "Cache" && w.status === "Active");
  const routerWorkers = workersRegistry.filter((w) => w.role === "Router" && w.status === "Active");

  const jobs = [...jobsStore];
  const warmHits = jobs.filter((j) => j.cache_warm).length;
  const totalJobs = jobs.length;

  return c.json({
    prefill_workers: prefillWorkers.length,
    decode_workers: decodeWorkers.length,
    cache_workers: cacheWorkers.length,
    router_workers: routerWorkers.length,
    warm_cache_hits: warmHits,
    warm_cache_rate: totalJobs ? Math.round((warmHits / totalJobs) * 1000) / 10 : 0,
    total_jobs: totalJobs,
    avg_prefill_goodput: prefillWorkers.length
      ? Math.round(prefillWorkers.reduce((s, w) => s + w.goodput_score, 0) / prefillWorkers.length)
      : 0,
    avg_decode_reliability: decodeWorkers.length
      ? Math.round(decodeWorkers.reduce((s, w) => s + w.reliability_score, 0) / decodeWorkers.length)
      : 0,
  });
});
