// Minimal ambient declarations for globals available in both Node 18+ and browsers/workers,
// so the shared package doesn't need the DOM or Node type libraries.
declare function structuredClone<T>(value: T): T;
declare const performance: { now(): number };
