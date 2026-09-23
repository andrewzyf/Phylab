import {
  explainOffline,
  interpretOffline,
  type ExplainRequest,
  type ExplainResult,
  type InterpretResult,
  type Scenario,
} from "@physicslab/shared";

export interface Health {
  ok: boolean;
  ai: { enabled: boolean; model: string | null; effort: string | null };
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw Object.assign(new Error(err?.error ?? `Request failed (${res.status})`), { status: res.status });
  }
  return (await res.json()) as T;
}

export async function fetchHealth(): Promise<Health | null> {
  try {
    const res = await fetch("/api/health");
    if (!res.ok) return null;
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}

/**
 * Interpret a description. If the server can't be reached at all (static hosting, offline), the
 * same rule-based interpreter runs in the browser.
 */
export async function interpret(
  message: string,
  scenario: Scenario | null,
  history: ChatTurn[],
  signal?: AbortSignal,
): Promise<InterpretResult> {
  try {
    return await post<InterpretResult>("/api/interpret", { message, scenario, history }, signal);
  } catch (err) {
    if ((err as { status?: number }).status === 400) throw err;
    if ((err as Error).name === "AbortError") throw err;
    return { ...interpretOffline(message, scenario), fallback_reason: "The PhysicsLab server isn't reachable, so the in-browser interpreter was used." };
  }
}

export async function explain(req: ExplainRequest, offline = false): Promise<ExplainResult> {
  if (offline) return explainOffline(req);
  try {
    return await post<ExplainResult>("/api/explain", req);
  } catch {
    return explainOffline(req);
  }
}
