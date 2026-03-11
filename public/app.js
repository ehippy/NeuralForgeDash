// ── Reactive favicon sparkline ────────────────────────────────────────────────
const _fvCanvas = Object.assign(document.createElement('canvas'), { width: 32, height: 32 });
const _fvCtx = _fvCanvas.getContext('2d');
const _fvHist = { busy: [], gtt: [] };
const _fvLen = 20;

function drawFavicon(busyPct, gttPct) {
  if (busyPct != null) { _fvHist.busy.push(busyPct); if (_fvHist.busy.length > _fvLen) _fvHist.busy.shift(); }
  if (gttPct  != null) { _fvHist.gtt.push(gttPct);   if (_fvHist.gtt.length  > _fvLen) _fvHist.gtt.shift(); }

  const ctx = _fvCtx, W = 32, H = 32, pad = 2;
  const pw = W - pad * 2, ph = H - pad * 2;
  ctx.clearRect(0, 0, W, H);

  ctx.fillStyle = '#212529';
  ctx.beginPath(); ctx.roundRect(0, 0, W, H, 5); ctx.fill();

  function plot(data, color, fillAlpha) {
    const n = data.length;
    if (n < 2) return;
    const pts = data.map((v, i) => [
      pad + (i / (n - 1)) * pw,
      pad + ph - Math.min(100, Math.max(0, v)) / 100 * ph
    ]);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pad + ph);
    pts.forEach(([x, y]) => ctx.lineTo(x, y));
    ctx.lineTo(pts[pts.length - 1][0], pad + ph);
    ctx.closePath();
    ctx.fillStyle = color; ctx.globalAlpha = fillAlpha; ctx.fill(); ctx.globalAlpha = 1;
    ctx.beginPath();
    pts.forEach(([x, y], i) => i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y));
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.restore();
  }

  plot(_fvHist.gtt,  '#fd7e14', 0.35);
  plot(_fvHist.busy, '#20c997', 0.35);

  document.getElementById('dynFavicon').href = _fvCanvas.toDataURL();
}

// ── Utility formatters ────────────────────────────────────────────────────────
function fmtCtx(n) {
  if (!n) return '—';
  if (n >= 1024) return Math.round(n / 1024) + 'k';
  return String(n);
}

function fmtUptime(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
  return `${h}h ${m}m`;
}

function fmtBytes(b) {
  b = +b;
  if (!b || !isFinite(b)) return '—';
  if (b >= 1e9) return (b / 1e9).toFixed(1) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(0) + ' MB';
  if (b >= 1e3) return (b / 1e3).toFixed(0) + ' KB';
  return b + ' B';
}

