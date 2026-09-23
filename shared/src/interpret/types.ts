import { z } from "zod";
import type { Change } from "../patch";
import type { Scenario } from "../schema";
import type { Issue } from "../validate";

export interface Variation {
  label: string;
  description: string;
  changes: Change[];
}

export interface ClarifyingQuestion {
  question: string;
  /** Quick-reply options the user can click. */
  options: string[];
}

export interface Interpretation {
  summary: string;
  objects: { name: string; details: string }[];
  forces: { name: string; details: string }[];
  calculations: { label: string; expression: string; result: string }[];
  assumptions: string[];
  questions: ClarifyingQuestion[];
  expected_outcome: string;
  physics_notes: string;
}

export interface InterpretResult {
  /** "needs_clarification" means the scenario is only a rough draft (or null) until questions are answered. */
  status: "ready" | "needs_clarification";
  /** Short conversational reply shown in the chat. */
  reply: string;
  interpretation: Interpretation;
  scenario: Scenario | null;
  suggested_variations: Variation[];
  source: "ai" | "offline";
  model?: string;
  issues?: Issue[];
  /** Why the offline parser was used instead of the AI, if it was. */
  fallback_reason?: string;
}

export interface ExplainResult {
  explanation: string;
  key_points: string[];
  suggestions: Variation[];
  source: "ai" | "offline";
  model?: string;
}

/** Shape the AI must return for /interpret (validated server-side before the scenario is parsed). */
export const InterpretOutputSchema = z.object({
  status: z.enum(["ready", "needs_clarification"]),
  reply: z.string(),
  interpretation: z.object({
    summary: z.string(),
    objects: z.array(z.object({ name: z.string(), details: z.string() })),
    forces: z.array(z.object({ name: z.string(), details: z.string() })),
    calculations: z.array(z.object({ label: z.string(), expression: z.string(), result: z.string() })),
    assumptions: z.array(z.string()),
    questions: z.array(z.object({ question: z.string(), options: z.array(z.string()) })),
    expected_outcome: z.string(),
    physics_notes: z.string(),
  }),
  scenario: z.unknown(),
  suggested_variations: z.array(
    z.object({
      label: z.string(),
      description: z.string(),
      changes: z.array(z.object({ path: z.string(), value: z.unknown() })),
    }),
  ),
});
export type InterpretOutput = z.infer<typeof InterpretOutputSchema>;

export const ExplainOutputSchema = z.object({
  explanation: z.string(),
  key_points: z.array(z.string()),
  suggestions: z.array(
    z.object({
      label: z.string(),
      description: z.string(),
      changes: z.array(z.object({ path: z.string(), value: z.unknown() })),
    }),
  ),
});
export type ExplainOutput = z.infer<typeof ExplainOutputSchema>;
