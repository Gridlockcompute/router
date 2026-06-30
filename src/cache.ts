import { createClient } from "redis";
import { config } from "./config.js";

let redisClient: ReturnType<typeof createClient> | null = null;
let redisUnavailable = false;
const cacheIndex = new Map<string, string>();
let cacheHits = 0;
let cacheMisses = 0;

function redisErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function getRedis(): Promise<ReturnType<typeof createClient> | null> {
  if (redisClient) return redisClient;
  if (redisUnavailable || !config.redisUrl) return null;
  try {
    const client = createClient({
      url: config.redisUrl,
      socket: {
        connectTimeout: 2000,
        reconnectStrategy: () => false,
      },
    });
    client.on("error", () => {});
    await Promise.race([
      client.connect().then(() => client.ping()),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("connect timeout")), 2500)),
    ]);
    redisClient = client;
    console.log("[redis] connected");
    return client;
  } catch (error) {
    redisUnavailable = true;
    console.log(`[redis] unavailable: ${redisErrorMessage(error)} (using in-memory cache)`);
    return null;
  }
}

export async function cacheGet(key: string): Promise<string | null> {
  const redis = await getRedis();
  if (redis) return (await redis.hGet("gridlock:cache_index", key)) ?? null;
  return cacheIndex.get(key) ?? null;
}

export async function cacheSet(key: string, value: string): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    await redis.hSet("gridlock:cache_index", key, value);
    await redis.expire("gridlock:cache_index", 3600);
  } else {
    cacheIndex.set(key, value);
  }
}

export async function cacheCount(): Promise<number> {
  const redis = await getRedis();
  if (redis) return redis.hLen("gridlock:cache_index");
  return cacheIndex.size;
}

export async function cacheGetTracked(key: string): Promise<string | null> {
  const redis = await getRedis();
  if (redis) {
    const val = await redis.hGet("gridlock:cache_index", key);
    if (val) {
      await redis.incr("gridlock:cache_hits");
      return val;
    }
    await redis.incr("gridlock:cache_misses");
    return null;
  }
  const val = cacheIndex.get(key);
  if (val) cacheHits += 1;
  else cacheMisses += 1;
  return val ?? null;
}

export async function cacheSetTtl(key: string, value: string, ttl = 3600): Promise<void> {
  const redis = await getRedis();
  if (redis) {
    await redis.hSet("gridlock:cache_index", key, value);
    await redis.set(`gridlock:warm:${key}`, value, { EX: ttl });
  } else {
    cacheIndex.set(key, value);
  }
}

export async function cacheWarmCheck(key: string): Promise<string | null> {
  const redis = await getRedis();
  if (redis) return (await redis.get(`gridlock:warm:${key}`)) ?? null;
  return cacheIndex.get(key) ?? null;
}

export async function getCacheStats(): Promise<{
  hits: number;
  misses: number;
  entries: number;
  hit_rate: number;
}> {
  const redis = await getRedis();
  if (redis) {
    const hits = Number((await redis.get("gridlock:cache_hits")) ?? 0);
    const misses = Number((await redis.get("gridlock:cache_misses")) ?? 0);
    const entries = await redis.hLen("gridlock:cache_index");
    const total = hits + misses;
    return {
      hits,
      misses,
      entries,
      hit_rate: total ? Math.round((hits / total) * 1000) / 10 : 0,
    };
  }
  const total = cacheHits + cacheMisses;
  return {
    hits: cacheHits,
    misses: cacheMisses,
    entries: cacheIndex.size,
    hit_rate: total ? Math.round((cacheHits / total) * 1000) / 10 : 0,
  };
}

export function redisStatus(connected: boolean): string {
  return connected ? "connected" : "not configured";
}
