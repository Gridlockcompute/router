import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "./config.js";
import "./hono-context.js";
import { getRedis } from "./cache.js";
import { dbLoadJobs, dbLoadWorkers } from "./db.js";
import { apiKeyAuthMiddleware } from "./middleware/api-key-auth.js";
import { billingRoutes } from "./routes/billing.js";
import { authRoutes } from "./routes/auth.js";
import { chatRoutes } from "./routes/chat.js";
import { jobRoutes } from "./routes/jobs.js";
import { keyRoutes } from "./routes/keys.js";
import { liveRoutes } from "./routes/live.js";
import { stakeRoutes } from "./routes/stake.js";
import { statsRoutes } from "./routes/stats.js";
import { workerRoutes } from "./routes/workers.js";
import { attachWebSocketServer } from "./ws/attach.js";
import { startInvoiceCron } from "./billing/invoice-cron.js";
import { initWorkersAndJobs, startHeartbeatWatcher } from "./workers.js";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowHeaders: ["*"],
  }),
);

app.use("*", apiKeyAuthMiddleware);

app.route("/", chatRoutes);
app.route("/", jobRoutes);
app.route("/", workerRoutes);
app.route("/", keyRoutes);
app.route("/", authRoutes);
app.route("/", billingRoutes);
app.route("/", stakeRoutes);
app.route("/", statsRoutes);
app.route("/", liveRoutes);

async function bootstrap(): Promise<void> {
  await initWorkersAndJobs(dbLoadWorkers, dbLoadJobs);
  void getRedis();
  startHeartbeatWatcher();
  startInvoiceCron();

  const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" }, (info) => {
    console.log(`Gridlock Router listening on http://localhost:${info.port}`);
  });
  attachWebSocketServer(server);
}

bootstrap().catch((error) => {
  console.error("[startup] failed:", error);
  process.exit(1);
});
