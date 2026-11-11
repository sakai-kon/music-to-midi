import { cpSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const packageJson = require.resolve("@spotify/basic-pitch/package.json");
const packageRoot = dirname(packageJson);
const modelSource = join(packageRoot, "model");
const modelTarget = join(process.cwd(), "public", "models");

if (!existsSync(join(modelSource, "model.json"))) {
  throw new Error("Spotify Basic Pitch model files were not found in the installed package.");
}

mkdirSync(modelTarget, { recursive: true });
cpSync(modelSource, modelTarget, { recursive: true });
console.log("Copied Spotify Basic Pitch model to public/models.");
