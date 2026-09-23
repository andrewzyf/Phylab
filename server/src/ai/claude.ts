import Anthropic from "@anthropic-ai/sdk";
import {
  applyChanges,
  diffScenarios,
  ExplainOutputSchema,
  InterpretOutputSchema,
  parseScenario,
  resolveScenario,
  validateScenario,
  type ExplainRequest,
  type ExplainResult,
  type InterpretResult,
  type Scenario,
  type Variation,
} from "@physicslab/shared";
import { EXPLAIN_SYSTEM, INTERPRET_SYSTEM } from "./prompts";
import { AiError, type AiProvider, type InterpretRequest } from "./provider";
import { EXPLAIN_SCHEMA, INTERPRET_SCHEMA, scenarioToWire, wireToScenarioInput } from "./wire";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** The subset of the SDK client we use (lets tests inject a fake). */
export interface MessagesClient {
  messages: {
    stream(params: Anthropic.MessageStreamParams, options?: Anthropic.RequestOptions): { finalMessage(): Promise<Anthropic.Message> };
  };
}

export interface ClaudeProviderOptions {
  client: MessagesClient;
  model: string;
  interpretEffort: Effort;
  explainEffort: Effort;
  log?: (msg: string) => void;
}

const MAX_HISTORY_TURNS = 12;

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("The model did not return JSON.");
  }
}

