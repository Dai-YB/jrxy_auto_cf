import { boundedInt, type Env } from "./types";

export const DEFAULT_HTTP_TIMEOUT_SECONDS=60;
export const DEFAULT_RUN_TIMEOUT_SECONDS=300;

export function settings(env: Env) {
  const minutes = Number(env.RETRY_DELAY_MINUTES ?? 5);
  const offset = Number(env.TZ_OFFSET ?? 8);
  return {
    intervalMs: boundedInt(env.JRXY_INTERVAL, 10, 0, 3600) * 1000,
    retryMs: env.RETRY_DELAY_SECONDS !== undefined
      ? boundedInt(env.RETRY_DELAY_SECONDS, 300, 1, 86400) * 1000
      : (Number.isFinite(minutes) && minutes >= 0 && minutes <= 1440 ? minutes : 5) * 60_000,
    maxAttempts: 1 + boundedInt(env.MAX_RETRIES, 5, 0, 10),
    catchupMs: boundedInt(env.CATCHUP_MINUTES, 120, 1, 1440) * 60_000,
    httpTimeoutMs: boundedInt(env.JRXY_HTTP_TIMEOUT, DEFAULT_HTTP_TIMEOUT_SECONDS, 1, 120) * 1000,
    runTimeoutMs: boundedInt(env.JRXY_RUN_TIMEOUT, DEFAULT_RUN_TIMEOUT_SECONDS, 10, 600) * 1000,
    timezone: Number.isFinite(offset) && offset >= -12 && offset <= 14 ? offset : 8,
  };
}
export function localTime(time: number, offset = 8): string {
  return new Date(time + offset * 3600_000).toISOString().slice(0, 19).replace("T", " ");
}
