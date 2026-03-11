import { createServer, request as httpRequest } from 'http';
import { readFileSync, existsSync, createWriteStream, writeFileSync } from 'fs';
import { spawn, exec } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFile, readdir, stat, mkdir, rename, unlink, statfs } from 'fs/promises';

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

const PORT_BASE = 8081; // first port to assign; models can pin their own port in models.json

// Assign the next free port >= PORT_BASE, skipping ports already in use by running managers.
function assignPort(aliasConfig) {
  if (aliasConfig.port) return aliasConfig.port;
  const usedPorts = new Set([...managers.values()].map(m => m.port).filter(Boolean));
  let p = PORT_BASE;
  while (usedPorts.has(p)) p++;
  return p;
}

function readConfig() {
  return JSON.parse(readFileSync(join(__dirname, 'models.json'), 'utf8'));
}

// ── Circular log buffer ────────────────────────────────────────────────────────
class LogBuffer {
  constructor(size = 500) {
    this.size = size;
    this.lines = [];
  }
  push(text, prefix) {
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const line = prefix ? `${ts} ${prefix} ${text}` : `${ts} ${text}`;
    this.lines.push(line);
    if (this.lines.length > this.size) this.lines.shift();
    // Broadcast to any connected SSE clients immediately
    if (typeof broadcastSSE === 'function') {
      broadcastSSE({ type: 'log', line });
    }
    return line;
  }
  get() { return [...this.lines]; }
}

const appLog = new LogBuffer(500);

// Intercept console.log/error so NeuralForge's own output appears in the dashboard
const _origLog   = console.log.bind(console);
const _origError = console.error.bind(console);
console.log   = (...a) => { const t = a.map(String).join(' '); _origLog(t);   appLog.push(t); };
console.error = (...a) => { const t = a.map(String).join(' '); _origError(t); appLog.push(t); };

// ── LlamaManager ──────────────────────────────────────────────────────────────
class LlamaManager {
  constructor() {
    this.proc = null;
    this.alias = null;
    this.modelName = null;
    this.startTime = null;
    this.port = null;
    this.switching = false;
  }

  async start(alias) {
    const config = readConfig();
    const aliasConfig = config.aliases[alias];
    if (!aliasConfig) throw new Error(`Unknown alias: ${alias}`);

    // No stop-others here — the pool manages multiple instances.
    // killOrphans() is only called once at boot.

    const d = config.defaults;
    const modelPath = aliasConfig.model.replace('~', process.env.HOME);
    const ctx = aliasConfig.ctx || 32768;
    const parallel = aliasConfig.parallel || d.parallel;
    const port = assignPort(aliasConfig);
    const gpuLayers  = aliasConfig.gpuLayers  ?? d.gpuLayers;
    const batchSize  = aliasConfig.batchSize  ?? d.batchSize;
    const ubatchSize = aliasConfig.ubatchSize ?? d.ubatchSize;
    const flashAttn  = aliasConfig.flashAttn  ?? d.flashAttn;
    const cacheTypeK = aliasConfig.cacheTypeK  ?? d.cacheTypeK;
    const cacheTypeV = aliasConfig.cacheTypeV  ?? d.cacheTypeV;

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
    if (batchSize)  args.push('--batch-size',  String(batchSize));
    if (ubatchSize) args.push('--ubatch-size', String(ubatchSize));
    if (flashAttn !== undefined) args.push('--flash-attn', flashAttn ? 'on' : 'off');
    if (cacheTypeK) args.push('--cache-type-k', cacheTypeK);
    if (cacheTypeV) args.push('--cache-type-v', cacheTypeV);

    const env = { ...process.env, LD_LIBRARY_PATH: `${process.env.HOME}/.local/bin:${process.env.LD_LIBRARY_PATH || ''}` };

    appLog.push(`Starting ${aliasConfig.name}...`, '[neuralforge]');
    const proc = spawn(LLAMA_BIN, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', d => {
      for (const line of d.toString().split('\n')) {
        if (line.trim()) appLog.push(line, `[${alias}]`);
      }
    });
    proc.stderr.on('data', d => {
      for (const line of d.toString().split('\n')) {
        if (line.trim()) appLog.push(line, `[${alias}]`);
      }
    });
    proc.on('exit', (code) => {
      appLog.push(`llama-server exited (code ${code})`, `[${alias}]`);
      if (this.proc === proc) {
        this.proc = null;
        this.alias = null;
        this.modelName = null;
        this.startTime = null;
        this.port = null;
        // Remove from pool so the instance doesn't appear as a dead entry
        managers.delete(alias);
        broadcastSSE({ type: 'stopped', alias });
      }
    });

