import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  explainOffline,
  interpretOffline,
  parseScenario,
  type ExplainRequest,
  type ExplainResult,
  type InterpretResult,
  type Scenario,
} from "@physicslab/shared";
import { AiError, type AiProvider } from "./ai/provider";
import type { Config } from "./config";
import { RateLimiter } from "./rateLimit";

const InterpretBody = z.object({
  message: z.string().trim().min(1, "Describe a scenario first.").max(4000, "Please keep descriptions under 4000 characters."),
  scenario: z.unknown().optional(),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(8000) }))
    .max(40)
    .optional(),
  /** Force the rule-based interpreter even when AI is available. */
  offline: z.boolean().optional(),
});

const PredictionSummary = z.object({
  id: z.string(),
  label: z.string(),
  value: z.number(),
  unit: z.string(),
  measured: z.number().nullable().optional(),
});

const ExplainBody = z.object({
  scenario: z.unknown(),
  metrics: z.unknown().optional(),
  predictions: z.array(PredictionSummary).max(50).optional(),
  previous: z
    .object({ scenario: z.unknown(), metrics: z.unknown().optional(), predictions: z.array(PredictionSummary).max(50).optional() })
    .nullable()
    .optional(),
  question: z.string().max(2000).optional(),
  offline: z.boolean().optional(),
});

export interface AppOptions {
  config: Config;
  ai: AiProvider | null;
  /** Directory with the built client to serve (optional). */
  staticDir?: string | null;
  log?: (msg: string) => void;
}

function scenarioOrNull(raw: unknown): Scenario | null {
  if (raw === undefined || raw === null) return null;
  const parsed = parseScenario(raw);
  return parsed.ok ? parsed.scenario : null;
}

export function defaultStaticDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = path.resolve(here, "../../client/dist");
  return existsSync(path.join(dir, "index.html")) ? dir : null;
}

export function createApp({ config, ai, staticDir = defaultStaticDir(), log = () => {} }: AppOptions) {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", "loopback");
  app.use(express.json({ limit: "2mb" }));
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    if (config.corsOrigin && req.path.startsWith("/api/")) {
      res.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
    }
    next();
  });

  const limiter = new RateLimiter(config.rateLimitPerMinute);
  const aiInfo = () => ({ enabled: !!ai, model: ai?.model ?? null, effort: ai ? config.interpretEffort : null });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, ai: aiInfo() });
  });

  app.post("/api/interpret", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = InterpretBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid request." });
        return;
      }
      const { message, history, offline } = body.data;
      const scenario = scenarioOrNull(body.data.scenario);
      let result: InterpretResult;
      if (ai && !offline) {
        const wait = limiter.take(req.ip ?? "unknown");
        if (wait > 0) {
          result = { ...interpretOffline(message, scenario), fallback_reason: `AI rate limit reached — using the offline interpreter for the next ${wait} s.` };
        } else {
          try {
            result = await ai.interpret({ message, scenario, history });
          } catch (err) {
            const reason = err instanceof AiError ? err.message : "The AI interpreter failed.";
            log(`interpret fell back to offline: ${err instanceof Error ? err.message : String(err)}`);
            result = { ...interpretOffline(message, scenario), fallback_reason: reason };
          }
        }
      } else {
        result = interpretOffline(message, scenario);
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/explain", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = ExplainBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: body.error.issues[0]?.message ?? "Invalid request." });
        return;
      }
      const scenario = scenarioOrNull(body.data.scenario);
      if (!scenario) {
        res.status(400).json({ error: "A valid scenario is required." });
        return;
      }
      const prevScenario = body.data.previous ? scenarioOrNull(body.data.previous.scenario) : null;
      const request: ExplainRequest = {
        scenario,
        metrics: (body.data.metrics as ExplainRequest["metrics"]) ?? null,
        predictions: body.data.predictions,
        previous: prevScenario
          ? {
              scenario: prevScenario,
              metrics: (body.data.previous?.metrics as ExplainRequest["metrics"]) ?? null,
              predictions: body.data.previous?.predictions,
            }
          : null,
        question: body.data.question,
      };
      let result: ExplainResult;
      if (ai && !body.data.offline && limiter.take(req.ip ?? "unknown") === 0) {
        try {
          result = await ai.explain(request);
        } catch (err) {
          log(`explain fell back to offline: ${err instanceof Error ? err.message : String(err)}`);
          result = explainOffline(request);
        }
      } else result = explainOffline(request);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  if (staticDir) {
    app.use(express.static(staticDir, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log(`unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    if ((err as { type?: string })?.type === "entity.too.large") {
      res.status(413).json({ error: "Request too large." });
      return;
    }
    res.status(500).json({ error: "Something went wrong on the server." });
  });

  return app;
}
