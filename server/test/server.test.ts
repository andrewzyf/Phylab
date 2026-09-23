import Anthropic from "@anthropic-ai/sdk";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { makeScenario, parseScenario, PRESETS, presetScenario, resolveScenario } from "@physicslab/shared";
import { buildInterpretMessages, ClaudeProvider, type MessagesClient } from "../src/ai/claude";
import { OfflineProvider } from "../src/ai/provider";
import { EXPLAIN_SCHEMA, INTERPRET_SCHEMA, scenarioToWire, wireToScenarioInput } from "../src/ai/wire";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";

const config = { ...loadConfig({}), rateLimitPerMinute: 100 };

function message(text: string, stop: Anthropic.StopReason = "end_turn"): Anthropic.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text, citations: null }],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  } as unknown as Anthropic.Message;
}

function fakeClient(responder: (params: Anthropic.MessageStreamParams, call: number) => Anthropic.Message | Error) {
  const calls: Anthropic.MessageStreamParams[] = [];
  const client: MessagesClient = {
    messages: {
      stream(params) {
        calls.push(params);
        const n = calls.length;
        return {
          finalMessage: async () => {
            const r = responder(params, n);
            if (r instanceof Error) throw r;
            return r;
          },
        };
      },
    },
  };
  return { client, calls };
}

function goodOutput(presetId = "ramp-frictionless") {
  const s = presetScenario(presetId);
  return {
    status: "ready",
    reply: "Here's the setup.",
    interpretation: {
      summary: "A ball slides down a frictionless ramp.",
      objects: [{ name: "Ball", details: "2 kg" }],
      forces: [{ name: "Gravity", details: "9.81 m/s² down" }],
      calculations: [{ label: "Acceleration", expression: "a = g sin θ", result: "4.91 m/s²" }],
      assumptions: ["No air resistance"],
      questions: [{ question: "Include rolling?", options: ["Yes", "No"] }],
      expected_outcome: "Reaches the bottom in 1.4 s",
      physics_notes: "Mass cancels.",
    },
    scenario: scenarioToWire(s as unknown as Parameters<typeof scenarioToWire>[0]),
    suggested_variations: [
      { label: "Steeper", description: "45°", changes: [{ path: "objects.ramp_1.dimensions.angle", value: 45 }] },
      { label: "Bogus", description: "unknown id", changes: [{ path: "objects.nope.mass", value: 3 }] },
    ],
  };
}

function provider(client: MessagesClient) {
  return new ClaudeProvider({ client, model: "claude-opus-5-5", interpretEffort: "medium", explainEffort: "low" });
}

describe("wire schema", () => {
  const check = (node: unknown, path: string) => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n.type === "object") {
      const props = Object.keys(n.properties as object);
      expect(n.additionalProperties, path).toBe(false);
      expect([...(n.required as string[])].sort(), path).toEqual(props.sort());
      for (const [k, v] of Object.entries(n.properties as object)) check(v, `${path}.${k}`);
    }
    if (n.type === "array") check(n.items, `${path}[]`);
    expect(n.anyOf, `${path} should avoid unions`).toBeUndefined();
    expect(n.minimum, path).toBeUndefined();
  };
  it("meets structured-output rules (all required, no extra properties, no unions)", () => {
    check(INTERPRET_SCHEMA, "interpret");
    check(EXPLAIN_SCHEMA, "explain");
  });

  it("round-trips every preset through the wire format", () => {
    for (const p of PRESETS) {
      const s = presetScenario(p.id);
      const back = parseScenario(wireToScenarioInput(scenarioToWire(s as unknown as Parameters<typeof scenarioToWire>[0])));
      expect(back.ok, p.id).toBe(true);
      if (!back.ok) continue;
      const a = resolveScenario(s);
      const b = resolveScenario(back.scenario);
      expect(b.objects.map((o) => o.position)).toEqual(a.objects.map((o) => o.position));
      expect(b.objects.map((o) => [o.mass, o.friction, o.restitution, o.dynamic])).toEqual(a.objects.map((o) => [o.mass, o.friction, o.restitution, o.dynamic]));
      expect(b.links.length).toBe(a.links.length);
      expect(b.forces.length).toBe(a.forces.length);
    }
  });
});

