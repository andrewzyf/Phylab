import { makeScenario, type Scenario, type ScenarioInput } from "./schema";

export interface Preset {
  id: string;
  title: string;
  category: "Mechanics" | "Energy" | "Oscillations" | "Collisions" | "Gravity" | "Fun";
  summary: string;
  /** A natural-language description equivalent to the scenario (used as an example prompt). */
  prompt: string;
  scenario: ScenarioInput;
}

const presetList: Preset[] = [
  {
    id: "ramp-frictionless",
    title: "Ball on a frictionless ramp",
    category: "Mechanics",
    summary: "A 2 kg ball slides down a 30° frictionless ramp: a = g·sin θ.",
    prompt: "A ball of mass 2kg rolling down a frictionless ramp at 30 degrees",
    scenario: {
      metadata: { name: "Ball on a frictionless ramp", source: "preset" },
      environment: { simulation_duration: 3 },
      objects: [
        { id: "ramp_1", label: "Ramp", type: "ramp", dimensions: { length: 5, angle: 30, width: 1.5 }, material: { name: "frictionless", friction_coefficient: 0, restitution: 0.2, color: "" } },
        {
          id: "ball_1",
          label: "Ball",
          type: "sphere",
          mass: 2,
          dimensions: { radius: 0.1 },
          material: { name: "rubber", friction_coefficient: 0.1, restitution: 0.3 },
          placement: { kind: "on_ramp", target_id: "ramp_1", distance_from_top: 0.15 },
        },
      ],
      expected_outcome: "The ball accelerates down the ramp at g·sin 30° ≈ 4.9 m/s² and reaches the bottom in about 1.4 s at about 6.9 m/s.",
      physics_notes: "With no friction there is no torque on the ball, so it slides rather than rolls. Mass cancels out of a = g·sin θ.",
    },
  },
  {
    id: "rolling-race",
    title: "Rolling race: sphere vs cylinder vs hoop",
    category: "Energy",
    summary: "Same ramp, same height — which shape wins? Rotational inertia decides.",
    prompt: "Race a solid sphere, a solid cylinder and a hollow hoop down a 20 degree ramp with friction",
    scenario: {
      metadata: { name: "Rolling race", source: "preset" },
      environment: { simulation_duration: 4 },
      objects: [
        { id: "ramp", label: "Ramp", type: "ramp", dimensions: { length: 6, angle: 20, width: 2.4 }, material: { name: "wood", friction_coefficient: 0.8 } },
        { id: "sphere", label: "Solid sphere", type: "sphere", mass: 1, dimensions: { radius: 0.15 }, material: { name: "rubber", friction_coefficient: 0.8, color: "#ff6b4a" }, placement: { kind: "on_ramp", target_id: "ramp", distance_from_top: 0.3, lateral_offset: -0.75 } },
        { id: "cylinder", label: "Solid cylinder", type: "cylinder", mass: 1, dimensions: { radius: 0.15, height: 0.3 }, material: { name: "wood", friction_coefficient: 0.8, color: "#3fc47a" }, placement: { kind: "on_ramp", target_id: "ramp", distance_from_top: 0.3, lateral_offset: 0 } },
        { id: "hoop", label: "Hoop", type: "cylinder", hollow: true, mass: 1, dimensions: { radius: 0.15, height: 0.3 }, material: { name: "steel", friction_coefficient: 0.8, color: "#4f8cff" }, placement: { kind: "on_ramp", target_id: "ramp", distance_from_top: 0.3, lateral_offset: 0.75 } },
      ],
      expected_outcome: "The solid sphere wins (a = 5/7·g·sin θ), then the cylinder (2/3·g·sin θ), then the hoop (1/2·g·sin θ) — regardless of mass or radius.",
      physics_notes: "Rolling objects split their energy between translation and rotation. The more of the mass sits far from the axis, the more energy goes into spinning and the slower the object rolls.",
    },
  },
  {
    id: "cliff-throw",
    title: "Ball thrown off a cliff",
    category: "Mechanics",
    summary: "500 g ball thrown horizontally at 10 m/s from a 20 m cliff.",
    prompt: "A 500g ball is thrown horizontally at 10 m/s from a 20 meter cliff",
    scenario: {
      metadata: { name: "Horizontal throw from a cliff", source: "preset" },
      environment: { simulation_duration: 3 },
      objects: [
        { id: "cliff", label: "Cliff", type: "box", is_static: true, mass: null, position: [-4, 10, 0], dimensions: { width: 8, height: 20, depth: 6 }, material: { name: "stone" } },
        { id: "ball", label: "Ball", type: "sphere", mass: 0.5, position: [0.06, 20.0505, 0], velocity: [10, 0, 0], dimensions: { radius: 0.05 }, material: { name: "rubber", restitution: 0.6 } },
      ],
      expected_outcome: "The ball falls 20 m in √(2h/g) ≈ 2.02 s and lands about 20.2 m from the cliff at about 22.2 m/s.",
      physics_notes: "Horizontal and vertical motion are independent: the horizontal speed stays 10 m/s while gravity accelerates the ball downward.",
    },
  },
  {
    id: "pendulum",
    title: "Simple pendulum",
    category: "Oscillations",
    summary: "A 1 m pendulum released from 45° — including the large-angle correction.",
    prompt: "A pendulum with 1 meter length, released from 45 degrees",
    scenario: {
      metadata: { name: "Simple pendulum", source: "preset" },
      environment: { simulation_duration: 8 },
      objects: [
        { id: "bob", label: "Bob", type: "sphere", mass: 1, dimensions: { radius: 0.06 }, material: { name: "steel" }, placement: { kind: "pendulum", anchor: [0, 2.2, 0], length: 1, angle: 45 } },
      ],
      expected_outcome: "Period ≈ 2.09 s (the small-angle formula gives 2.01 s); top speed ≈ 2.40 m/s at the bottom.",
      physics_notes: "The restoring force is mg·sin θ. For large swings sin θ < θ, so the pendulum is slower than the small-angle formula predicts.",
    },
  },
  {
    id: "bouncing-ball",
    title: "Bouncing ball",
    category: "Energy",
    summary: "Dropped from 2 m with restitution 0.8: each bounce reaches e² of the previous height.",
    prompt: "A rubber ball dropped from 2 meters with coefficient of restitution 0.8",
    scenario: {
      metadata: { name: "Bouncing ball", source: "preset" },
      environment: { simulation_duration: 6 },
      objects: [
        { id: "ball", label: "Ball", type: "sphere", mass: 0.2, position: [0, 2.12, 0], dimensions: { radius: 0.12 }, material: { name: "rubber", restitution: 0.8 } },
      ],
      expected_outcome: "It hits the floor after 0.64 s at 6.26 m/s and rebounds to 0.8² × 2 m = 1.28 m.",
      physics_notes: "Restitution e is the ratio of rebound speed to impact speed; height scales with speed squared, so each bounce keeps e² = 64% of the height.",
    },
  },
  {
    id: "spring-mass",
    title: "Mass on a spring",
    category: "Oscillations",
    summary: "A 1 kg mass hanging from a 20 N/m spring: simple harmonic motion.",
    prompt: "A 1 kg mass hanging from a spring with k = 20 N/m, pulled down and released",
    scenario: {
      metadata: { name: "Mass on a spring", source: "preset" },
      environment: { simulation_duration: 8, ground: false },
      objects: [{ id: "mass", label: "Mass", type: "sphere", mass: 1, position: [0, 1.5, 0], dimensions: { radius: 0.1 }, material: { name: "steel" } }],
      links: [{ id: "spring", type: "spring", object_a: "mass", anchor: [0, 3, 0], length: 0.8, stiffness: 20, damping: 0 }],
      expected_outcome: "Period 2π√(m/k) ≈ 1.40 s around an equilibrium 0.49 m below the spring's natural length.",
      physics_notes: "Gravity only shifts the equilibrium point; the oscillation frequency depends on m and k alone.",
    },
  },
  {
    id: "damped-spring",
    title: "Damped oscillator",
    category: "Oscillations",
    summary: "The same spring with damping: watch the energy drain away.",
    prompt: "A 1 kg mass on a horizontal spring (k = 40 N/m) with damping 0.8 N·s/m, pulled 0.5 m and released",
    scenario: {
      metadata: { name: "Damped oscillator", source: "preset" },
      environment: { simulation_duration: 10, gravity: 0, ground: false },
      objects: [{ id: "mass", label: "Mass", type: "box", mass: 1, position: [1.5, 1, 0], dimensions: { width: 0.25, height: 0.25, depth: 0.25 }, material: { name: "steel" } }],
      links: [{ id: "spring", type: "spring", object_a: "mass", anchor: [0, 1, 0], length: 1, stiffness: 40, damping: 0.8 }],
      expected_outcome: "Oscillates with period ≈ 1.00 s while the amplitude decays by e^(−ζω₀t) with ζ ≈ 0.063.",
      physics_notes: "Damping removes energy every cycle; below critical damping (ζ < 1) the system still oscillates, slightly slower.",
    },
  },
  {
    id: "elastic-collision",
    title: "Elastic collision",
    category: "Collisions",
    summary: "A 1 kg ball hits a resting 3 kg ball head-on in space (e = 1).",
    prompt: "In space, a 1 kg ball moving at 4 m/s hits a stationary 3 kg ball head-on, perfectly elastic",
    scenario: {
      metadata: { name: "Elastic collision", source: "preset" },
      environment: { simulation_duration: 3, gravity: 0, ground: false },
      objects: [
        { id: "small", label: "1 kg ball", type: "sphere", mass: 1, position: [-2, 1, 0], velocity: [4, 0, 0], dimensions: { radius: 0.15 }, material: { name: "steel", restitution: 1 } },
        { id: "big", label: "3 kg ball", type: "sphere", mass: 3, position: [1, 1, 0], dimensions: { radius: 0.25 }, material: { name: "steel", restitution: 1 } },
      ],
      expected_outcome: "The light ball bounces back at −2 m/s; the heavy ball moves off at +2 m/s. Momentum (4 kg·m/s) and kinetic energy (8 J) are conserved.",
      physics_notes: "For an elastic head-on collision, relative speed is reversed: v₂' − v₁' = v₁ − v₂.",
    },
  },
  {
    id: "orbit",
    title: "Planet orbiting a star",
    category: "Gravity",
    summary: "Newtonian gravity between two bodies (scaled masses).",
    prompt: "A small planet orbiting a heavy star (mass 1e11 kg) at 4 m distance",
    scenario: {
      metadata: { name: "Planetary orbit", source: "preset" },
      environment: { simulation_duration: 45, gravity: 0, ground: false },
      objects: [
        { id: "star", label: "Star", type: "sphere", is_static: true, mass: 1e11, position: [0, 2, 0], dimensions: { radius: 0.5 }, material: { name: "gold", color: "#ffcf4a" } },
        { id: "planet", label: "Planet", type: "sphere", mass: 1, position: [4, 2, 0], velocity: [0, 0, -1.15], dimensions: { radius: 0.15 }, material: { name: "stone", color: "#4f8cff" } },
      ],
      forces: [{ id: "gravity_pull", type: "mutual_gravity", magnitude: 6.674e-11, direction: [0, 0, 0], applies_to: ["star", "planet"], start_time: 0 }],
      expected_outcome: "A slightly elliptical orbit with a period of about 17 s (circular speed here would be 1.29 m/s).",
      physics_notes: "Gravity supplies the centripetal force. Kepler's third law: T² ∝ a³.",
    },
  },
  {
    id: "friction-slide",
    title: "Block sliding to a stop",
    category: "Mechanics",
    summary: "A block pushed at 5 m/s across a floor with μ = 0.3.",
    prompt: "A 2 kg wooden block slides across the floor at 5 m/s with a friction coefficient of 0.3",
    scenario: {
      metadata: { name: "Block sliding to a stop", source: "preset" },
      environment: { simulation_duration: 3 },
      objects: [
        { id: "block", label: "Block", type: "box", mass: 2, velocity: [5, 0, 0], position: [-2, 0, 0], dimensions: { width: 0.4, height: 0.3, depth: 0.3 }, material: { name: "wood", friction_coefficient: 0.3 }, placement: { kind: "on_ground" } },
      ],
      expected_outcome: "Friction decelerates it at μg = 2.94 m/s²; it stops after 1.70 s having travelled 4.25 m.",
      physics_notes: "Kinetic friction μN opposes the motion; all the kinetic energy becomes heat.",
    },
  },
  {
    id: "incline-friction",
    title: "Block on a rough incline",
    category: "Mechanics",
    summary: "μ = 0.2 on a 35° slope: friction slows it but can't hold it.",
    prompt: "A 3 kg box on a 35 degree incline with friction coefficient 0.2",
    scenario: {
      metadata: { name: "Block on a rough incline", source: "preset" },
      environment: { simulation_duration: 3 },
      objects: [
        { id: "ramp", label: "Incline", type: "ramp", dimensions: { length: 5, angle: 35, width: 1.5 }, material: { name: "wood", friction_coefficient: 0.2 } },
        { id: "box", label: "Box", type: "box", mass: 3, dimensions: { width: 0.4, height: 0.3, depth: 0.4 }, material: { name: "wood", friction_coefficient: 0.2 }, placement: { kind: "on_ramp", target_id: "ramp", distance_from_top: 0.3 } },
      ],
      expected_outcome: "a = g(sin 35° − 0.2 cos 35°) ≈ 4.02 m/s².",
      physics_notes: "The box slides because tan 35° = 0.70 exceeds μ = 0.2. Try μ = 0.8 to see static friction hold it in place.",
    },
  },
  {
    id: "moon-drop",
    title: "Hammer and feather on the Moon",
    category: "Gravity",
    summary: "Without air, heavy and light objects fall together (g = 1.62 m/s²).",
    prompt: "On the moon, drop a 1 kg hammer and a 30 g feather from 1.5 m at the same time",
    scenario: {
      metadata: { name: "Hammer and feather on the Moon", source: "preset" },
      environment: { simulation_duration: 2, gravity: 1.62 },
      objects: [
        { id: "hammer", label: "Hammer (1 kg)", type: "box", mass: 1, position: [-0.5, 1.55, 0], dimensions: { width: 0.1, height: 0.1, depth: 0.3 }, material: { name: "steel", restitution: 0.1 } },
        { id: "feather", label: "Feather (30 g)", type: "box", mass: 0.03, position: [0.5, 1.505, 0], dimensions: { width: 0.2, height: 0.01, depth: 0.05 }, material: { name: "foam", restitution: 0.05, color: "#f5f0e6" } },
      ],
      expected_outcome: "Both land together after √(2h/g) ≈ 1.36 s.",
      physics_notes: "Gravitational force is proportional to mass, and so is inertia, so acceleration is the same for everything (Apollo 15, 1971).",
    },
  },
  {
    id: "push-force",
    title: "Constant push against friction",
    category: "Mechanics",
    summary: "A 20 N push for 2 s on a 4 kg crate (μ = 0.25), then it coasts to a stop.",
    prompt: "Push a 4 kg crate with 20 N for 2 seconds on a floor with friction 0.25",
    scenario: {
      metadata: { name: "Constant push against friction", source: "preset" },
      environment: { simulation_duration: 4 },
      objects: [
        { id: "crate", label: "Crate", type: "box", mass: 4, position: [-3, 0, 0], dimensions: { width: 0.5, height: 0.4, depth: 0.5 }, material: { name: "wood", friction_coefficient: 0.25 }, placement: { kind: "on_ground" } },
      ],
      forces: [{ id: "push", type: "applied_force", magnitude: 20, direction: [1, 0, 0], applies_to: ["crate"], start_time: 0, end_time: 2 }],
      expected_outcome: "Net force 20 − 0.25 × 4 × 9.81 = 10.2 N → a = 2.55 m/s² for 2 s (v = 5.1 m/s), then it decelerates at 2.45 m/s² for ~2.1 s.",
      physics_notes: "Newton's second law with friction: F_net = F_applied − μmg.",
    },
  },
  {
    id: "tower-knockdown",
    title: "Knocking down a tower",
    category: "Fun",
    summary: "A heavy ball smashes into a stack of wooden blocks.",
    prompt: "A 5 kg steel ball rolling at 6 m/s smashes into a tower of 6 wooden blocks",
    scenario: {
      metadata: { name: "Knocking down a tower", source: "preset" },
      environment: { simulation_duration: 5 },
      objects: [
        ...Array.from({ length: 6 }, (_, i) => ({
          id: `block_${i + 1}`,
          label: `Block ${i + 1}`,
          type: "box" as const,
          mass: 0.5,
          position: [2, 0.2 + i * 0.4005, 0] as [number, number, number],
          dimensions: { width: 0.4, height: 0.4, depth: 0.4 },
          material: { name: "wood", friction_coefficient: 0.5, restitution: 0.2 },
        })),
        { id: "wrecking_ball", label: "Steel ball", type: "sphere", mass: 5, position: [-3, 0.3, 0], velocity: [6, 0, 0], angular_velocity: [0, 0, -20], dimensions: { radius: 0.3 }, material: { name: "steel", friction_coefficient: 0.5, restitution: 0.3 } },
      ],
      expected_outcome: "The ball transfers momentum to the lower blocks and the tower topples.",
      physics_notes: "Momentum is conserved in the impact, but friction and inelastic collisions turn much of the kinetic energy into heat and sound.",
    },
  },
];

export const PRESETS: Preset[] = presetList;

export function presetScenario(id: string): Scenario {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown preset "${id}"`);
  return makeScenario(p.scenario);
}
