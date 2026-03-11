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
  setBar('cpuBusyBar', 'cpuBusyVal', g.cpuPct, '%', true);
  setBar('gttBar', 'gttVal', g.gttUsedGB, ' GB', false, gttPct);
  setBar('vramBar', 'vramVal', g.vramUsedMB, ' MB',
    false, g.vramUsedMB && g.vramTotalMB ? (g.vramUsedMB / g.vramTotalMB) * 100 : 0);
  document.getElementById('gpuClock').textContent = g.clockMhz ? `${g.clockMhz} MHz` : '—';
  document.getElementById('cpuTemp').textContent = g.cpuTempC != null ? `${g.cpuTempC.toFixed(0)}°C` : '—';
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
    hfOpen: false,
    _uptimeTimers: new Map(),

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

    toggleHF() {
      this.hfOpen = !this.hfOpen;
      if (this.hfOpen) {
        loadHFDownloads();
        setTimeout(() => {
          const inp = document.getElementById('hfSearchInput');
          if (inp) {
            inp.removeEventListener('input', onHFInput);
            inp.addEventListener('input', onHFInput);
            inp.focus();
          }
        }, 50);
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

// ── HuggingFace Hub ────────────────────────────────────────────────────────────
let hfSearchTimer = null;
const hfProgressEls = new Map();

function onHFInput(e) {
  clearTimeout(hfSearchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) { document.getElementById('hfResults').innerHTML = ''; return; }
  hfSearchTimer = setTimeout(() => doHFSearch(q), 420);
}

async function doHFSearch(q) {
  const container = document.getElementById('hfResults');
  container.innerHTML = '<div class="small text-secondary py-1">Searching\u2026</div>';
  try {
    const r = await fetch(`/api/hf/search?q=${encodeURIComponent(q)}`);
    const data = await r.json();
    renderHFResults(data.models || []);
  } catch {
    container.innerHTML = '<div class="small text-danger">Search failed</div>';
  }
}

function renderHFResults(hfModels) {
  const container = document.getElementById('hfResults');
  container.innerHTML = '';
  if (!hfModels.length) {
    container.innerHTML = '<div class="small text-secondary py-1">No results</div>';
    return;
  }
  hfModels.forEach(m => {
    const card = document.createElement('div');
    card.className = 'border border-secondary rounded p-2 mb-1';
    card.style.fontSize = '11px';

    const [author, repoName] = m.id.includes('/') ? m.id.split('/') : ['', m.id];
    const header = document.createElement('div');
    header.className = 'd-flex justify-content-between align-items-start';
    header.style.cursor = 'pointer';
    header.style.gap = '8px';

    const nameBlock = document.createElement('div');
    nameBlock.style.minWidth = '0';
    const authorEl = document.createElement('div');
    authorEl.className = 'text-secondary';
    authorEl.style.fontSize = '10px';
    authorEl.textContent = author;
    const nameRow = document.createElement('div');
    nameRow.className = 'd-flex align-items-center gap-1';
    const nameEl = document.createElement('div');
    nameEl.className = 'text-success fw-semibold';
    nameEl.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:200px';
    nameEl.title = m.id;
    nameEl.textContent = repoName || m.id;
    const hfLink = document.createElement('a');
    hfLink.href = `https://huggingface.co/${m.id}`;
    hfLink.target = '_blank';
    hfLink.rel = 'noopener noreferrer';
    hfLink.title = 'Open on HuggingFace';
    hfLink.className = 'text-secondary text-decoration-none';
    hfLink.style.cssText = 'flex-shrink:0;line-height:1';
    hfLink.textContent = '\u2197';
    hfLink.addEventListener('click', e => e.stopPropagation());
    nameRow.appendChild(nameEl);
    nameRow.appendChild(hfLink);
    nameBlock.appendChild(authorEl);
    nameBlock.appendChild(nameRow);

    const statsBlock = document.createElement('div');
    statsBlock.className = 'd-flex flex-column align-items-end gap-1';
    statsBlock.style.flexShrink = '0';
    const dlLikeEl = document.createElement('div');
    dlLikeEl.className = 'text-secondary';
    dlLikeEl.style.fontSize = '10px';
    dlLikeEl.textContent = `\u2193 ${fmtNum(m.downloads ?? 0)}  \u2665 ${fmtNum(m.likes ?? 0)}`;
    statsBlock.appendChild(dlLikeEl);
    if (m.totalGgufBytes) {
      const sizeEl = document.createElement('div');
      sizeEl.className = 'text-success fw-semibold';
      sizeEl.style.fontSize = '10px';
      sizeEl.textContent = fmtBytes(m.totalGgufBytes) + ' total';
      statsBlock.appendChild(sizeEl);
    }

    const tagRow = document.createElement('div');
    tagRow.className = 'd-flex gap-1 flex-wrap mt-1';
    if (m.arch) tagRow.appendChild(hfBadge(m.arch, 'info'));
    if (m.pipeline) tagRow.appendChild(hfBadge(m.pipeline.replace(/-/g, ' ').replace('text generation', 'text-gen'), 'secondary'));
    if (m.lastModified) tagRow.appendChild(hfBadge('updated ' + fmtAge(m.lastModified), 'secondary'));
    if (m.quantVariants && m.quantVariants.length) {
      m.quantVariants.slice(0, 4).forEach(q => tagRow.appendChild(hfQuantBadge(q)));
      if (m.quantVariants.length > 4) tagRow.appendChild(hfBadge(`+${m.quantVariants.length - 4}`, 'secondary'));
    }
    if (m.caps && m.caps.length) {
      m.caps.forEach(cap => tagRow.appendChild(hfBadge(cap, 'primary')));
    }

    const fileList = document.createElement('div');
    fileList.style.display = 'none';
    fileList.style.marginTop = '6px';

    let loaded = false;
    header.addEventListener('click', async () => {
      const open = fileList.style.display !== 'none';
      fileList.style.display = open ? 'none' : 'block';
      if (!open && !loaded) {
        loaded = true;
        fileList.innerHTML = '<div class="small text-secondary">Loading files\u2026</div>';
        try {
          const r = await fetch(`/api/hf/files?repo=${encodeURIComponent(m.id)}`);
          const data = await r.json();
          renderHFFileList(fileList, m.id, data.files || [], m);
        } catch {
          fileList.innerHTML = '<div class="small text-danger">Failed to load files</div>';
        }
      }
    });

    header.appendChild(nameBlock);
    header.appendChild(statsBlock);
    card.appendChild(header);
    card.appendChild(tagRow);
    card.appendChild(fileList);
    container.appendChild(card);
  });
}

function hfBadge(text, variant) {
  const s = document.createElement('span');
  s.className = `badge text-bg-${variant}`;
  s.style.fontSize = '10px';
  s.textContent = text;
  return s;
}

function hfQuantBadge(q) {
  const s = document.createElement('span');
  s.className = 'badge';
  s.style.cssText = `font-size:10px;background-color:#1a2030;color:${quantColor(q)}`;
  s.textContent = q;
  return s;
}

const QUANT_COLORS = {
  F32:'#adb5bd', BF16:'#adb5bd', F16:'#adb5bd',
  Q8_0:'#4dabce', Q6_K:'#4dabce',
  Q5_K_M:'#20c997', Q5_K_S:'#20c997', Q5_0:'#20c997', Q5_1:'#20c997',
  Q4_K_M:'#7ecb7e', Q4_K_S:'#7ecb7e', Q4_0:'#7ecb7e', Q4_1:'#7ecb7e',
  Q3_K_M:'#fd7e14', Q3_K_S:'#fd7e14', Q3_K_L:'#fd7e14',
  Q2_K:'#dc3545',
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

function renderHFFileList(container, repoId, files, cardMeta = {}) {
  container.innerHTML = '';
  if (!files.length) { container.innerHTML = '<div class="small text-secondary">No GGUF files found</div>'; return; }
  const visible = files.filter(f => {
    const m = f.name.match(/-([0-9]{5})-of-([0-9]{5})\.gguf$/);
    return !m || m[1] === '00001';
  });
  (visible.length ? visible : files).forEach(f => {
    const isShard = /-[0-9]{5}-of-[0-9]{5}\.gguf$/.test(f.name);
    const row = document.createElement('div');
    row.className = 'd-flex justify-content-between align-items-center py-1 border-top border-secondary gap-2';
    row.style.fontSize = '11px';
    row.id = 'hf-row-' + btoa(repoId + '/' + f.name).replace(/[^a-zA-Z0-9]/g, '');

    const left = document.createElement('div');
    left.style.cssText = 'min-width:0;flex:1;display:flex;align-items:center;gap:6px';

    const qBadge = document.createElement('span');
    qBadge.style.cssText = `color:${quantColor(f.quant)};font-weight:600;flex-shrink:0;min-width:52px;font-size:11px`;
    qBadge.textContent = f.quant || '—';

    const nameEl = document.createElement('span');
    nameEl.style.cssText = 'color:#6c757d;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1';
    nameEl.textContent = f.name.replace(/^.*\//, '');
    nameEl.title = f.name;
    left.appendChild(qBadge); left.appendChild(nameEl);
    if (isShard) {
      const shardTag = document.createElement('span');
      shardTag.className = 'text-secondary';
      shardTag.style.fontSize = '10px';
      shardTag.textContent = '(sharded)';
      left.appendChild(shardTag);
    }

    const right = document.createElement('div');
    right.className = 'd-flex align-items-center gap-2';
    right.style.flexShrink = '0';

    if (f.size) {
      const sizeEl = document.createElement('span');
      sizeEl.className = 'text-secondary';
      sizeEl.style.fontSize = '10px';
      sizeEl.textContent = fmtBytes(f.size);
      right.appendChild(sizeEl);
    }

    const btn = document.createElement('button');
    btn.className = 'btn btn-outline-secondary btn-sm py-0 px-2';
    btn.style.fontSize = '10px';
    btn.textContent = 'Pull';
    btn.addEventListener('click', () => pullHFFile(repoId, f.name, row, btn, { ...cardMeta, hfRepoId: repoId, hfFilename: f.name, fileSize: f.size }));
    right.appendChild(btn);

    row.appendChild(left);
    row.appendChild(right);
    container.appendChild(row);
  });
}

async function pullHFFile(repoId, filename, rowEl, btn, meta = {}) {
  btn.disabled = true;
  btn.textContent = 'Starting\u2026';
  try {
    const r = await fetch('/api/hf/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoId, filename, meta }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    addHFDownloadRow(data.key, repoId, filename);
    btn.textContent = '\u2193\u2026';
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Error';
    btn.title = e.message;
    setTimeout(() => { btn.disabled = false; btn.textContent = 'Pull'; btn.title = ''; }, 4000);
  }
}

function addHFDownloadRow(key, repoId, filename) {
  const panel = document.getElementById('hfActiveDownloads');
  if (panel.children.length === 0) panel.style.marginTop = '10px';

  const wrap = document.createElement('div');
  wrap.id = 'hfdl-' + btoa(key).replace(/[^a-zA-Z0-9]/g, '');

  const topRow = document.createElement('div');
  topRow.className = 'd-flex justify-content-between small mb-1';
  const nameEl = document.createElement('span');
  nameEl.className = 'text-secondary text-truncate';
  nameEl.textContent = filename;
  const labelEl = document.createElement('span');
  labelEl.className = 'text-success flex-shrink-0';
  labelEl.textContent = '0%';
  topRow.appendChild(nameEl);
  topRow.appendChild(labelEl);

  const progWrap = document.createElement('div');
  progWrap.className = 'progress';
  progWrap.style.height = '4px';
  const barEl = document.createElement('div');
  barEl.className = 'progress-bar bg-success';
  barEl.style.width = '0%';
  barEl.style.transition = 'width 0.4s ease';
  progWrap.appendChild(barEl);

  wrap.appendChild(topRow);
  wrap.appendChild(progWrap);
  panel.appendChild(wrap);

  hfProgressEls.set(key, { barEl, labelEl, wrap });
}

function updateHFProgress(key, bytes, total) {
  const el = hfProgressEls.get(key);
  if (!el) return;
  if (total > 0) {
    const pct = Math.round((bytes / total) * 100);
    el.barEl.style.width = pct + '%';
    el.labelEl.textContent = `${pct}% \u00b7 ${fmtBytes(bytes)} / ${fmtBytes(total)}`;
  } else {
    el.labelEl.textContent = fmtBytes(bytes);
  }
}

function onHFDone(key, alias) {
  const el = hfProgressEls.get(key);
  if (el) {
    el.barEl.style.width = '100%';
    el.barEl.className = 'progress-bar bg-success';
    el.labelEl.textContent = `\u2713 done \u00b7 alias: ${alias}`;
    setTimeout(() => { el.wrap.remove(); hfProgressEls.delete(key); }, 8000);
  }
}

function onHFError(key, errMsg) {
  const el = hfProgressEls.get(key);
  if (el) {
    el.barEl.className = 'progress-bar bg-danger';
    el.barEl.style.width = '100%';
    el.labelEl.textContent = '\u2717 ' + errMsg;
    el.labelEl.className = 'text-danger flex-shrink-0';
    setTimeout(() => { el.wrap.remove(); hfProgressEls.delete(key); }, 10000);
  }
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