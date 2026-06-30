import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { liveSubscribers } from "../state.js";
import type { LiveEvent } from "../types.js";

export const liveRoutes = new Hono();

liveRoutes.get("/v1/live", (c) =>
  streamSSE(c, async (stream) => {
    const queue: LiveEvent[] = [];
    let resolveWait: (() => void) | null = null;

    const subscriber = (event: LiveEvent) => {
      queue.push(event);
      resolveWait?.();
      resolveWait = null;
    };

    liveSubscribers.add(subscriber);

    try {
      while (true) {
        if (queue.length) {
          const event = queue.shift()!;
          await stream.writeSSE({ data: JSON.stringify(event) });
          continue;
        }

        await Promise.race([
          new Promise<void>((resolve) => {
            resolveWait = resolve;
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 15_000)),
        ]);

        if (!queue.length) {
          await stream.writeSSE({ event: "ping", data: "" });
        }
      }
    } finally {
      liveSubscribers.delete(subscriber);
    }
  }),
);
