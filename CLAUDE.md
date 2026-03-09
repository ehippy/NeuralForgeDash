# NeuralForge — Agent Context

## What This Is

A local LLM manager dashboard for llama.cpp on a Strix Halo APU (AMD unified memory, ~125GB GTT pool). NeuralForge is the single service that owns llama-server completely — spawns it, pipes its stdout, manages its lifetime. No adoption logic, no PID files, no external service competing.

## Architecture

**One process tree:**
```
systemd
└── neuralforge.service (node server.mjs)
    └── llama-server (child process, piped stdout)
```

**Key files:**
- `server.mjs` — Node.js backend, zero npm dependencies. All logic lives here.
- `models.json` — Model registry. Edit to add/remove models. Read live, no restart needed.
- `public/index.html` — Dashboard UI, vanilla JS, SSE-driven.
- `/etc/systemd/system/neuralforge.service` — System service, runs as `pmcdavid`, starts at boot.
- `/etc/caddy/Caddyfile` — Reverse proxy: `NeuralForge` hostname → port 5757.

**Ports:**
- `5757` — NeuralForge dashboard/API
- `8081` — llama-server (OpenAI-compatible, what Open WebUI connects to)

## Key Design Decisions

- **NeuralForge owns llama-server.** It spawns the child, pipes stdout into a 100-line circular LogBuffer, and kills it on stop/switch. Never adopt external processes.
- **No npm.** Pure Node.js ESM. Don't add dependencies.
- **models.json is the source of truth.** `/api/models` filters aliases to only those whose `.gguf` file exists on disk — missing files are silently excluded from the dashboard.
- **SSE broadcast loop** runs every 2s, pushes `{ type: 'update', gpu, status, metrics }` to all connected clients. Only runs the GPU/metrics fetches if clients are connected.
- **Model switch flow:** SIGTERM → wait 8s (SIGKILL fallback) → wait port 8081 free → spawn new.
- **AUTOSTART_ALIAS=coder** env var triggers model load 3s after server starts listening.

## Hardware Notes (Strix Halo)

- GPU memory is **GTT** (unified system RAM), not VRAM. The 512MB "VRAM" carveout is irrelevant.
- GPU stats come from sysfs at `/sys/class/drm/card1/device/` — no rocm-smi, no radeontop process needed.
- The Q8_0 coder model (~80B params) uses ~85GB GTT. Leaves ~40GB for OS + other processes.
- OOM on model load = something else is holding GTT. Check `pgrep -fa llama-server` for orphans.
- `rocm-smi` is unreliable on this hardware. Use sysfs or the dashboard.

## Common Operations

```bash
# Restart everything (model reloads after 3s)
sudo systemctl restart neuralforge

# Watch live logs
journalctl -u neuralforge -f

# Check current state
curl -s http://localhost:5757/api/status | jq

# Check for orphan llama-server processes
pgrep -fa llama-server

# Change autostart model
sudo systemctl edit --full neuralforge  # change AUTOSTART_ALIAS
sudo systemctl daemon-reload && sudo systemctl restart neuralforge
```

## Adding a Model

Add to `aliases` in `models.json`:
```json
"myalias": {
  "name": "Display Name",
  "model": "~/models/path/to/file.gguf",
  "ctx": 65536,
  "parallel": 2
}
```
No restart needed. Model appears in dashboard immediately if file exists.

## What NOT to Do

- Don't add `tryAdopt()` or PID file logic back — that was removed intentionally. The old `llama-server.service` is disabled and gone.
- Don't add npm dependencies.
- Don't run `start-llama.sh` while neuralforge is active — they'll fight over port 8081.
- Don't trust `rocm-smi` output on this machine.
- Don't confuse VRAM (512MB carveout) with GTT (the real model memory pool).

## API Surface

| Method | Path | Notes |
|---|---|---|
| GET | `/api/status` | `{ running, alias, model, pid, uptime, switching, healthy }` |
| GET | `/api/models` | `{ aliases: {only present on disk}, discovered: [gguf paths] }` |
| GET | `/api/gpu` | sysfs GPU stats |
| GET | `/api/logs` | `{ lines: [...] }` last 100 from LogBuffer |
| POST | `/api/start` | body: `{ "alias": "coder" }` |
| POST | `/api/stop` | graceful |
| GET | `/events` | SSE stream |
