import { context, build } from "esbuild";
import { copyFile, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import JavaScriptObfuscator from "javascript-obfuscator";

const watch = process.argv.includes("--watch");
const VARIANTS = Number(process.env.FRAME_VARIANTS ?? 8);
const options = {
  entryPoints: {
    api: "src/api.ts",
    frame: "src/frame.ts",
    worker: "src/worker.ts",
    gate: "src/gate.ts",
  },
  outdir: "dist",
  bundle: true,
  format: "iife",
  target: ["es2019", "safari13"],
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  legalComments: "none",
};

// frame.js runs inside our iframe and carries the client half of the
// challenge, so it ships heavily obfuscated, in several differently-seeded
// variants the server rotates between. CSP-safe: no eval/Function. The worker
// (hot SHA-256 loop) and api.js (public host API) stay readable and fast.
const OBFUSCATION = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.1,
  identifierNamesGenerator: "hexadecimal",
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: true,
  simplify: true,
  splitStrings: false,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayCallsTransformThreshold: 0.5,
  stringArrayEncoding: ["rc4"],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 1,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 4,
  stringArrayWrappersType: "function",
  stringArrayThreshold: 1,
  transformObjectKeys: true,
  unicodeEscapeSequence: false,
  // Strings the server or host page look for must survive.
  reservedStrings: ["^__roundabout$"],
};

async function obfuscateFrame() {
  for (const f of await readdir("dist")) {
    if (/^frame\.v\d+\.js$/.test(f)) await rm(`dist/${f}`);
  }
  const src = await readFile("dist/frame.js", "utf8");
  for (let i = 0; i < VARIANTS; i++) {
    const out = JavaScriptObfuscator.obfuscate(src, { ...OBFUSCATION, seed: Math.floor(Math.random() * 2 ** 31) });
    await writeFile(`dist/frame.v${i}.js`, out.getObfuscatedCode());
  }
}

await mkdir("dist", { recursive: true });
await copyFile("src/frame.css", "dist/frame.css");

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log("watching widget sources… (frame.js unobfuscated in watch mode)");
} else {
  await build(options);
  await obfuscateFrame();
  console.log(`built widget → dist/ (${VARIANTS} obfuscated frame variants)`);
}