    this.proc = proc;
    this.alias = alias;
    this.modelName = aliasConfig.name;
    this.startTime = Date.now();
    this.port = port;

    return { pid: proc.pid, model: aliasConfig.name, port };
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
    await waitPortFree(this.port, 10000);
    this.port = null;
  }

  status() {
    const running = !!this.proc;
    const uptime = running && this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0;
    return {
      running,
      alias: this.alias,
      model: this.modelName,
      pid: this.proc?.pid || null,
      port: this.port,
      uptime,
      switching: this.switching,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function checkHealth(port = PORT_BASE) {
  try {
    const res = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch { return false; }
}

async function waitPortFree(port, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const free = !(await checkHealth(port));
    if (free) return;
    await new Promise(r => setTimeout(r, 500));
  }
}

async function readSysfs(path) {
  try { return (await readFile(path, 'utf8')).trim(); }
  catch { return null; }
}

let _prevCpuStat = null;
async function getCpuPct() {
  try {
    const raw = await readFile('/proc/stat', 'utf8');
    const line = raw.split('\n')[0]; // 'cpu  user nice system idle iowait irq softirq ...'
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);
    if (_prevCpuStat) {
      const dTotal = total - _prevCpuStat.total;
      const dIdle  = idle  - _prevCpuStat.idle;
      _prevCpuStat = { total, idle };
      return dTotal > 0 ? Math.round(100 * (1 - dIdle / dTotal)) : 0;
    }
    _prevCpuStat = { total, idle };
    return null;
  } catch { return null; }
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

  const cpuPct = await getCpuPct();

  let diskUsedGB = null, diskTotalGB = null;
  try {
    const s = await statfs('/home');
    const total = s.blocks * s.bsize;
    const avail = s.bavail * s.bsize;
    diskTotalGB = (total / 1e9).toFixed(1);
    diskUsedGB  = ((total - avail) / 1e9).toFixed(1);
  } catch {}

  return {
    busyPct: busy !== null ? parseInt(busy) : null,
    gttUsedGB: gttUsed !== null ? (parseInt(gttUsed) / 1e9).toFixed(1) : null,
    gttTotalGB: gttTotal !== null ? (parseInt(gttTotal) / 1e9).toFixed(1) : null,
    vramUsedMB: vramUsed !== null ? Math.round(parseInt(vramUsed) / 1e6) : null,
    vramTotalMB: vramTotal !== null ? Math.round(parseInt(vramTotal) / 1e6) : null,
    clockMhz,
    cpuTempC: cpuTemp,
    cpuPct,
    diskUsedGB,
    diskTotalGB,
  };
}

async function getLlamaMetrics(port = PORT_BASE) {
  try {
    const res = await fetch(`http://localhost:${port}/metrics`, { signal: AbortSignal.timeout(1500) });
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
  async function walk(dir, depth = 0) {
    if (depth > 3) return;
    let entries;
    try { entries = await readdir(dir); } catch { return; }
    await Promise.all(entries.map(async entry => {
      const full = join(dir, entry);
      let st;
      try { st = await stat(full); } catch { return; }
      if (st.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.endsWith('.gguf')) {
        // Skip non-first shards (include 00001-of-NNNNN, skip 00002+)
        const shardMatch = entry.match(/-([0-9]{5})-of-([0-9]{5})\.gguf$/);
        if (!shardMatch || shardMatch[1] === '00001') {
          found.push(full);
        }
      }
    }));
  }
  await walk(MODELS_DIR);
  return found;
}

// ── HuggingFace Hub ───────────────────────────────────────────────────────────
const HF_API = 'https://huggingface.co/api';
const HF_TOKEN = process.env.HF_TOKEN || null;

function hfHeaders() {
  return HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {};
}

// Known architecture keywords to surface as a badge
const HF_ARCH_TAGS = ['llama','mistral','qwen','phi','gemma','falcon','gpt','mixtral','deepseek','mamba','command','yi','solar','internlm','baichuan','bloom','codellama','starcoder','wizardcoder','openchat','vicuna','orca','hermes','dolphin','nous'];

// Capability detection: tag patterns → label shown in UI
const HF_CAPS = [
  { label: '🔧 tools',   patterns: ['function-calling','tool-use','tools','function_calling'] },
  { label: '👁 vision',  patterns: ['vision','multimodal','image-text-to-text','image-to-text','visual'] },
  { label: '💻 code',    patterns: ['code','coding','code-generation','starcoder','codellama'] },
  { label: '🧮 math',    patterns: ['math','mathematics','reasoning'] },
  { label: '🔒 gated',   patterns: ['gated'] },
];

function hfExtractCaps(tags = [], modelId = '') {
  const haystack = [...tags.map(t => t.toLowerCase()), modelId.toLowerCase()];
  return HF_CAPS
    .filter(cap => cap.patterns.some(p => haystack.some(h => h.includes(p))))
    .map(cap => cap.label);
}

function hfExtractArch(tags = []) {
  for (const t of tags) {
    const tl = t.toLowerCase();
    for (const a of HF_ARCH_TAGS) if (tl.includes(a)) return a;
  }
  return null;
}

function hfParseQuant(filename) {
  const m = filename.match(/[._-]((?:IQ|BF|[QqFf])[0-9][A-Za-z0-9_]*)\.gguf$/i);
  return m ? m[1].toUpperCase() : null;
}

// Parse a HuggingFace URL or "owner/repo" into { repoId, filename }
// Accepts full blob/resolve URLs, owner/repo/file.gguf, or bare owner/repo
function hfParseUrl(input) {
  const s = input.trim();
  const urlMatch = s.match(/huggingface\.co\/([^/]+\/[^/]+?)(?:\/(?:resolve|blob|tree)\/[^/]+(?:\/(.+\.gguf))?)?(?:\?.*)?$/);
  if (urlMatch) return { repoId: urlMatch[1], filename: urlMatch[2] || null };
  const slashFile = s.match(/^([^/]+\/[^/]+)\/(.+\.gguf)$/i);
  if (slashFile) return { repoId: slashFile[1], filename: slashFile[2] };
  const repoOnly = s.match(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
  if (repoOnly) return { repoId: s, filename: null };
  return null;
}

const QUANT_COLORS = {
  F32:'#adb5bd', BF16:'#adb5bd', F16:'#adb5bd',
  Q8_0:'#4dabce', Q8_K_XL:'#4dabce', Q6_K:'#4dabce', Q6_K_S:'#4dabce', Q6_K_XL:'#4dabce',
  Q5_K_M:'#20c997', Q5_K_S:'#20c997', Q5_K_XL:'#20c997', Q5_0:'#20c997', Q5_1:'#20c997',
  Q4_K_M:'#7ecb7e', Q4_K_S:'#7ecb7e', Q4_K_L:'#7ecb7e', Q4_K_XL:'#7ecb7e', Q4_0:'#7ecb7e', Q4_1:'#7ecb7e',
  Q3_K_M:'#fd7e14', Q3_K_S:'#fd7e14', Q3_K_L:'#fd7e14', Q3_K_XL:'#fd7e14',
  Q2_K:'#dc3545', Q2_K_XL:'#dc3545',
};
function quantColor(q) {
  if (!q) return '#6c757d';
  if (QUANT_COLORS[q]) return QUANT_COLORS[q];
  if (q.startsWith('IQ')) return '#c084fc';
  if (q.startsWith('Q8') || q.startsWith('Q6')) return '#4dabce';
  if (q.startsWith('Q5')) return '#20c997';
  if (q.startsWith('Q4')) return '#7ecb7e';
  if (q.startsWith('Q3')) return '#fd7e14';
  if (q.startsWith('Q2')) return '#dc3545';
  return '#6c757d';
}

async function hfRepoFiles(repoId) {
  const url = `${HF_API}/models/${repoId}?blobs=true`;
  const res = await fetch(url, { headers: hfHeaders(), signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HF fetch failed: ${res.status}`);
  const data = await res.json();
  return (data.siblings || [])
    .filter(f => f.rfilename.endsWith('.gguf'))
    .map(f => {
      const quant = hfParseQuant(f.rfilename);
      const shardMatch = f.rfilename.match(/-(\d{5})-of-(\d{5})\.gguf$/);
      const shard = shardMatch ? { part: parseInt(shardMatch[1]), total: parseInt(shardMatch[2]) } : null;
      return {
        name: f.rfilename,
        size: f.size || null,
        quant,
        quantColor: quantColor(quant),
        shard,
        recommended: quant === 'Q4_K_M',
      };
    });
}

// active + recently finished downloads, keyed by "repoId/filename"
const downloads = new Map();

function validateHFInput(repoId, filename) {
  // repoId must be "owner/repo"
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9._-]*)\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(repoId))
    throw new Error('Invalid repoId');
  // filename base (we only keep the basename) must be a safe .gguf name
  const base = filename.split('/').pop();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.gguf$/i.test(base))
    throw new Error('Invalid filename');
  return base;
}

async function startDownload(repoId, filename, meta = {}) {
  const cleanName = validateHFInput(repoId, filename);
  const key = `${repoId}/${cleanName}`;

  const existing = downloads.get(key);
  if (existing && !existing.done && !existing.error) throw new Error('Already downloading');

  const destDir = join(MODELS_DIR, repoId.replace('/', '--'));
  await mkdir(destDir, { recursive: true });
  const dest = join(destDir, cleanName);
  const tmp  = dest + '.tmp';

  const controller = new AbortController();
  const entry = { repoId, filename: cleanName, dest, bytes: 0, total: 0, done: false, error: null, controller };
  downloads.set(key, entry);

  (async () => {
    try {
      const url = `https://huggingface.co/${repoId}/resolve/main/${cleanName}`;
      const res = await fetch(url, { headers: hfHeaders(), signal: controller.signal, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      entry.total = parseInt(res.headers.get('content-length') || '0');
      const writer = createWriteStream(tmp);
      let lastBroadcast = 0;

      for await (const chunk of res.body) {
        writer.write(chunk);
        entry.bytes += chunk.length;
        const now = Date.now();
        if (now - lastBroadcast > 800) {
          lastBroadcast = now;
          broadcastSSE({ type: 'hf-progress', key, bytes: entry.bytes, total: entry.total });
        }
      }
      await new Promise((resolve, reject) => writer.end(err => err ? reject(err) : resolve()));

      await rename(tmp, dest);
      entry.done = true;

      const alias = addModelAlias(repoId, cleanName, dest, meta);
      broadcastSSE({ type: 'hf-done', key, alias });
    } catch (err) {
      if (err.name !== 'AbortError') {
        entry.error = err.message;
        broadcastSSE({ type: 'hf-error', key, error: err.message });
      }
      try { await unlink(tmp); } catch {}
    }
  })();

  return key;
}

function addModelAlias(repoId, filename, dest, meta = {}) {
  const cfgPath = join(__dirname, 'models.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));

  // Build a short alias slug from the filename
  const base = filename.replace(/\.gguf$/i, '');
  let slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 20).replace(/-$/, '');
  let alias = slug;
  let i = 2;
  while (cfg.aliases[alias]) alias = `${slug}-${i++}`;

  const quantTag = hfParseQuant(filename) || filename.match(/([qQ][0-9][^.]*)/)?.[1] || '';
  const entry = {
    name: `${repoId.split('/').pop()}${quantTag ? ' ' + quantTag : ''}`,
    model: dest,
    ctx: 32768,
    parallel: 2,
  };

  // Persist HF metadata so the dashboard and users can see it later
  if (meta.hfRepoId)       entry.hfRepoId       = meta.hfRepoId;
  if (meta.hfFilename)     entry.hfFilename     = meta.hfFilename;
  if (meta.arch)           entry.arch           = meta.arch;
  if (meta.pipeline)       entry.pipeline       = meta.pipeline;
  if (meta.caps?.length)   entry.caps           = meta.caps;
  if (meta.likes != null)  entry.hfLikes        = meta.likes;
  if (meta.downloads != null) entry.hfDownloads = meta.downloads;
  if (meta.fileSize)       entry.fileSize       = meta.fileSize;
  if (meta.lastModified)   entry.hfLastModified = meta.lastModified;

  cfg.aliases[alias] = entry;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  return alias;
}

// ── SSE clients ───────────────────────────────────────────────────────────────
const sseClients = new Set();

function broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { sseClients.delete(res); }
  }
}

// ── Manager pool ─────────────────────────────────────────────────────────────
// Map<alias, LlamaManager> — each running model has its own manager instance.
const managers = new Map();

function getManager(alias) {
  if (!managers.has(alias)) managers.set(alias, new LlamaManager());
  return managers.get(alias);
}

// ── Main server ───────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS for local dev
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // SSE stream - just send status updates, logs always fetched via polling
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
    const instanceEntries = await Promise.all(
      [...managers.entries()].map(async ([alias, m]) => {
        const st = m.status();
        const healthy = st.running ? await checkHealth(st.port) : false;
        return [alias, { ...st, healthy }];
      })
    );
    json(res, { instances: Object.fromEntries(instanceEntries) });
    return;
  }

  if (path === '/api/gpu' && req.method === 'GET') {
    json(res, await getGpuStats());
    return;
  }

  if (path === '/api/models' && req.method === 'GET') {
    const config = readConfig();
    const discovered = await discoverModels();
    const aliasEntries = await Promise.all(
      Object.entries(config.aliases)
        .filter(([, info]) => existsSync(info.model.replace('~', process.env.HOME)))
        .map(async ([alias, info]) => {
          const p = info.model.replace('~', process.env.HOME);
          let fileSize = null;
          try {
            const shardMatch = p.match(/^(.+)-(\d{5})-of-(\d{5})\.gguf$/i);
            if (shardMatch) {
              const [, prefix,, total] = shardMatch;
              const count = parseInt(total, 10);
              const sizes = await Promise.all(
                Array.from({ length: count }, (_, i) =>
                  stat(`${prefix}-${String(i + 1).padStart(5, '0')}-of-${total}.gguf`)
                    .then(s => s.size).catch(() => 0)
                )
              );
              fileSize = sizes.reduce((a, b) => a + b, 0) || null;
            } else {
              fileSize = (await stat(p)).size;
            }
          } catch {}
          return [alias, { ...info, fileSize }];
        })
    );
    json(res, {
      aliases: Object.fromEntries(aliasEntries),
      discovered: discovered.map(p => ({ path: p, name: p.replace(MODELS_DIR + '/', '') })),
    });
    return;
  }

  if (path === '/api/logs' && req.method === 'GET') {
    json(res, { lines: appLog.get() });
    return;
  }

  if (path === '/api/start' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { alias } = JSON.parse(body || '{}');
        if (!alias) { error(res, 400, 'alias required'); return; }
        const existing = managers.get(alias);
        if (existing?.proc) {
          // Already running — return current status, no-op.
          json(res, { ok: true, alreadyRunning: true, ...existing.status() });
          return;
        }
        const mgr = getManager(alias);
        mgr.switching = true;
        broadcastSSE({ type: 'switching', alias });
        const result = await mgr.start(alias);
        mgr.switching = false;
        broadcastSSE({ type: 'started', alias, ...result });
        json(res, { ok: true, ...result });
      } catch (e) {
        error(res, 500, e.message);
      }
    });
    return;
  }

  if (path === '/api/stop' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { alias } = JSON.parse(body || '{}');
        if (!alias) { error(res, 400, 'alias required'); return; }
        const mgr = managers.get(alias);
        if (!mgr) { json(res, { ok: true, notRunning: true }); return; }
        await mgr.stop();
        managers.delete(alias);
        broadcastSSE({ type: 'stopped', alias });
        json(res, { ok: true });
      } catch (e) { error(res, 500, e.message); }
    });
    return;
  }

  // HF Hub routes
  // /api/hf/add — parse a HF URL/repo, list files or start download
  if (path === '/api/hf/add' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { input, filename: chosenFile } = JSON.parse(body || '{}');
        if (!input) { error(res, 400, 'input required'); return; }
        const parsed = hfParseUrl(input);
        if (!parsed) { error(res, 400, 'Could not parse HuggingFace URL or repo ID'); return; }
        const { repoId, filename: parsedFile } = parsed;
        const filename = chosenFile || parsedFile;
        if (!filename) {
          // Repo only — return file list for client to pick from
          const files = await hfRepoFiles(repoId);
          json(res, { repoId, files });
          return;
        }
        const key = await startDownload(repoId, filename, { hfRepoId: repoId, hfFilename: filename });
        json(res, { ok: true, key, repoId, filename });
      } catch (e) { error(res, 400, e.message); }
    });
    return;
  }

  if (path === '/api/hf/search' && req.method === 'GET') {
    json(res, { models: [] }); return;
  }

  if (path === '/api/hf/files' && req.method === 'GET') {
    const repo = url.searchParams.get('repo') || '';
    try {
      const files = await hfRepoFiles(repo);
      json(res, { files });
    } catch (e) { error(res, 502, e.message); }
    return;
  }

  if (path === '/api/hf/pull' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { repoId, filename, meta } = JSON.parse(body || '{}');
        if (!repoId || !filename) { error(res, 400, 'repoId and filename required'); return; }
        const key = await startDownload(repoId, filename, meta || {});
        json(res, { ok: true, key });
      } catch (e) { error(res, 400, e.message); }
    });
    return;
  }

  if (path === '/api/models/set-autoload' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { alias, autoLoad } = JSON.parse(body || '{}');
        if (!alias) { error(res, 400, 'alias required'); return; }
        const cfgPath = join(__dirname, 'models.json');
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
        if (!cfg.aliases[alias]) { error(res, 404, 'alias not found'); return; }
        if (autoLoad) {
          cfg.aliases[alias].autoLoad = true;
        } else {
          delete cfg.aliases[alias].autoLoad;
        }
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
        json(res, { ok: true, alias, autoLoad: !!autoLoad });
      } catch (e) { error(res, 500, e.message); }
    });
    return;
  }

  if (path === '/api/models/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { alias } = JSON.parse(body || '{}');
        if (!alias) { error(res, 400, 'alias required'); return; }
        const cfgPath = join(__dirname, 'models.json');
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
        if (!cfg.aliases[alias]) { error(res, 404, 'alias not found'); return; }
        // Refuse if the model is currently running
        if (managers.has(alias)) { error(res, 409, 'model is currently running; stop it first'); return; }
        const modelPath = cfg.aliases[alias].model?.replace(/^~/, process.env.HOME || '');
        delete cfg.aliases[alias];
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
        if (modelPath) {
          try { await unlink(modelPath); } catch (e) {
            // silently ignore if already gone
            if (e.code !== 'ENOENT') console.warn(`Could not delete model file: ${e.message}`);
          }
        }
        json(res, { ok: true, alias });
      } catch (e) { error(res, 500, e.message); }
    });
    return;
  }

  if (path === '/api/models/update' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { alias, name, ctx, parallel, gpuLayers, batchSize, ubatchSize, flashAttn, cacheTypeK, cacheTypeV } = JSON.parse(body || '{}');
        if (!alias) { error(res, 400, 'alias required'); return; }
        const cfgPath = join(__dirname, 'models.json');
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
        if (!cfg.aliases[alias]) { error(res, 404, 'alias not found'); return; }
        const entry = cfg.aliases[alias];
        const CACHE_TYPES = ['f16', 'q8_0', 'q5_0', 'q4_0'];
        if (name       !== undefined) entry.name       = String(name).slice(0, 120);
        if (ctx        !== undefined) entry.ctx        = Math.max(512, Math.min(1048576, parseInt(ctx, 10) || entry.ctx));
        if (parallel   !== undefined) entry.parallel   = Math.max(1, Math.min(32, parseInt(parallel, 10) || entry.parallel));
        if (gpuLayers  !== undefined) entry.gpuLayers  = Math.max(0, parseInt(gpuLayers, 10) || 0);
        if (batchSize  !== undefined) entry.batchSize  = Math.max(32, Math.min(65536, parseInt(batchSize, 10) || 512));
        if (ubatchSize !== undefined) entry.ubatchSize = Math.max(32, Math.min(65536, parseInt(ubatchSize, 10) || 512));
        if (flashAttn  !== undefined) entry.flashAttn  = Boolean(flashAttn);
        if (cacheTypeK !== undefined && CACHE_TYPES.includes(cacheTypeK)) entry.cacheTypeK = cacheTypeK;
        if (cacheTypeV !== undefined && CACHE_TYPES.includes(cacheTypeV)) entry.cacheTypeV = cacheTypeV;
        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
        json(res, { ok: true, alias, entry });
      } catch (e) { error(res, 500, e.message); }
    });
    return;
  }

  if (path === '/api/hf/backfill' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { alias, repoId } = JSON.parse(body || '{}');
        if (!alias || !repoId) { error(res, 400, 'alias and repoId required'); return; }
        if (!/^[a-zA-Z0-9]([a-zA-Z0-9._-]*)\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(repoId))
          { error(res, 400, 'Invalid repoId'); return; }

        const cfgPath = join(__dirname, 'models.json');
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
        if (!cfg.aliases[alias]) { error(res, 404, 'alias not found'); return; }

        const hfRes = await fetch(`${HF_API}/models/${repoId}`, { headers: hfHeaders(), signal: AbortSignal.timeout(10000) });
        if (!hfRes.ok) throw new Error(`HF fetch failed: ${hfRes.status}`);
        const data = await hfRes.json();

        const entry = cfg.aliases[alias];
        entry.hfRepoId = repoId;
        const arch = hfExtractArch(data.tags || []);
        const caps = hfExtractCaps(data.tags || [], repoId);
        if (arch)           entry.arch          = arch;
        if (caps.length)    entry.caps          = caps;
        if (data.pipeline_tag)       entry.pipeline       = data.pipeline_tag;
        if (data.likes       != null) entry.hfLikes       = data.likes;
        if (data.downloads   != null) entry.hfDownloads   = data.downloads;
        if (data.lastModified)        entry.hfLastModified = data.lastModified;

        writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
        json(res, { ok: true, alias, entry });
      } catch (e) { error(res, 500, e.message); }
    });
    return;
  }

  if (path === '/api/hf/downloads' && req.method === 'GET') {
    const list = [...downloads.entries()].map(([key, d]) => ({
      key, repoId: d.repoId, filename: d.filename,
      bytes: d.bytes, total: d.total, done: d.done, error: d.error,
    }));
    json(res, { downloads: list });
    return;
  }

  if (path === '/api/hf/cancel' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { key } = JSON.parse(body || '{}');
        const d = downloads.get(key);
        if (d && !d.done) { d.controller.abort(); downloads.delete(key); }
        json(res, { ok: true });
      } catch (e) { error(res, 400, e.message); }
    });
    return;
  }

  // ── OpenAI-compatible proxy (/v1/) ──────────────────────────────────────────
  // Allows Open WebUI (and any OpenAI client) to talk to NeuralForge on port
  // 5757 and reach whatever llama-server instances are currently running.
  if (path.startsWith('/v1/')) {
    // GET /v1/models — list all currently running instances
    if (path === '/v1/models' && req.method === 'GET') {
      const now = Math.floor(Date.now() / 1000);
      const data = [...managers.entries()]
        .filter(([, m]) => m.status().running)
        .map(([alias]) => ({ id: alias, object: 'model', created: now, owned_by: 'neuralforge' }));
      json(res, { object: 'list', data });
      return;
    }

    // GET /v1/models/:id — single model object
    if (path.startsWith('/v1/models/') && req.method === 'GET') {
      const modelId = decodeURIComponent(path.slice('/v1/models/'.length));
      const mgr = managers.get(modelId);
      if (!mgr?.status().running) { error(res, 404, `model '${modelId}' is not running`); return; }
      json(res, { id: modelId, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'neuralforge' });
      return;
    }

    // All other /v1/ routes — buffer body, resolve target instance, proxy
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const bodyBuf = Buffer.concat(chunks);
      let targetPort;

      // Try to route by the `model` field in the request body
      try {
        const body = JSON.parse(bodyBuf.toString('utf8'));
        if (body.model) {
          const mgr = managers.get(body.model);
          if (mgr?.status().running) targetPort = mgr.status().port;
        }
      } catch { /* non-JSON body — fall through to any-running */ }

      // Fall back to the first running instance
      if (!targetPort) {
        for (const [, m] of managers) {
          const st = m.status();
          if (st.running) { targetPort = st.port; break; }
        }
      }

      if (!targetPort) { error(res, 503, 'no model is currently running'); return; }
      proxyToLlama(req, res, bodyBuf, targetPort);
    });
    return;
  }

  // Silence the browser's automatic favicon.ico request (we use a dynamic canvas favicon)
  if (req.url === '/favicon.ico') { res.writeHead(204); res.end(); return; }

  // Static files
  const ext = req.url.includes('.') ? req.url.split('.').pop().split('?')[0] : '';
  const mime = { html: 'text/html', js: 'text/javascript', css: 'text/css', png: 'image/png', ico: 'image/x-icon' };
  const staticFile = ext && mime[ext] ? req.url.replace(/\?.*$/, '') : '/index.html';
  const staticPath = join(__dirname, 'public', staticFile.replace(/^\//, ''));
  try {
    const content = readFileSync(staticPath);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/html' });
    res.end(content);
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

// Proxy a buffered request to a llama-server instance, preserving streaming.
function proxyToLlama(req, res, bodyBuf, port) {
  const opts = {
    hostname: '127.0.0.1',
    port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${port}` },
  };
  if (bodyBuf.length > 0) opts.headers['content-length'] = bodyBuf.length;
  const proxy = httpRequest(opts, (upstream) => {
    res.writeHead(upstream.statusCode, upstream.headers);
    upstream.pipe(res);
  });
  proxy.on('error', (e) => {
    if (!res.headersSent) error(res, 502, `upstream error: ${e.message}`);
    else res.end();
  });
  if (bodyBuf.length > 0) proxy.write(bodyBuf);
  proxy.end();
}

// SSE broadcast loop
setInterval(async () => {
  if (sseClients.size === 0) return;
  const gpu = await getGpuStats();

  // Build per-instance statuses and metrics in parallel
  const instanceEntries = await Promise.all(
    [...managers.entries()].map(async ([alias, m]) => {
      const st = m.status();
      const healthy = st.running ? await checkHealth(st.port) : false;
      const metrics = st.running ? await getLlamaMetrics(st.port) : null;
      return [alias, { ...st, healthy, metrics }];
    })
  );
  const statuses = Object.fromEntries(instanceEntries);

  broadcastSSE({ type: 'update', gpu, statuses });
}, 2000);

// Startup
server.listen(PORT, async () => {
  console.log(`[neuralforge] Listening on port ${PORT}`);

  // Boot-time orphan sweep — safe here because managers Map is empty.
  await killOrphans();

  const config = readConfig();
  const autoAliases = Object.entries(config.aliases)
    .filter(([, info]) => info.autoLoad)
    .map(([alias]) => alias);

  if (autoAliases.length > 0) {
    console.log(`[neuralforge] Autoloading: ${autoAliases.join(', ')}`);
    setTimeout(() => {
      Promise.all(autoAliases.map(alias =>
        getManager(alias).start(alias)
          .then(r => broadcastSSE({ type: 'started', alias, ...r }))
          .catch(e => console.error(`[neuralforge] Autoload failed for ${alias}:`, e.message))
      ));
    }, 3000);
  }
});

process.on('SIGTERM', async () => {
  console.log('[neuralforge] Shutting down...');
  await Promise.all([...managers.values()].map(m => m.stop()));
  process.exit(0);
});
