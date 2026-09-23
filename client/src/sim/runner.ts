import { resolveScenario, simulate, type Recording, type Scenario } from "@physicslab/shared";
import type { SimReply } from "./sim.worker";

/**
 * Runs simulations in a Web Worker per channel ("A", "B", "history"...). A newer job on the same
 * channel cancels the older one by terminating its worker, so dragging a slider never queues up work.
 */
export class SimRunner {
  private workers = new Map<string, Worker>();
  private busy = new Map<string, number>();
  private seq = 0;

  run(channel: string, scenario: Scenario, onProgress?: (p: number) => void): Promise<Recording> {
    const id = ++this.seq;
    if (typeof Worker === "undefined") return Promise.resolve(simulate(resolveScenario(scenario)));
    if (this.busy.has(channel)) {
      this.workers.get(channel)?.terminate();
      this.workers.delete(channel);
    }
    let worker = this.workers.get(channel);
    if (!worker) {
      worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
      this.workers.set(channel, worker);
    }
    this.busy.set(channel, id);
    const w = worker;
    return new Promise<Recording>((resolve, reject) => {
      const cleanup = () => {
        w.removeEventListener("message", onMessage);
        w.removeEventListener("error", onError);
        if (this.busy.get(channel) === id) this.busy.delete(channel);
      };
      const onMessage = (e: MessageEvent<SimReply>) => {
        const msg = e.data;
        if (msg.id !== id) return;
        if (msg.type === "progress") onProgress?.(msg.progress);
        else if (msg.type === "done") {
          cleanup();
          resolve(msg.recording);
        } else {
          cleanup();
          reject(new Error(msg.error));
        }
      };
      const onError = (e: ErrorEvent) => {
        cleanup();
        reject(new Error(e.message || "Simulation worker failed."));
      };
      w.addEventListener("message", onMessage);
      w.addEventListener("error", onError);
      w.postMessage({ id, scenario });
    });
  }

  /** True if `channel` is still running a job started after `id`. */
  isCurrent(channel: string, id: number) {
    return this.busy.get(channel) === id;
  }
}

export const simRunner = new SimRunner();
