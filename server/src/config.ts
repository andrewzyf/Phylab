import type { Effort } from "./ai/claude";

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];
const effort = (v: string | undefined, fallback: Effort): Effort => (EFFORTS.includes(v as Effort) ? (v as Effort) : fallback);

export interface Config {
  port: number;
  model: string;
  interpretEffort: Effort;
  explainEffort: Effort;
  /** Use Claude when credentials exist, unless explicitly disabled. */
  aiEnabled: boolean;
  /** AI requests allowed per client IP per minute. */
  rateLimitPerMinute: number;
  corsOrigin?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const hasCredentials = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.PHYSICSLAB_AI === "force");
  return {
    port: Number(env.PORT) || 8787,
    model: env.PHYSICSLAB_MODEL || "claude-opus-5-5",
    interpretEffort: effort(env.PHYSICSLAB_EFFORT, "medium"),
    explainEffort: effort(env.PHYSICSLAB_EXPLAIN_EFFORT, "low"),
    aiEnabled: hasCredentials && env.PHYSICSLAB_AI !== "off",
    rateLimitPerMinute: Number(env.PHYSICSLAB_RATE_LIMIT) || 20,
    corsOrigin: env.PHYSICSLAB_CORS_ORIGIN || undefined,
  };
}
