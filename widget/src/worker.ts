import { solvePuzzle } from "./sha256";

export interface SolveJob {
  salt: string;
  puzzles: number;
  bits: number;
}

export type WorkerMsg =
  | { type: "progress"; done: number; total: number }
  | { type: "done"; nonces: number[]; ms: number };

const ctx = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (e: MessageEvent<SolveJob>) => {
  const { salt, puzzles, bits } = e.data;
  const start = performance.now();
  const nonces: number[] = [];
  for (let i = 0; i < puzzles; i++) {
    nonces.push(solvePuzzle(salt, i, bits));
    ctx.postMessage({ type: "progress", done: i + 1, total: puzzles } satisfies WorkerMsg);
  }
  ctx.postMessage({ type: "done", nonces, ms: Math.round(performance.now() - start) } satisfies WorkerMsg);
};
