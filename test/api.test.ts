/**
 * Gridlock Router — API test suite
 * Run: npm run test:api [-- --base http://localhost:8080] [--key sk-grid-yourkey]
 */

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1]! : fallback;
}

const BASE = getArg("--base", "http://localhost:8080");
const KEY = getArg("--key", "");
const HEADERS: Record<string, string> = KEY ? { Authorization: `Bearer ${KEY}` } : {};

const PASS = "\x1b[92m PASS\x1b[0m";
const FAIL = "\x1b[91m FAIL\x1b[0m";
const results: [string, boolean, string][] = [];

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  [${ok ? PASS : FAIL}] ${name}${detail ? ` — ${detail}` : ""}`);
  results.push([name, ok, detail]);
}

async function run(): Promise<void> {
  // ── Health ────────────────────────────────────────────────────────────
  console.log("\n── /health");
  let r = await fetch(`${BASE}/health`, { headers: HEADERS });
  let d = await r.json();
  check("status 200", r.status === 200);
  check("status=ok", d.status === "ok");
  check("programs key", "programs" in d);

  // ── Network stats ─────────────────────────────────────────────────────
  console.log("\n── /v1/network/stats");
  r = await fetch(`${BASE}/v1/network/stats`, { headers: HEADERS });
  d = await r.json();
  check("status 200", r.status === 200);
  for (const field of [
    "active_workers",
    "idle_workers",
    "tee_workers",
    "jobs_total",
    "jobs_1h",
    "sla_pass_rate",
    "p99_ttft_ms",
    "total_penalties_lock",
    "confidential_share",
    "lock_burned",
  ]) {
    check(`field: ${field}`, field in d);
  }

  // ── Workers ───────────────────────────────────────────────────────────
  console.log("\n── /v1/workers");
  r = await fetch(`${BASE}/v1/workers`, { headers: HEADERS });
  d = await r.json();
  check("status 200", r.status === 200);
  check("has workers", (d.total ?? 0) > 0);

  check("tee filter", (await fetch(`${BASE}/v1/workers?tee_capable=true`, { headers: HEADERS })).status === 200);
  check("status filter", (await fetch(`${BASE}/v1/workers?status=Active`, { headers: HEADERS })).status === 200);

  const firstAddr = d.workers?.[0]?.address as string | undefined;
  if (firstAddr) {
    const detail = await fetch(`${BASE}/v1/workers/${firstAddr.slice(0, 8)}`, { headers: HEADERS });
    const detailJson = await detail.json();
    check("worker detail", detail.status === 200);
    check("recent_jobs key", "recent_jobs" in detailJson);
  }

  // ── Jobs ──────────────────────────────────────────────────────────────
  console.log("\n── /v1/jobs");
  r = await fetch(`${BASE}/v1/jobs`, { headers: HEADERS });
  d = await r.json();
  check("status 200", r.status === 200);
  check("has jobs", (d.total ?? 0) > 0);
  check("sla_tier filter", (await fetch(`${BASE}/v1/jobs?sla_tier=realtime`, { headers: HEADERS })).status === 200);
  check("sla_met filter", (await fetch(`${BASE}/v1/jobs?sla_met=false`, { headers: HEADERS })).status === 200);

  const firstJobId = d.jobs?.[0]?.id as string | undefined;
  if (firstJobId) check("job detail", (await fetch(`${BASE}/v1/jobs/${firstJobId}`, { headers: HEADERS })).status === 200);
  check("404 on bad id", (await fetch(`${BASE}/v1/jobs/nonexistent-id-000`, { headers: HEADERS })).status === 404);

  // ── Leaderboard ───────────────────────────────────────────────────────
  console.log("\n── /v1/leaderboard");
  for (const metric of ["goodput", "reliability", "confidential", "earnings"]) {
    const lb = await fetch(`${BASE}/v1/leaderboard?metric=${metric}`, { headers: HEADERS });
    const lbJson = await lb.json();
    check(`metric=${metric}`, lb.status === 200 && "ranked" in lbJson);
  }

  // ── Chat completions — non-streaming ──────────────────────────────────
  console.log("\n── /v1/chat/completions (non-streaming)");
  const t0 = performance.now();
  r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.1-8b",
      messages: [{ role: "user", content: "Say hello" }],
      stream: false,
      gridlock: { sla: "standard", privacy: false },
    }),
  });
  const elapsed = Math.floor(performance.now() - t0);
  d = await r.json();
  check("status 200", r.status === 200, `${elapsed}ms`);
  check("choices key", "choices" in d);
  check("gridlock key", "gridlock" in d);
  check("job_id present", "job_id" in (d.gridlock ?? {}));
  check("ttft_ms present", "ttft_ms" in (d.gridlock ?? {}));
  check("fee_lock present", "fee_lock" in (d.gridlock ?? {}));

  // ── Chat completions — realtime tier ──────────────────────────────────
  console.log("\n── /v1/chat/completions (realtime SLA)");
  r = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.1-70b",
      messages: [{ role: "user", content: "ping" }],
      gridlock: { sla: "realtime" },
    }),
  });
  d = await r.json();
  check("status 200", r.status === 200);
  check("sla_tier=realtime", d.gridlock?.sla_tier === "realtime");
  check("fee > standard", (d.gridlock?.fee_lock ?? 0) > 0.05);

  // ── Worker register + heartbeat ───────────────────────────────────────
  console.log("\n── /v1/workers/register + heartbeat");
  const testAddr = "TestWorkerGridlockAAAAAAAAAAAAAAAAAAAAAAAAAA";
  r = await fetch(`${BASE}/v1/workers/register`, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({
      operator_pubkey: testAddr,
      role: "Prefill",
      hardware_tier: "RTX 4090",
      tee_capable: false,
    }),
  });
  d = await r.json();
  check("register 200", r.status === 200);
  check("success=true", d.success === true);

  const dup = await fetch(`${BASE}/v1/workers/register`, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ operator_pubkey: testAddr, role: "Prefill", hardware_tier: "RTX 4090" }),
  });
  check("duplicate = 409", dup.status === 409);

  const hb = await fetch(`${BASE}/v1/workers/heartbeat`, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ worker_address: testAddr, goodput_score: 750 }),
  });
  const hbJson = await hb.json();
  check("heartbeat 200", hb.status === 200);
  check("status Active", hbJson.status === "Active");

  check(
    "heartbeat 404",
    (
      await fetch(`${BASE}/v1/workers/heartbeat`, {
        method: "POST",
        headers: { ...HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ worker_address: "nonexistent" }),
      })
    ).status === 404,
  );

  console.log("\n" + "─".repeat(50));
  const passed = results.filter(([, ok]) => ok).length;
  console.log(`  ${passed}/${results.length} passed`);
  if (passed < results.length) {
    console.log("\n  Failed:");
    for (const [name, ok, detail] of results) {
      if (!ok) console.log(`    ✗ ${name} ${detail}`);
    }
    process.exit(1);
  }
  console.log("  All tests passed.");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
