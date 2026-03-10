import { createServer } from 'http';
import { readFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { spawn, exec } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function killOrphans() {
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      exec('pgrep -fa llama-server', (err, stdout) => {
        if (err && err.code !== 1) return reject(err);
        resolve({ stdout: stdout || '' });
      });
    });
    const lines = stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const pid = line.trim().split(' ')[0];
      if (pid && parseInt(pid) !== process.pid) {
        console.log(`[neuralforge] Killing orphan process: ${pid}`);
        try { process.kill(parseInt(pid), 'SIGKILL'); } catch {}
      }
    }
  } catch (e) {
    console.log('[neuralforge] Orphan check failed:', e.message);
  }
}

const PORT = parseInt(process.env.PORT || '5757');
const MODELS_DIR = process.env.MODELS_DIR || join(process.env.HOME, 'models');
const LLAMA_BIN = process.env.LLAMA_BIN || join(process.env.HOME, '.local/bin/llama-server');
const AUTOSTART_ALIAS = process.env.AUTOSTART_ALIAS || '';
const LLAMA_PORT = 8081;

const config = JSON.parse(readFileSync(join(__dirname, 'models.json'), 'utf8'));

// ── Circular log buffer ────────────────────────────────────────────────────────
class LogBuffer {
  constructor(size = 100) {
    this.size = size;
    this.lines = [];
  }
  push(line) {
    this.lines.push(line);
    if (this.lines.length > this.size) this.lines.shift();
  }
  get() { return this.lines; }
}

// ── LlamaManager ──────────────────────────────────────────────────────────────
class LlamaManager {
  constructor() {
    this.proc = null;
    this.alias = null;
    this.modelName = null;
    this.startTime = null;
    this.logs = new LogBuffer(100);
    this.switching = false;
  }

  async start(alias) {
    const aliasConfig = config.aliases[alias];
    if (!aliasConfig) throw new Error(`Unknown alias: ${alias}`);

    if (this.proc) await this.stop();
    await killOrphans();

    const d = config.defaults;
    const modelPath = aliasConfig.model.replace('~', process.env.HOME);
    const ctx = aliasConfig.ctx || 32768;
    const parallel = aliasConfig.parallel || d.parallel;
    const port = aliasConfig.port || d.port;
    const gpuLayers = aliasConfig.gpuLayers ?? d.gpuLayers;

    const args = [
      '--model', modelPath,
      '--port', String(port),
      '--ctx-size', String(ctx),
      '--n-gpu-layers', String(gpuLayers),
      '--host', d.host,
      '--parallel', String(parallel),
    ];
    if (d.contBatching) args.push('--cont-batching');
    if (d.noMmap) args.push('--no-mmap');
    if (d.noWarmup) args.push('--no-warmup');
    if (d.metrics) args.push('--metrics');
    if (d.ubatchSize) args.push('--ubatch-size', String(d.ubatchSize));

    const env = { ...process.env, LD_LIBRARY_PATH: `${process.env.HOME}/.local/bin:${process.env.LD_LIBRARY_PATH || ''}` };

    this.logs.push(`[neuralforge] Starting ${aliasConfig.name}...`);
    const proc = spawn(LLAMA_BIN, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', d => {
      for (const line of d.toString().split('\n')) {
        if (line.trim()) this.logs.push(line);
      }
    });
    proc.stderr.on('data', d => {
      for (const line of d.toString().split('\n')) {
        if (line.trim()) this.logs.push(line);
      }
    });
    proc.on('exit', (code) => {
      this.logs.push(`[neuralforge] llama-server exited (code ${code})`);
      if (this.proc === proc) {
        this.proc = null;
        this.alias = null;
        this.modelName = null;
        this.startTime = null;
      }
    });

    this.proc = proc;
    this.alias = alias;
    this.modelName = aliasConfig.name;
    this.startTime = Date.now();

