import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { createProviders } from './providers/index.js';
import { askStream } from './pipeline.js';

const { llm, stt, tts } = createProviders(config.models);

const staticRoots = [
  ['/vendor/pdfjs/', path.join(config.root, 'node_modules/pdfjs-dist/')],
  ['/vendor/vad/', path.join(config.root, 'node_modules/@ricky0123/vad-web/dist/')],
  ['/vendor/ort/', path.join(config.root, 'node_modules/onnxruntime-web/dist/')],
  ['/samples/', path.join(config.root, 'samples/')],
  ['/', path.join(config.root, 'web/')],
];
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.pdf': 'application/pdf', '.json': 'application/json', '.map': 'application/json',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream',
};

async function readBody(req, limit = 25 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function serveStatic(pathname, res) {
  for (const [prefix, dir] of staticRoots) {
    if (!pathname.startsWith(prefix)) continue;
    const rel = pathname.slice(prefix.length) || 'index.html';
    const file = path.join(dir, decodeURIComponent(rel));
    if (!file.startsWith(dir)) break;
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
      return res.end(data);
    } catch {
      break;
    }
  }
  res.writeHead(404).end('Not found');
}

async function status() {
  const [llmUp, sttUp, ttsUp] = await Promise.all([llm.health(), stt.health(), tts.health()]);
  return {
    llm: { up: llmUp, name: llm.name, vision: llm.vision },
    stt: { up: sttUp, name: stt.name },
    tts: { up: ttsUp, name: tts.name, server: tts.server },
  };
}

// Streams one sentence of audio from the server-side voice. Cancelled if the student interrupts.
async function handleSpeak(req, res) {
  const { text, voice } = JSON.parse(await readBody(req));
  const controller = new AbortController();
  res.on('close', () => res.writableEnded || controller.abort());
  const started = Date.now();
  const { body, contentType } = await tts.synthesize(text, { signal: controller.signal, voice });
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  try {
    for await (const chunk of body) res.write(chunk);
    res.end();
    console.log(`spoke (${Date.now() - started}ms): ${text}`);
  } catch (err) {
    if (!controller.signal.aborted) throw err;
  }
}

// Streams the answer as newline-delimited JSON: {"step": {...}} per step, then {"done": true}.
// If the client hangs up (the student interrupted), generation is cancelled.
async function handleAsk(req, res) {
  const body = JSON.parse(await readBody(req));
  const llmUp = await llm.health();
  const controller = new AbortController();
  res.on('close', () => res.writableEnded || controller.abort());
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });

  const started = Date.now();
  let first;
  try {
    for await (const step of askStream({ ...body, llm, llmUp, signal: controller.signal })) {
      first ??= Date.now() - started;
      res.write(`${JSON.stringify({ step })}\n`);
    }
    res.end(`${JSON.stringify({ done: true })}\n`);
    console.log(`ask (${llmUp ? llm.name : 'mock'}) first step ${first}ms, total ${Date.now() - started}ms, ${body.items?.length ?? 0} words${body.image ? ' + image' : ''}: ${body.question}`);
  } catch (err) {
    if (controller.signal.aborted) return console.log(`ask interrupted: ${body.question}`);
    console.error(err);
    res.end(`${JSON.stringify({ error: err.message })}\n`);
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && pathname === '/api/status') return sendJson(res, 200, await status());
    if (req.method === 'POST' && pathname === '/api/transcribe') {
      const started = Date.now();
      const text = await stt.transcribe(await readBody(req));
      console.log(`heard (${Date.now() - started}ms): ${text}`);
      return sendJson(res, 200, { text });
    }
    if (req.method === 'POST' && pathname === '/api/ask') return await handleAsk(req, res);
    if (req.method === 'POST' && pathname === '/api/speak' && tts.server) return await handleSpeak(req, res);
    if (req.method === 'GET') return serveStatic(pathname, res);
    res.writeHead(405).end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendJson(res, 500, { error: err.message });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Study Buddy on http://localhost:${config.port}`);
  console.log(`Models from ${path.relative(config.root, config.modelsFile)}: llm=${llm.name}, stt=${stt.name}, tts=${tts.name}`);
});
