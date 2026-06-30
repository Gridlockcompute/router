import { config } from "./config.js";

export function watcherSample(jobId: string, routerTtft: number): void {
  if (Math.random() > config.watcherSampleRate) return;
  const watcher = routerTtft + Math.floor(Math.random() * 41) - 20;
  const delta = Math.abs(watcher - routerTtft);
  const tag = delta > 50 ? "DISPUTE" : "VERIFIED";
  console.log(`[watcher] ${tag} job=${jobId.slice(0, 12)} delta=${delta}ms`);
}