    return { pid: proc.pid, model: aliasConfig.name };
  }

  async stop() {
    if (!this.proc) return;
    const proc = this.proc;
    this.alias = null;
    this.modelName = null;
    this.startTime = null;

    proc.kill('SIGTERM');
    await new Promise(resolve => {
      const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(); }, 8000);
      proc.on('exit', () => { 
        clearTimeout(t);
        if (this.proc === proc) {
          this.proc = null;
          this.alias = null;
          this.modelName = null;
          this.startTime = null;
        }
        resolve(); 
      });
    });
    this.proc = null;
    await waitPortFree(LLAMA_PORT, 10000);
  }

  status() {
    const running = !!this.proc;
    const uptime = running && this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0;
    return {
      running,
      alias: this.alias,
      model: this.modelName,
      pid: this.proc?.pid || null,
      uptime,
      switching: this.switching,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function checkHealth() {
  try {
    const res = await fetch(`http://localhost:${LLAMA_PORT}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

async function waitPortFree(port, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const free = !(await checkHealth());
    if (free) return;
    await new Promise(r => setTimeout(r, 500));
  }
}

async function readSysfs(path) {
  try { return (await readFile(path, 'utf8')).trim(); }
  catch { return null; }
}

async function getGpuStats() {
  const base = '/sys/class/drm/card1/device';
  const [busy, gttUsed, gttTotal, vramUsed, vramTotal, sclk] = await Promise.all([
    readSysfs(`${base}/gpu_busy_percent`),
    readSysfs(`${base}/mem_info_gtt_used`),
    readSysfs(`${base}/mem_info_gtt_total`),
    readSysfs(`${base}/mem_info_vram_used`),
    readSysfs(`${base}/mem_info_vram_total`),
    readSysfs(`${base}/pp_dpm_sclk`),
  ]);

  // CPU temp from k10temp hwmon
  let cpuTemp = null;
  try {
    const hwmonBase = '/sys/class/hwmon';
    const hwmons = readdirSync(hwmonBase);
    for (const hw of hwmons) {
      const name = await readSysfs(`${hwmonBase}/${hw}/name`);
      if (name === 'k10temp') {
        const raw = await readSysfs(`${hwmonBase}/${hw}/temp1_input`);
        if (raw) cpuTemp = parseInt(raw) / 1000;
        break;
      }
    }
  } catch {}

  // Parse active clock from pp_dpm_sclk (last line, e.g. "2: 1900Mhz *")
  let clockMhz = null;
  if (sclk) {
    const lines = sclk.trim().split('\n');
    const last = lines[lines.length - 1];
    const m = last.match(/(\d+)Mhz/i);
    if (m) clockMhz = parseInt(m[1]);
  }

  return {
    busyPct: busy !== null ? parseInt(busy) : null,
    gttUsedGB: gttUsed !== null ? (parseInt(gttUsed) / 1e9).toFixed(1) : null,
    gttTotalGB: gttTotal !== null ? (parseInt(gttTotal) / 1e9).toFixed(1) : null,
    vramUsedMB: vramUsed !== null ? Math.round(parseInt(vramUsed) / 1e6) : null,
    vramTotalMB: vramTotal !== null ? Math.round(parseInt(vramTotal) / 1e6) : null,
    clockMhz,
    cpuTempC: cpuTemp,
  };
}

let _prevMetrics = null;
async function getLlamaMetrics() {
  try {
    const res = await fetch(`http://localhost:${LLAMA_PORT}/metrics`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const text = await res.text();

    const parseVal = (name) => {
      const m = text.match(new RegExp(`^${name}(?:\\{[^}]*\\})?\\s+([\\d.e+]+)`, 'm'));
      return m ? parseFloat(m[1]) : null;
    };

    const tokensTotal = parseVal('llamacpp:tokens_predicted_total');
    const secondsTotal = parseVal('llamacpp:tokens_predicted_seconds_total');
    const processing = parseVal('llamacpp:requests_processing');
    const kvUsage = parseVal('llamacpp:kv_cache_usage_ratio');

    // Compute avg t/s from cumulative counters
    let tps = null;
    if (tokensTotal !== null && secondsTotal !== null && secondsTotal > 0) {
      tps = (tokensTotal / secondsTotal).toFixed(1);
    }

    return { tps, processing, kvUsagePct: kvUsage != null ? (kvUsage * 100).toFixed(0) : null };
  } catch { return null; }
}

async function discoverModels() {
  const found = [];
  function walk(dir, depth = 0) {
    if (depth > 3) return;
    try {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        try {
          const st = statSync(full);
          if (st.isDirectory()) walk(full, depth + 1);
          else if (entry.endsWith('.gguf') && !entry.match(/\d{5}-of-\d{5}(?!\.gguf$)/) ) {
            // Skip non-first shards (include 00001-of-NNNNN, skip 00002+ shards)
            const shardMatch = entry.match(/-(\d{5})-of-(\d{5})\.gguf$/);
            if (!shardMatch || shardMatch[1] === '00001') {
              found.push(full);
            }
          }
        } catch {}
      }
    } catch {}
  }
  walk(MODELS_DIR);
  return found;
}

// ── SSE clients ───────────────────────────────────────────────────────────────
const sseClients = new Set();

function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// ── Main server ───────────────────────────────────────────────────────────────
const manager = new LlamaManager();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // SSE stream
  if (path === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // API routes
  if (path === '/api/status' && req.method === 'GET') {
    const st = manager.status();
    let llamaHealth = false;
    if (st.running) llamaHealth = await checkHealth();
    json(res, { ...st, healthy: llamaHealth });
    return;
  }

  if (path === '/api/gpu' && req.method === 'GET') {
    json(res, await getGpuStats());
    return;
  }

  if (path === '/api/models' && req.method === 'GET') {
    const discovered = await discoverModels();
    const aliases = Object.fromEntries(
      Object.entries(config.aliases).filter(([, info]) =>
        existsSync(info.model.replace('~', process.env.HOME))
      )
    );
    json(res, {
      aliases,
      discovered: discovered.map(p => ({ path: p, name: p.replace(MODELS_DIR + '/', '') })),
    });
    return;
  }

  if (path === '/api/logs' && req.method === 'GET') {
    json(res, { lines: manager.logs.get() });
    return;
  }

  if (path === '/api/start' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { alias } = JSON.parse(body || '{}');
        if (!alias) { error(res, 400, 'alias required'); return; }
        manager.switching = true;
        broadcastSSE({ type: 'switching', alias });
        const result = await manager.start(alias);
        manager.switching = false;
        broadcastSSE({ type: 'started', ...result });
        json(res, { ok: true, ...result });
      } catch (e) {
        manager.switching = false;
        error(res, 500, e.message);
      }
    });
    return;
  }

  if (path === '/api/stop' && req.method === 'POST') {
    await manager.stop();
    broadcastSSE({ type: 'stopped' });
    json(res, { ok: true });
    return;
  }

  // Static files — serve index.html for everything else
  const staticPath = join(__dirname, 'public', 'index.html');
  try {
    const html = readFileSync(staticPath);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

function json(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function error(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

// SSE broadcast loop
setInterval(async () => {
  if (sseClients.size === 0) return;
  const [gpu, status, metrics] = await Promise.all([getGpuStats(), Promise.resolve(manager.status()), getLlamaMetrics()]);
  broadcastSSE({ type: 'update', gpu, status, metrics });
}, 2000);

// Startup
server.listen(PORT, async () => {
  console.log(`[neuralforge] Listening on port ${PORT}`);
  await killOrphans();
  if (AUTOSTART_ALIAS) {
    console.log(`[neuralforge] Autostarting: ${AUTOSTART_ALIAS}`);
    setTimeout(() => manager.start(AUTOSTART_ALIAS).catch(console.error), 3000);
  }
});

process.on('SIGTERM', async () => {
  console.log('[neuralforge] Shutting down...');
  await manager.stop();
  process.exit(0);
});
