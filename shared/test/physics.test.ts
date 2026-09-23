import { describe, expect, it } from "vitest";
import {
  analyzeScenario,
  checkPredictions,
  makeScenario,
  presetScenario,
  PRESETS,
  resolveScenario,
  simulate,
  validateScenario,
  type ScenarioInput,
} from "../src";

function runChecks(input: ScenarioInput) {
  const rs = resolveScenario(makeScenario(input));
  const analysis = analyzeScenario(rs);
  const rec = simulate(rs);
  return { rs, analysis, rec, checks: checkPredictions(rec, analysis.predictions) };
}

function expectAllAgree(checks: ReturnType<typeof checkPredictions>, minCount = 1) {
  const measured = checks.filter((c) => c.prediction.measure);
  expect(measured.length).toBeGreaterThanOrEqual(minCount);
  for (const c of measured) {
    const detail = `${c.prediction.label}: predicted ${c.prediction.value}, measured ${c.measured}`;
    expect(c.measured, detail).not.toBeNull();
    expect(c.agrees, detail).toBe(true);
  }
}

const ramp = (angle: number, mu: number, obj: Record<string, unknown>) => ({
  environment: { simulation_duration: 3 },
  objects: [
    { id: "ramp", type: "ramp", dimensions: { length: 5, angle, width: 1.5 }, material: { friction_coefficient: mu } },
    { id: "obj", mass: 2, material: { friction_coefficient: mu }, placement: { kind: "on_ramp", target_id: "ramp", distance_from_top: 0.2 }, ...obj },
  ],
}) as ScenarioInput;