function fmtNum(n) {
  n = +n;
  if (!isFinite(n)) return '0';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

function fmtAge(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const d = Math.floor(diff / 86400000);
  if (d < 1) return 'today';
  if (d < 7) return `${d}d ago`;
  if (d < 31) return `${Math.floor(d/7)}w ago`;
  if (d < 365) return `${Math.floor(d/30)}mo ago`;
  return `${Math.floor(d/365)}y ago`;
}

// ── GPU progress bars (direct DOM, perf-sensitive) ────────────────────────────
function setBar(barId, valId, displayVal, suffix, usePctForColor, pctOverride) {
  const bar = document.getElementById(barId);
  const val = document.getElementById(valId);
  if (displayVal == null) { val.textContent = '—'; bar.style.width = '0%'; return; }
  const pct = pctOverride !== undefined ? pctOverride : parseFloat(displayVal);
  val.textContent = `${displayVal}${suffix}`;
  bar.style.width = `${Math.min(100, pct)}%`;
  if (usePctForColor || pctOverride !== undefined) {
    bar.className = 'progress-bar' + (pct >= 85 ? ' bg-danger' : pct >= 60 ? ' bg-warning' : ' bg-success');
  }
}

function updateGpu(g) {
  if (!g) return;
  const gttPct = g.gttUsedGB && g.gttTotalGB
    ? (parseFloat(g.gttUsedGB) / parseFloat(g.gttTotalGB)) * 100
    : 0;
  setBar('gpuBusyBar', 'gpuBusyVal', g.busyPct, '%', true);
  document.getElementById('gpuStat').title = g.clockMhz ? `${g.clockMhz} MHz` : '';
  setBar('cpuBusyBar', 'cpuBusyVal', g.cpuPct, '%', true);
  document.getElementById('cpuStat').title = g.cpuTempC != null ? `${g.cpuTempC.toFixed(0)}°C` : '';
  setBar('gttBar', 'gttVal', g.gttUsedGB, ' GB', false, gttPct);
  const diskPct = g.diskUsedGB && g.diskTotalGB
    ? (parseFloat(g.diskUsedGB) / parseFloat(g.diskTotalGB)) * 100 : 0;
  setBar('diskBar', 'diskVal', g.diskUsedGB, ' GB', false, diskPct);
  drawFavicon(g.busyPct, gttPct);
}

// ── Log rendering ─────────────────────────────────────────────────────────────
function logLineEl(line) {
  let cls = 'log-line';
  if (/error|fail|fatal/i.test(line)) cls += ' err';
  else if (/warn/i.test(line)) cls += ' warn';
  else if (/\[neuralforge\]|listen|ready|done/i.test(line)) cls += ' info';
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = line;
  return div;
}

function renderLogs(lines) {
  const inner = document.getElementById('logInner');
  inner.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const line of lines) frag.appendChild(logLineEl(line));
  inner.appendChild(frag);
  const body = document.getElementById('logBody');
  body.scrollTop = body.scrollHeight;
}

function appendLog(line) {
  const inner = document.getElementById('logInner');
  if (!inner) return;
  inner.appendChild(logLineEl(line));
  // Keep DOM trim to last 500 lines
  while (inner.children.length > 500) inner.removeChild(inner.firstChild);
  const body = document.getElementById('logBody');
  // Only auto-scroll if already near bottom
  if (body.scrollHeight - body.scrollTop - body.clientHeight < 60) {
    body.scrollTop = body.scrollHeight;
  }
}

async function loadLogs() {
  try {
    const r = await fetch('/api/logs');
    const data = await r.json();
    renderLogs(data.lines);
  } catch {}
}

