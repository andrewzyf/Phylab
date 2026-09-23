import { describe, expect, it } from "vitest";
import { analyzeScenario, extractQuantities, interpretOffline, resolveScenario, SPEED_OF_LIGHT, validateScenario } from "../src";

describe("quantity extraction", () => {
  it("reads masses, speeds, angles and lengths with units", () => {
    const x = extractQuantities("A 500g ball is thrown horizontally at 10 m/s from a 20 meter cliff at 30 degrees");
    expect(x.masses[0].value).toBeCloseTo(0.5);
    expect(x.speeds[0].value).toBe(10);
    expect(x.lengths[0].value).toBe(20);
    expect(x.angles[0].value).toBe(30);
  });
  it("understands friction words and planets", () => {
    expect(extractQuantities("a frictionless ramp").friction).toBe(0);
    expect(extractQuantities("friction coefficient of 0.25").friction).toBe(0.25);
    expect(extractQuantities("μ = 0.4").friction).toBe(0.4);
    expect(extractQuantities("a ball dropped on the moon").gravity).toBeCloseTo(1.62);
    expect(extractQuantities("in outer space").gravity).toBe(0);
  });
  it("reads relativistic speeds and negative masses", () => {
    expect(extractQuantities("a ball moving at 0.9c").speeds[0].value).toBeCloseTo(0.9 * SPEED_OF_LIGHT);
    expect(extractQuantities("mass = -5 kg").masses[0].value).toBe(-5);
    expect(extractQuantities("2 km/h").speeds[0].value).toBeCloseTo(2 / 3.6);
  });
});

describe("offline interpretation of the spec examples", () => {
  it("ball on a frictionless ramp at 30°", () => {
    const r = interpretOffline("A ball of mass 2kg rolling down a frictionless ramp at 30 degrees");
    expect(r.status).toBe("ready");
    const s = r.scenario!;
    const ramp = s.objects.find((o) => o.type === "ramp")!;
    const ball = s.objects.find((o) => o.type === "sphere")!;
    expect(ramp.dimensions.angle).toBe(30);
    expect(ball.mass).toBe(2);
    expect(ramp.material.friction_coefficient).toBe(0);
    // "rolling" + "frictionless" is flagged as a question, like the spec's example
    expect(r.interpretation.questions.some((q) => /rolling/i.test(q.question))).toBe(true);
    const a = analyzeScenario(resolveScenario(s)).predictions.find((p) => p.id.endsWith("_ramp_accel"))!;
    expect(a.value).toBeCloseTo(4.905, 2);
    expect(r.interpretation.calculations.length).toBeGreaterThan(0);
  });

  it("500 g ball thrown horizontally at 10 m/s from a 20 m cliff", () => {
    const r = interpretOffline("A 500g ball is thrown horizontally at 10 m/s from a 20 meter cliff");
    const s = r.scenario!;
    expect(s.objects.some((o) => o.is_static && o.type === "box")).toBe(true);
    const ball = s.objects.find((o) => !o.is_static)!;
    expect(ball.mass).toBe(0.5);
    expect(ball.velocity[0]).toBeCloseTo(10);
    const tf = analyzeScenario(resolveScenario(s)).predictions.find((p) => p.id.endsWith("flight_time"))!;
    expect(tf.value).toBeCloseTo(Math.sqrt(40 / 9.81), 2);
  });

  it("pendulum with 1 m length released from 45°", () => {
    const r = interpretOffline("A pendulum with 1 meter length, released from 45 degrees");
    const bob = r.scenario!.objects[0];
    expect(bob.placement?.kind).toBe("pendulum");
    expect(bob.placement?.length).toBe(1);
    expect(bob.placement?.angle).toBe(45);
  });

  it("flags negative mass with a correction", () => {
    const r = interpretOffline("A ball with mass = -5 kg dropped from 3 m");
    const issue = validateScenario(r.scenario!).issues.find((i) => i.code === "negative_mass")!;
    expect(issue.severity).toBe("error");
    expect(issue.suggestion).toMatch(/repulsive/);
    expect(issue.fix?.changes[0].value).toBe(5);
  });

  it("warns about relativistic speeds", () => {
    const r = interpretOffline("A ball thrown at 0.9c");
    expect(r.issues?.some((i) => i.code === "relativistic")).toBe(true);
  });

  it("flags contradictory constraints", () => {
    const r = interpretOffline("A block fixed in place that slides forward at 5 m/s");
    expect(r.issues?.some((i) => i.code === "static_with_velocity")).toBe(true);
  });

  it("asks for clarification when nothing is recognisable", () => {
    const r = interpretOffline("make something cool happen");
    expect(r.status).toBe("needs_clarification");
    expect(r.scenario).toBeNull();
    expect(r.interpretation.questions.length).toBeGreaterThan(0);
  });

  it("handles collisions, springs, orbits, slides and drops", () => {
    for (const text of [
      "A 1 kg ball at 4 m/s hits a stationary 3 kg ball, perfectly elastic, in space",
      "A 2 kg mass on a spring with k = 50 N/m pulled 0.2 m",
      "A planet orbiting a star at 5 m",
      "Push a 4 kg crate with 20 N for 2 seconds on a floor with friction 0.25",
      "Drop a bowling ball and a tennis ball from 10 m on the moon",
      "A 3 kg block slides down a 40 degree incline with friction 0.2",
    ]) {
      const r = interpretOffline(text);
      expect(r.status, text).toBe("ready");
      const v = validateScenario(r.scenario!);
      expect(v.canRun, `${text}: ${JSON.stringify(v.issues)}`).toBe(true);
    }
  });

  it("applies follow-up edits to the current scenario", () => {
    const first = interpretOffline("A ball of mass 2kg rolling down a frictionless ramp at 30 degrees");
    const next = interpretOffline("make it 45 degrees and double the mass", first.scenario);
    const ramp = next.scenario!.objects.find((o) => o.type === "ramp")!;
    const ball = next.scenario!.objects.find((o) => o.type === "sphere")!;
    expect(ramp.dimensions.angle).toBe(45);
    expect(ball.mass).toBe(4);
    const moon = interpretOffline("try it on the moon", next.scenario);
    expect(moon.scenario!.environment.gravity).toBeCloseTo(1.62);
    const roll = interpretOffline("Roll without slipping", first.scenario);
    expect(roll.scenario!.objects.find((o) => o.type === "ramp")!.material.friction_coefficient).toBe(0.5);
  });

  it("offers variations that apply cleanly", () => {
    const r = interpretOffline("A pendulum 2 m long released from 20 degrees");
    expect(r.suggested_variations.length).toBeGreaterThan(0);
  });
});
