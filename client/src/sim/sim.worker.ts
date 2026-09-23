/// <reference lib="webworker" />
import { recordingTransferables, resolveScenario, simulate, type Scenario } from "@physicslab/shared";

export interface SimJob {
  id: number;
  scenario: Scenario;
}

export type SimReply =
  | { id: number; type: "progress"; progress: number }
  | { id: number; type: "done"; recording: ReturnType<typeof simulate> }
  | { id: number; type: "error"; error: string };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<SimJob>) => {
  const { id, scenario } = e.data;
  try {
    const rs = resolveScenario(scenario);
    let last = 0;
    const recording = simulate(rs, {
      onProgress: (p) => {
        const now = performance.now();
        if (now - last > 80) {
          last = now;
          ctx.postMessage({ id, type: "progress", progress: p } satisfies SimReply);
        }
      },
    });
    ctx.postMessage({ id, type: "done", recording } satisfies SimReply, recordingTransferables(recording));
  } catch (err) {
    ctx.postMessage({ id, type: "error", error: err instanceof Error ? err.message : String(err) } satisfies SimReply);
  }
};