function usableVariations(scenario: Scenario | null, variations: Variation[]): Variation[] {
  if (!scenario) return [];
  return variations.filter((v) => {
    if (!v.changes.length) return false;
    try {
      applyChanges(scenario, v.changes);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * PhysicsLab's interpreter backed by Claude. Uses structured outputs (a JSON schema) so the reply is
 * always parseable, validates the scenario with the shared schema + resolver, and gives the model
 * one chance to repair anything that doesn't validate.
 */
export class ClaudeProvider implements AiProvider {
  readonly kind = "claude" as const;
  readonly model: string;
  private structuredOutputs = true;

  constructor(private readonly opts: ClaudeProviderOptions) {
    this.model = opts.model;
  }

  private log(msg: string) {
    this.opts.log?.(msg);
  }

  private async call(
    system: string,
    schema: Record<string, unknown>,
    messages: Anthropic.MessageParam[],
    effort: Effort,
    maxTokens: number,
  ): Promise<{ text: string; message: Anthropic.Message }> {
    const systemText = this.structuredOutputs
      ? system
      : `${system}\n\nRespond with only a JSON object — no prose and no code fences — that validates against this JSON Schema:\n${JSON.stringify(schema)}`;
    const params: Anthropic.MessageStreamParams = {
      model: this.model,
      max_tokens: maxTokens,
      thinking: { type: "adaptive" },
      output_config: {
        effort,
        ...(this.structuredOutputs ? { format: { type: "json_schema", schema } } : {}),
      },
      system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
      messages,
    };
    const started = Date.now();
    let message: Anthropic.Message;
    try {
      message = await this.opts.client.messages.stream(params, { timeout: 240_000 }).finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.BadRequestError && this.structuredOutputs && /output_config|format|schema|grammar/i.test(err.message)) {
        // The deployment rejected the schema (e.g. a model without structured outputs): fall back to
        // prompting for JSON and validating it ourselves.
        this.log(`structured outputs rejected (${err.message}); switching to prompted JSON`);
        this.structuredOutputs = false;
        return this.call(system, schema, messages, effort, maxTokens);
      }
      throw toAiError(err);
    }
    const u = message.usage;
    this.log(
      `${this.model} ${message.stop_reason} in ${((Date.now() - started) / 1000).toFixed(1)}s — in ${u.input_tokens} (+${u.cache_read_input_tokens ?? 0} cached, +${u.cache_creation_input_tokens ?? 0} written), out ${u.output_tokens}`,
    );
    if (message.stop_reason === "refusal") {
      const details = (message as { stop_details?: { explanation?: string | null } | null }).stop_details;
      throw new AiError(`The model declined this request${details?.explanation ? `: ${details.explanation}` : "."}`, "refusal");
    }
    if (message.stop_reason === "max_tokens") throw new AiError("The model's answer was cut off (too long).", "truncated");
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { text, message };
  }

  /** Call, validate, and if validation fails give the model one chance to fix its own output. */
  private async callValidated<T>(
    system: string,
    schema: Record<string, unknown>,
    messages: Anthropic.MessageParam[],
    effort: Effort,
    maxTokens: number,
    validate: (json: unknown) => { ok: true; value: T } | { ok: false; errors: string[] },
  ): Promise<T> {
    const first = await this.call(system, schema, messages, effort, maxTokens);
    let check: ReturnType<typeof validate>;
    try {
      check = validate(extractJson(first.text));
    } catch (e) {
      check = { ok: false, errors: [(e as Error).message] };
    }
    if (check.ok) return check.value;
    this.log(`output failed validation, asking for a repair: ${check.errors.slice(0, 5).join(" | ")}`);
    const repair: Anthropic.MessageParam[] = [
      ...messages,
      { role: "assistant", content: first.message.content as Anthropic.ContentBlockParam[] },
      {
        role: "user",
        content: `That JSON didn't pass PhysicsLab's validation:\n- ${check.errors.slice(0, 12).join("\n- ")}\nReturn the complete corrected JSON object.`,
      },
    ];
    const second = await this.call(system, schema, repair, effort, maxTokens);
    let again: ReturnType<typeof validate>;
    try {
      again = validate(extractJson(second.text));
    } catch (e) {
      again = { ok: false, errors: [(e as Error).message] };
    }
    if (again.ok) return again.value;
    throw new AiError(`The model's scenario didn't validate: ${again.errors.slice(0, 3).join("; ")}`, "invalid_output");
  }

  async interpret(req: InterpretRequest): Promise<InterpretResult> {
    const messages = buildInterpretMessages(req);
    return this.callValidated(INTERPRET_SYSTEM, INTERPRET_SCHEMA, messages, this.opts.interpretEffort, 32_000, (json) => {
      const out = InterpretOutputSchema.safeParse(json);
      if (!out.success) return { ok: false, errors: out.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
      const o = out.data;
      const wireScenario = wireToScenarioInput(o.scenario);
      const hasObjects = Array.isArray((wireScenario as { objects?: unknown[] }).objects) && (wireScenario as { objects: unknown[] }).objects.length > 0;
      let scenario: Scenario | null = null;
      if (hasObjects) {
        const parsed = parseScenario(wireScenario);
        if (!parsed.ok) return { ok: false, errors: parsed.errors.map((e) => `scenario.${e}`) };
        scenario = parsed.scenario;
        scenario.metadata.created_at = new Date().toISOString();
        scenario.metadata.source = "ai";
        const problems = resolveScenario(scenario).problems;
        if (problems.length) return { ok: false, errors: problems };
      } else if (o.status === "ready") {
        return { ok: false, errors: ["status is 'ready' but the scenario has no objects"] };
      }
      const variations = o.suggested_variations.map((v) => ({ ...v, changes: v.changes.map((c) => ({ path: c.path, value: c.value })) }));
      const result: InterpretResult = {
        status: o.status,
        reply: o.reply,
        interpretation: o.interpretation,
        scenario,
        suggested_variations: usableVariations(scenario, variations),
        source: "ai",
        model: this.model,
        issues: scenario ? validateScenario(scenario).issues : [],
      };
      return { ok: true, value: result };
    });
  }

  async explain(req: ExplainRequest): Promise<ExplainResult> {
    const payload: Record<string, unknown> = {
      scenario: scenarioToWire(req.scenario as unknown as Parameters<typeof scenarioToWire>[0]),
      results: req.metrics ?? null,
      predictions_vs_simulation: req.predictions ?? [],
    };
    if (req.previous) {
      payload.previous_results = req.previous.metrics ?? null;
      payload.previous_predictions = req.previous.predictions ?? [];
      payload.parameter_changes = diffScenarios(req.previous.scenario, req.scenario);
    }
    const content = `${req.question ? `Question: ${req.question}\n\n` : req.previous ? "The user changed some parameters and re-ran the simulation. Explain the effect.\n\n" : "Explain these simulation results.\n\n"}${JSON.stringify(payload)}`;
    return this.callValidated(EXPLAIN_SYSTEM, EXPLAIN_SCHEMA, [{ role: "user", content }], this.opts.explainEffort, 8_000, (json) => {
      const out = ExplainOutputSchema.safeParse(json);
      if (!out.success) return { ok: false, errors: out.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
      return {
        ok: true,
        value: {
          explanation: out.data.explanation,
          key_points: out.data.key_points,
          suggestions: usableVariations(req.scenario, out.data.suggestions.map((s) => ({ ...s, changes: s.changes.map((c) => ({ path: c.path, value: c.value })) }))),
          source: "ai",
          model: this.model,
        },
      };
    });
  }
}

export function buildInterpretMessages(req: InterpretRequest): Anthropic.MessageParam[] {
  const history = (req.history ?? []).slice(-MAX_HISTORY_TURNS);
  while (history.length && history[0].role !== "user") history.shift();
  const messages: Anthropic.MessageParam[] = history.map((t) => ({ role: t.role, content: t.content }));
  let content = "";
  if (req.scenario) {
    content += `Current scenario (edit this if my request is a change to it):\n${JSON.stringify(scenarioToWire(req.scenario as unknown as Parameters<typeof scenarioToWire>[0]))}\n\n`;
  }
  content += `My request: ${req.message}`;
  messages.push({ role: "user", content });
  return messages;
}

export function toAiError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new AiError("The Anthropic API key was rejected.", "auth");
  }
  if (err instanceof Anthropic.RateLimitError) return new AiError("The AI is rate-limited right now; try again shortly.", "rate_limit");
  if (err instanceof Anthropic.BadRequestError) return new AiError(`The AI request was rejected: ${err.message}`, "bad_request");
  if (err instanceof Anthropic.APIConnectionError) return new AiError("Couldn't reach the Anthropic API.", "unavailable");
  if (err instanceof Anthropic.APIError) return new AiError(`The AI service returned an error (${err.status ?? "unknown"}).`, "unavailable");
  return new AiError(err instanceof Error ? err.message : "Unknown AI error.", "unavailable");
}
