import {
  explainOffline,
  interpretOffline,
  type ExplainRequest,
  type ExplainResult,
  type InterpretResult,
  type Scenario,
} from "@physicslab/shared";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface InterpretRequest {
  message: string;
  scenario?: Scenario | null;
  history?: ChatTurn[];
}

export interface AiProvider {
  readonly kind: "claude" | "offline";
  readonly model?: string;
  interpret(req: InterpretRequest): Promise<InterpretResult>;
  explain(req: ExplainRequest): Promise<ExplainResult>;
}

/** Deterministic rule-based provider (no network). */
export class OfflineProvider implements AiProvider {
  readonly kind = "offline" as const;
  async interpret(req: InterpretRequest): Promise<InterpretResult> {
    return interpretOffline(req.message, req.scenario);
  }
  async explain(req: ExplainRequest): Promise<ExplainResult> {
    return explainOffline(req);
  }
}

/** An error whose message is safe to show to users. */
export class AiError extends Error {
  constructor(
    message: string,
    readonly code: "refusal" | "invalid_output" | "truncated" | "auth" | "rate_limit" | "unavailable" | "bad_request" = "unavailable",
  ) {
    super(message);
    this.name = "AiError";
  }
}