describe("ClaudeProvider", () => {
  it("sends Opus 5.5-compatible parameters and parses the scenario", async () => {
    const { client, calls } = fakeClient(() => message(JSON.stringify(goodOutput())));
    const result = await provider(client).interpret({ message: "ball on a frictionless ramp" });
    const params = calls[0];
    expect(params.model).toBe("claude-opus-5-5");
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.tool_choice).toBeUndefined();
    expect(params.output_config?.effort).toBe("medium");
    expect(params.output_config?.format?.type).toBe("json_schema");
    expect(result.source).toBe("ai");
    expect(result.scenario?.objects.map((o) => o.id)).toEqual(["ramp_1", "ball_1"]);
    expect(result.suggested_variations.map((v) => v.label)).toEqual(["Steeper"]);
    expect(result.issues?.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("asks the model to repair invalid output once", async () => {
    const bad = goodOutput();
    (bad.scenario as { objects: { placement: { target_id: string } }[] }).objects[1].placement.target_id = "missing_ramp";
    const { client, calls } = fakeClient((_p, n) => message(JSON.stringify(n === 1 ? bad : goodOutput())));
    const result = await provider(client).interpret({ message: "ball on ramp" });
    expect(calls.length).toBe(2);
    const repairTurn = calls[1].messages.at(-1)!;
    expect(repairTurn.role).toBe("user");
    expect(String(repairTurn.content)).toMatch(/missing_ramp/);
    expect(calls[1].messages.at(-2)!.role).toBe("assistant");
    expect(result.scenario).not.toBeNull();
  });

  it("falls back to prompted JSON when the schema is rejected", async () => {
    const { client, calls } = fakeClient((p, n) => {
      if (n === 1) return new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "output_config.format: schema too complex" } }, "output_config.format: schema too complex", new Headers());
      return message("```json\n" + JSON.stringify(goodOutput()) + "\n```");
    });
    const result = await provider(client).interpret({ message: "ball on ramp" });
    expect(calls[1].output_config?.format).toBeUndefined();
    expect(JSON.stringify(calls[1].system)).toMatch(/JSON Schema/);
    expect(result.scenario).not.toBeNull();
  });

  it("reports refusals as AI errors", async () => {
    const { client } = fakeClient(() => message("", "refusal"));
    await expect(provider(client).interpret({ message: "x" })).rejects.toThrow(/declined/);
  });

  it("puts the current scenario and trimmed history in the request", () => {
    const s = presetScenario("pendulum");
    const msgs = buildInterpretMessages({
      message: "make it longer",
      scenario: s,
      history: [
        { role: "assistant", content: "orphan" },
        { role: "user", content: "a pendulum" },
        { role: "assistant", content: "Here it is." },
      ],
    });
    expect(msgs[0]).toEqual({ role: "user", content: "a pendulum" });
    expect(String(msgs.at(-1)!.content)).toMatch(/Current scenario[\s\S]*"bob"[\s\S]*My request: make it longer/);
  });
});

describe("HTTP API", () => {
  it("reports AI status", async () => {
    const res = await request(createApp({ config, ai: null, staticDir: null })).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ai.enabled).toBe(false);
  });

  it("interprets offline when no AI is configured", async () => {
    const res = await request(createApp({ config, ai: null, staticDir: null }))
      .post("/api/interpret")
      .send({ message: "A pendulum with 1 meter length, released from 45 degrees" });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("offline");
    expect(res.body.scenario.objects[0].placement.kind).toBe("pendulum");
  });

  it("uses the AI provider when configured", async () => {
    const { client } = fakeClient(() => message(JSON.stringify(goodOutput())));
    const res = await request(createApp({ config, ai: provider(client), staticDir: null }))
      .post("/api/interpret")
      .send({ message: "A ball on a frictionless ramp" });
    expect(res.body.source).toBe("ai");
    expect(res.body.model).toBe("claude-opus-5-5");
  });

  it("falls back to the offline interpreter when the AI fails", async () => {
    const { client } = fakeClient(() => new Anthropic.APIConnectionError({ message: "down" }));
    const res = await request(createApp({ config, ai: provider(client), staticDir: null }))
      .post("/api/interpret")
      .send({ message: "A ball of mass 2kg rolling down a frictionless ramp at 30 degrees" });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("offline");
    expect(res.body.fallback_reason).toMatch(/Couldn't reach/);
    expect(res.body.scenario).toBeTruthy();
  });

  it("rate-limits AI calls per client", async () => {
    const { client, calls } = fakeClient(() => message(JSON.stringify(goodOutput())));
    const app = createApp({ config: { ...config, rateLimitPerMinute: 1 }, ai: provider(client), staticDir: null });
    await request(app).post("/api/interpret").send({ message: "ramp" });
    const second = await request(app).post("/api/interpret").send({ message: "a ball on a ramp" });
    expect(calls.length).toBe(1);
    expect(second.body.fallback_reason).toMatch(/rate limit/);
  });

  it("validates input", async () => {
    const app = createApp({ config, ai: null, staticDir: null });
    expect((await request(app).post("/api/interpret").send({ message: "" })).status).toBe(400);
    expect((await request(app).post("/api/interpret").send({})).status).toBe(400);
    expect((await request(app).post("/api/explain").send({ scenario: { objects: "nope" } })).status).toBe(400);
    expect((await request(app).get("/api/nothing")).status).toBe(404);
  });

  it("explains a parameter change offline", async () => {
    const before = presetScenario("ramp-frictionless");
    const after = makeScenario({ ...before, objects: before.objects.map((o) => (o.id === "ball_1" ? { ...o, mass: 4 } : o)) });
    const res = await request(createApp({ config, ai: new OfflineProvider(), staticDir: null }))
      .post("/api/explain")
      .send({ scenario: after, previous: { scenario: before }, offline: true });
    expect(res.status).toBe(200);
    expect(res.body.explanation).toMatch(/mass/i);
    expect(res.body.key_points.join(" ")).toMatch(/2 → 4/);
  });
});