// ── Alpine store ──────────────────────────────────────────────────────────────
document.addEventListener('alpine:init', () => {
  Alpine.store('nf', {
    instances: {},
    models: { aliases: {}, discovered: [] },
    _uptimeTimers: new Map(),
    hfModal: { open: false, input: '', loading: false, repoId: null, files: null, error: null, selected: null, downloading: false },
    hfDownloads: {},   // key -> { key, repoId, filename, bytes, total, done, error }

    get runningList() {
      return Object.values(this.instances).filter(s => s.running);
    },
    get discoveredExtra() {
      return (this.models.discovered || []).filter(d =>
        !Object.values(this.models.aliases).some(a =>
          d.path.endsWith(a.model.replace('~/', '').replace('~', ''))
        )
      );
    },

    updateInstances(newStatuses) {
      for (const [alias, st] of Object.entries(newStatuses)) {
        const prev = this.instances[alias] || {};
        this.instances[alias] = { ...st, metrics: st.metrics || prev.metrics };
      }
      for (const alias of Object.keys(this.instances)) {
        if (!newStatuses[alias] && !this.instances[alias].switching) {
          delete this.instances[alias];
          this._stopTimer(alias);
        }
      }
      for (const [alias, st] of Object.entries(this.instances)) {
        if (st.running && !this._uptimeTimers.has(alias)) {
          this._uptimeTimers.set(alias, setInterval(() => {
            if (this.instances[alias]) {
              this.instances[alias] = { ...this.instances[alias], uptime: (this.instances[alias].uptime || 0) + 1 };
            }
          }, 1000));
        } else if (!st.running) {
          this._stopTimer(alias);
        }
      }
    },

    _stopTimer(alias) {
      if (this._uptimeTimers.has(alias)) {
        clearInterval(this._uptimeTimers.get(alias));
        this._uptimeTimers.delete(alias);
      }
    },

    async confirmStart(alias, name) {
      if (!confirm(`Load "${name}"?`)) return;
      this.instances[alias] = { ...(this.instances[alias] || {}), switching: true, alias };
      try {
        await fetch('/api/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alias }),
        });
      } catch(e) {
        console.error(e);
        delete this.instances[alias];
      }
    },

    async stopInstance(alias, btn) {
      btn.disabled = true;
      btn.textContent = '\u2026';
      try {
        await fetch('/api/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alias }),
        });
      } catch {}
    },

    async setAutoLoad(alias, checked, chkEl) {
      try {
        const r = await fetch('/api/models/set-autoload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alias, autoLoad: checked }),
        });
        if (!r.ok) chkEl.checked = !checked;
        else this.models.aliases[alias] = { ...this.models.aliases[alias], autoLoad: checked };
      } catch { chkEl.checked = !checked; }
    },

    async deleteModel(alias, name) {
      if (!confirm(`Delete "${name}"?\nThis removes it from models.json AND deletes the file from disk.`)) return;
      try {
        const r = await fetch('/api/models/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alias }),
        });
        const d = await r.json();
        if (!r.ok) { alert(d.error || 'Delete failed'); return; }
        const mr = await fetch('/api/models');
        this.models = await mr.json();
      } catch (e) { alert(`Delete failed: ${e.message}`); }
    },

    async syncHF(alias, info) {
      let repoId = info.hfRepoId;
      if (!repoId) {
        repoId = prompt(`HuggingFace repo ID for "${alias}"\n(e.g. unsloth/Qwen3-30B-A3B-GGUF)`);
        if (!repoId) return;
        repoId = repoId.trim();
      }
      try {
        const r = await fetch('/api/hf/backfill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alias, repoId }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'backfill failed');
        const mr = await fetch('/api/models');
        this.models = await mr.json();
      } catch (err) {
        alert(`HF backfill failed: ${err.message}`);
      }
    },

    openHFModal() {
      this.hfModal = { open: true, input: '', loading: false, repoId: null, files: null, error: null, selected: null, downloading: false };
      setTimeout(() => document.getElementById('hfModalInput')?.focus(), 50);
    },

    async hfFetch() {
      const input = this.hfModal.input.trim();
      if (!input) return;
      this.hfModal.loading = true;
      this.hfModal.error = null;
      this.hfModal.files = null;
      this.hfModal.selected = null;
      this.hfModal.repoId = null;
      try {
        const r = await fetch('/api/hf/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input }),
        });
        const data = await r.json();
        if (!r.ok) { this.hfModal.error = data.error || 'Failed'; return; }
        if (!data.files) {
          // Direct GGUF URL — download started immediately
          addHFDownloadRow(data.key, data.repoId, data.filename);
          this.hfModal.open = false;
        } else if (!data.files.length) {
          this.hfModal.error = `No GGUF files found in ${data.repoId}.\nThis repo may only have safetensors weights. Try searching for "${data.repoId.split('/').pop()}-GGUF" on HuggingFace.`;
        } else {
          this.hfModal.repoId = data.repoId;
          this.hfModal.files = data.files;
        }
      } catch (e) {
        this.hfModal.error = e.message;
      } finally {
        this.hfModal.loading = false;
      }
    },

    async hfDownload() {
      const { input, selected } = this.hfModal;
      if (!selected) return;
      this.hfModal.downloading = true;
      try {
        const r = await fetch('/api/hf/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: input.trim(), filename: selected.name }),
        });
        const d = await r.json();
        if (!r.ok) { this.hfModal.error = d.error || 'Failed'; this.hfModal.downloading = false; return; }
        addHFDownloadRow(d.key, d.repoId, d.filename);
        this.hfModal.open = false;
      } catch (e) {
        this.hfModal.error = e.message;
        this.hfModal.downloading = false;
      }
    },
  });
});

