import { describe, expect, it } from "vitest";
import { applyChanges, presetScenario, PRESETS } from "@physicslab/shared";
import { fmt, fmtUnit, pctDiff } from "../src/lib/format";
import { fromSlider, paramGroups, toSlider } from "../src/lib/params";
import { decodeScenario, encodeScenario } from "../src/lib/share";
import { recordingToCsv } from "../src/lib/export";
import { resolveScenario, simulate } from "@physicslab/shared";

describe("share links", () => {
  it("round-trips every preset through the compressed URL fragment", async () => {
    for (const p of PRESETS) {
      const s = presetScenario(p.id);
      const hash = await encodeScenario(s);
      expect(hash.startsWith("s=")).toBe(true);
      expect(await decodeScenario(`#${hash}`)).toEqual(s);
    }
  });
  it("rejects garbage", async () => {
    expect(await decodeScenario("#s=not-valid")).toBeNull();
    expect(await decodeScenario("#nothing")).toBeNull();
  });
});

describe("parameter sliders", () => {
  it("every generated slider path applies cleanly and includes its current value", () => {
    for (const p of PRESETS) {
      const s = presetScenario(p.id);
      for (const g of paramGroups(s)) {
        for (const spec of g.params) {
          if (spec.kind === "number") {
            expect(spec.value as number, spec.path).toBeGreaterThanOrEqual(spec.min);
            expect(spec.value as number, spec.path).toBeLessThanOrEqual(spec.max);
          }
          expect(() => applyChanges(s, [{ path: spec.path, value: spec.value }]), `${p.id}: ${spec.path}`).not.toThrow();
        }
      }
    }
  });
  it("log sliders map back to (about) the same value", () => {
    const spec = { path: "x", label: "Mass", unit: "kg", kind: "number" as const, value: 2, min: 0.001, max: 10000, step: 0.001, scale: "log" as const };
    expect(fromSlider(spec, toSlider(spec, 2))).toBeCloseTo(2, 1);
    expect(fromSlider(spec, 0)).toBeCloseTo(0.001, 6);
    expect(fromSlider(spec, 1000)).toBeCloseTo(10000, 0);
  });
});

describe("formatting", () => {
  it("formats numbers for people", () => {
    expect(fmt(4.905)).toBe("4.91");
    expect(fmt(-2)).toBe("−2");
    expect(fmt(1.38e-15, 3, 1e-6)).toBe("0");
    expect(fmt(6.674e-11)).toBe("6.67e-11");
    expect(fmtUnit(0.9 * 299_792_458, "m/s")).toBe("0.9c");
    expect(pctDiff(2.8e-8)).toBe("0.00%");
    expect(pctDiff(-0.0014)).toBe("−0.14%");
  });
});

describe("CSV export", () => {
  it("has one row per sample and a column per quantity", () => {
    const rec = simulate(resolveScenario(presetScenario("pendulum")));
    const csv = recordingToCsv(rec, { bob: "Bob" }).split("\n");
    expect(csv.length).toBe(rec.sampleCount + 1);
    expect(csv[0]).toContain("Bob.speed_m_s");
    expect(csv[1].split(",").length).toBe(csv[0].split(",").length);
  });
});
