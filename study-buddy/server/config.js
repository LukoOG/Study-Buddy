import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Which models to use lives in a JSON file so they can be swapped without code changes.
// Point MODELS_CONFIG at another file (e.g. a phone running llama-server) to switch.
const modelsFile = path.resolve(root, process.env.MODELS_CONFIG ?? 'models.config.json');

export const config = {
  root,
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3000),
  modelsFile,
  models: JSON.parse(readFileSync(modelsFile, 'utf8')),
};