// ── SSE + init ────────────────────────────────────────────────────────────────
function connectSSE() {
  const es = new EventSource('/events');
  es.onmessage = e => {
    const data = JSON.parse(e.data);
    const store = Alpine.store('nf');
    if (data.type === 'update') {
      store.updateInstances(data.statuses || {});
      updateGpu(data.gpu);
    } else if (data.type === 'switching') {
      store.instances[data.alias] = { ...(store.instances[data.alias] || {}), switching: true, alias: data.alias };
    } else if (data.type === 'started') {
      refresh();
      loadModels();
    } else if (data.type === 'stopped') {
      const inst = { ...store.instances };
      delete inst[data.alias];
      store._stopTimer(data.alias);
      store.instances = inst;
      loadLogs();
    } else if (data.type === 'log') {
      appendLog(data.line);
    } else if (data.type === 'hf-progress') {
      updateHFProgress(data.key, data.bytes, data.total);
    } else if (data.type === 'hf-done') {
      onHFDone(data.key, data.alias);
      loadModels();
    } else if (data.type === 'hf-error') {
      onHFError(data.key, data.error);
    }
  };
  es.onerror = () => setTimeout(connectSSE, 5000);
}

async function loadModels() {
  try {
    const r = await fetch('/api/models');
    Alpine.store('nf').models = await r.json();
  } catch(e) { console.error('models load failed', e); }
}

async function refresh() {
  try {
    const [statusR, gpuR] = await Promise.all([fetch('/api/status'), fetch('/api/gpu')]);
    const statusData = await statusR.json();
    const gpu = await gpuR.json();
    Alpine.store('nf').updateInstances(statusData.instances || {});
    updateGpu(gpu);
  } catch {}
}

async function init() {
  await loadModels();
  await refresh();
  await loadLogs();
  connectSSE();
}

document.addEventListener('alpine:initialized', () => { init(); });

// ── HuggingFace downloads ─────────────────────────────────────────────────────
const hfProgressEls = new Map(); // key presence used for loadHFDownloads dedup

function addHFDownloadRow(key, repoId, filename) {
  hfProgressEls.set(key, true);
  const store = Alpine.store('nf');
  store.hfDownloads = { ...store.hfDownloads, [key]: { key, repoId, filename, bytes: 0, total: 0, done: false, error: null } };
}

function updateHFProgress(key, bytes, total) {
  const store = Alpine.store('nf');
  if (!store.hfDownloads[key]) return;
  store.hfDownloads = { ...store.hfDownloads, [key]: { ...store.hfDownloads[key], bytes, total } };
}

function onHFDone(key, alias) {
  const store = Alpine.store('nf');
  if (!store.hfDownloads[key]) return;
  store.hfDownloads = { ...store.hfDownloads, [key]: { ...store.hfDownloads[key], done: true } };
  setTimeout(() => {
    const dl = { ...Alpine.store('nf').hfDownloads };
    delete dl[key];
    Alpine.store('nf').hfDownloads = dl;
    hfProgressEls.delete(key);
  }, 5000);
}

function onHFError(key, errMsg) {
  const store = Alpine.store('nf');
  if (!store.hfDownloads[key]) return;
  store.hfDownloads = { ...store.hfDownloads, [key]: { ...store.hfDownloads[key], error: errMsg } };
  setTimeout(() => {
    const dl = { ...Alpine.store('nf').hfDownloads };
    delete dl[key];
    Alpine.store('nf').hfDownloads = dl;
    hfProgressEls.delete(key);
  }, 10000);
}

async function loadHFDownloads() {
  try {
    const r = await fetch('/api/hf/downloads');
    const data = await r.json();
    for (const d of data.downloads) {
      if (!d.done && !d.error && !hfProgressEls.has(d.key)) {
        addHFDownloadRow(d.key, d.repoId, d.filename);
        updateHFProgress(d.key, d.bytes, d.total);
      }
    }
  } catch {}
}