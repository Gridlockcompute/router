import type { JobRecord, LiveEvent, WorkerRecord } from "./types.js";

export const jobsStore: JobRecord[] = [];
export const MAX_JOBS = 1000;

export let workersRegistry: WorkerRecord[] = [];
export let totalLockBurned = 0;
export let inflightCount = 0;

export function addLockBurned(amount: number): void {
  totalLockBurned += amount;
}

export const liveSubscribers = new Set<(event: LiveEvent) => void>();

export function setWorkersRegistry(workers: WorkerRecord[]): void {
  workersRegistry = workers;
}

export function appendJob(job: JobRecord): void {
  jobsStore.push(job);
  if (jobsStore.length > MAX_JOBS) {
    jobsStore.splice(0, jobsStore.length - MAX_JOBS);
  }
}

export function broadcastEvent(event: LiveEvent): void {
  for (const subscriber of liveSubscribers) {
    try {
      subscriber(event);
    } catch {
      liveSubscribers.delete(subscriber);
    }
  }
}