describe("simulation agrees with closed-form physics", () => {
  it("frictionless ramp: a = g sin θ", () => {
    const { analysis, checks } = runChecks(ramp(30, 0, { type: "sphere", dimensions: { radius: 0.1 } }));
    expect(analysis.archetypes).toContain("ramp");
    expect(analysis.predictions[0].value).toBeCloseTo(9.81 * 0.5, 3);
    expectAllAgree(checks, 3);
  });

  it("rolling solid sphere: a = 5/7 g sin θ", () => {
    const { analysis, checks } = runChecks(ramp(30, 0.6, { type: "sphere", dimensions: { radius: 0.1 } }));
    expect(analysis.predictions[0].value).toBeCloseTo((5 / 7) * 9.81 * 0.5, 3);
    expectAllAgree(checks, 3);
  });

  it("rolling hollow sphere: a = 3/5 g sin θ", () => {
    const { analysis, checks } = runChecks(ramp(25, 0.6, { type: "sphere", hollow: true, dimensions: { radius: 0.1 } }));
    expect(analysis.predictions[0].value).toBeCloseTo(0.6 * 9.81 * Math.sin((25 * Math.PI) / 180), 3);
    expectAllAgree(checks, 3);
  });

  it("rolling cylinder: a = 2/3 g sin θ (faceted, looser tolerance)", () => {
    const { checks } = runChecks(ramp(30, 0.6, { type: "cylinder", dimensions: { radius: 0.1, height: 0.2 } }));
    expectAllAgree(checks, 3);
  });

  it("box sliding with kinetic friction: a = g(sin θ − μ cos θ)", () => {
    const { analysis, checks } = runChecks(ramp(30, 0.3, { type: "box", dimensions: { width: 0.2, height: 0.2, depth: 0.2 } }));
    expect(analysis.predictions[0].value).toBeCloseTo(9.81 * (0.5 - 0.3 * Math.cos(Math.PI / 6)), 3);
    expectAllAgree(checks, 3);
  });

  it("static friction holds a box when μ ≥ tan θ", () => {
    const { analysis, rec } = runChecks(ramp(20, 0.6, { type: "box", dimensions: { width: 0.3, height: 0.2, depth: 0.3 } }));
    expect(analysis.predictions[0].value).toBe(0);
    const tr = rec.bodies.obj;
    const n = rec.sampleCount;
    const moved = Math.hypot(tr.pos[(n - 1) * 3] - tr.pos[0], tr.pos[(n - 1) * 3 + 1] - tr.pos[1]);
    expect(moved).toBeLessThan(0.01);
  });

  it("horizontal throw from a cliff (spec example)", () => {
    const { analysis, checks } = runChecks(PRESETS.find((p) => p.id === "cliff-throw")!.scenario);
    expect(analysis.archetypes).toContain("projectile");
    const tf = analysis.predictions.find((p) => p.id === "ball_flight_time")!;
    expect(tf.value).toBeCloseTo(Math.sqrt((2 * 20) / 9.81), 2);
    expectAllAgree(checks, 3);
  });

  it("angled launch reaches the predicted apex and range", () => {
    const v = 12;
    const a = (40 * Math.PI) / 180;
    const { analysis, checks } = runChecks({
      environment: { simulation_duration: 3 },
      objects: [{ id: "p", type: "sphere", mass: 0.4, position: [0, 0.2005, 0], velocity: [v * Math.cos(a), v * Math.sin(a), 0], dimensions: { radius: 0.2 }, material: { restitution: 0.1 } }],
    });
    expect(analysis.predictions.map((p) => p.id)).toContain("p_max_height");
    expectAllAgree(checks, 4);
  });

  it("bounce height follows e²", () => {
    const { checks } = runChecks(PRESETS.find((p) => p.id === "bouncing-ball")!.scenario);
    const bounce = checks.find((c) => c.prediction.id === "ball_bounce")!;
    expect(bounce.prediction.value).toBeCloseTo(0.64 * 2, 2);
    expectAllAgree(checks, 3);
  });

  it("pendulum period includes the large-angle correction", () => {
    const { analysis, checks } = runChecks(PRESETS.find((p) => p.id === "pendulum")!.scenario);
    const period = analysis.predictions.find((p) => p.id === "bob_period")!;
    expect(period.value).toBeCloseTo(2.0863, 3);
    expectAllAgree(checks, 2);
  });

  it("vertical spring oscillates with T = 2π√(m/k)", () => {
    const { analysis, checks } = runChecks(PRESETS.find((p) => p.id === "spring-mass")!.scenario);
    expect(analysis.predictions[0].value).toBeCloseTo(2 * Math.PI * Math.sqrt(1 / 20), 4);
    expectAllAgree(checks, 2);
  });

  it("damped spring period and energy loss", () => {
    const { analysis, checks, rec } = runChecks(PRESETS.find((p) => p.id === "damped-spring")!.scenario);
    expect(analysis.energy).toBe("decreases");
    expectAllAgree(checks, 1);
    expect(rec.energy.total[rec.sampleCount - 1]).toBeLessThan(0.5 * rec.energy.total[0]);
  });

  it("1D elastic collision conserves momentum and kinetic energy", () => {
    const { analysis, checks } = runChecks(PRESETS.find((p) => p.id === "elastic-collision")!.scenario);
    expect(analysis.archetypes).toContain("collision");
    expect(analysis.predictions.find((p) => p.id === "small_after")!.value).toBeCloseTo(-2, 6);
    expect(analysis.predictions.find((p) => p.id === "big_after")!.value).toBeCloseTo(2, 6);
    expectAllAgree(checks, 2);
  });

  it("inelastic collision (e = 0.5)", () => {
    const { checks } = runChecks({
      environment: { simulation_duration: 3, gravity: 0, ground: false },
      objects: [
        { id: "a", type: "sphere", mass: 2, position: [-2, 1, 0], velocity: [3, 0, 0], dimensions: { radius: 0.2 }, material: { restitution: 0.5 } },
        { id: "b", type: "sphere", mass: 1, position: [1, 1, 0], velocity: [-1, 0, 0], dimensions: { radius: 0.2 }, material: { restitution: 0.5 } },
      ],
    });
    expectAllAgree(checks, 2);
  });

  it("orbit period matches Kepler's third law", () => {
    const { analysis, checks } = runChecks(PRESETS.find((p) => p.id === "orbit")!.scenario);
    expect(analysis.archetypes).toContain("orbit");
    expectAllAgree(checks, 1);
  });

  it("sliding block stops after v²/(2μg)", () => {
    const rs = resolveScenario(presetScenario("friction-slide"));
    const rec = simulate(rs);
    const tr = rec.bodies.block;
    const x = tr.pos[(rec.sampleCount - 1) * 3] - tr.pos[0];
    expect(x).toBeCloseTo(25 / (2 * 0.3 * 9.81), 1);
  });

  it("energy is conserved when nothing dissipates it", () => {
    const { analysis, checks } = runChecks({
      environment: { simulation_duration: 6, gravity: 0, ground: false },
      objects: [{ id: "m", type: "sphere", mass: 2, position: [1.5, 1, 0], dimensions: { radius: 0.1 } }],
      links: [{ id: "s", type: "spring", object_a: "m", anchor: [0, 1, 0], length: 1, stiffness: 50 }],
    });
    expect(analysis.energy).toBe("conserved");
    expectAllAgree(checks, 3);
  });

  it("applied force against friction", () => {
    const rs = resolveScenario(presetScenario("push-force"));
    const rec = simulate(rs);
    const tr = rec.bodies.crate;
    const i = Math.round(2 / rec.sampleInterval);
    const vx = tr.vel[i * 3];
    expect(vx).toBeCloseTo(2 * (20 / 4 - 0.25 * 9.81), 1);
  });

  it("impulse changes velocity by J/m", () => {
    const rs = resolveScenario(
      makeScenario({
        environment: { simulation_duration: 1, gravity: 0, ground: false },
        objects: [{ id: "puck", type: "sphere", mass: 0.5, position: [0, 1, 0], dimensions: { radius: 0.1 } }],
        forces: [{ id: "kick", type: "impulse", magnitude: 2, direction: [0, 0, 1], applies_to: ["puck"], start_time: 0.2 }],
      }),
    );
    const rec = simulate(rs);
    const n = rec.sampleCount - 1;
    expect(rec.bodies.puck.vel[n * 3 + 2]).toBeCloseTo(4, 6);
  });

  it("quadratic air drag approaches terminal velocity", () => {
    const rs = resolveScenario(
      makeScenario({
        environment: { simulation_duration: 20, ground: false },
        objects: [{ id: "b", type: "sphere", mass: 0.1, position: [0, 3000, 0], dimensions: { radius: 0.1 } }],
        forces: [{ id: "air", type: "drag", drag_model: "quadratic", magnitude: 0.01, applies_to: ["b"] }],
      }),
    );
    const rec = simulate(rs);
    const n = rec.sampleCount - 1;
    const vt = Math.sqrt((0.1 * 9.81) / 0.01);
    expect(Math.abs(rec.bodies.b.vel[n * 3 + 1])).toBeCloseTo(vt, 1);
  });

  it("is deterministic", () => {
    const rs = resolveScenario(presetScenario("tower-knockdown"));
    const a = simulate(rs);
    const b = simulate(rs);
    expect(Array.from(a.bodies.block_6.pos)).toEqual(Array.from(b.bodies.block_6.pos));
  });
});

describe("presets", () => {
  for (const p of PRESETS) {
    it(`${p.id} validates and simulates cleanly`, () => {
      const scenario = presetScenario(p.id);
      const v = validateScenario(scenario);
      expect(v.issues.filter((i) => i.severity !== "info"), JSON.stringify(v.issues)).toEqual([]);
      const rec = simulate(v.resolved);
      expect(rec.warnings).toEqual([]);
      expect(rec.sampleCount).toBeGreaterThan(10);
      for (const tr of Object.values(rec.bodies)) expect(Array.from(tr.pos).every(Number.isFinite)).toBe(true);
      const checks = checkPredictions(rec, analyzeScenario(v.resolved).predictions);
      for (const c of checks.filter((x) => x.prediction.measure)) {
        expect(c.agrees, `${c.prediction.label}: predicted ${c.prediction.value}, measured ${c.measured}`).toBe(true);
      }
    });
  }
});
