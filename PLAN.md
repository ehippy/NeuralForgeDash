# NeuralForge Dashboard

## Context
A lightweight local LLM model manager web UI accessible at http://NeuralForge. Replaces the manual `start-llama.sh` workflow with a slick dark dashboard showing GPU stats, model status, live inference metrics, and one-click model switching. Like a mini-Ollama UI but transparent and tailored to the custom Strix Halo llama.cpp setup.

## Stack
- **Backend**: Node.js (already installed, zero npm deps) — single `server.mjs`
- **Frontend**: Vanilla HTML/CSS/JS — single `public/index.html`
- **Config**: `models.json` — model registry with per-model flags
- **Reverse proxy**: Caddy (`sudo pacman -S caddy`) — one-liner to port 80
- **Systemd**: system service for NeuralForge + Caddy — both start at boot, no login required

## File Layout
```
/home/pmcdavid/Projects/NeuralForgeDash/
├── server.mjs
├── models.json
└── public/
    └── index.html
```

## models.json
```json
{
  "defaults": {
    "port": 8081, "gpuLayers": 999, "parallel": 2,
    "contBatching": true, "noMmap": true, "noWarmup": true,
    "metrics": true, "host": "0.0.0.0"
  },
  "aliases": {
    "coder": {
      "name": "Qwen3-Coder-Next Q8",
      "model": "~/models/Qwen3-Coder-Next/Q8_0/Qwen3-Coder-Next-Q8_0-00001-of-00003.gguf",
      "ctx": 131072, "parallel": 2
    },
    "qwen9b": {
      "name": "Qwen3.5-9B Q4_K_M",
      "model": "~/models/Qwen3.5-9B/Qwen3.5-9B-Q4_K_M.gguf",
      "ctx": 65536, "parallel": 4
    },
    "qwen35": {
      "name": "Qwen3.5-35B-A3B Q8",
      "model": "~/models/Qwen3.5-35B-A3B/Q8_0/Qwen3.5-35B-A3B-Q8_0.gguf",
      "ctx": 131072, "parallel": 2
    }
  }
}
```

## API Endpoints (server.mjs)
| Method | Path | Description |
|---|---|---|
| GET | /api/status | Running state, model, pid, uptime |
| GET | /api/models | Configured aliases + auto-discovered GGUFs |
| POST | /api/start | `{ alias }` — launch llama-server |
| POST | /api/stop | Graceful SIGTERM → SIGKILL |
| GET | /api/gpu | Live GPU stats from sysfs |
| GET | /api/logs | Last 100 lines of llama-server stdout |
| GET | /events | SSE stream, pushes status+gpu every 2s |
| GET | /* | Serves index.html |

## GPU Stats (sysfs — no radeontop process needed)
Read directly from `/sys/class/drm/card1/device/`:
- `gpu_busy_percent` → GPU utilization %
- `mem_info_gtt_used` / `mem_info_gtt_total` → unified memory used by GPU (~125GB pool — most important for Strix Halo)
- `mem_info_vram_used` / `mem_info_vram_total` → dedicated VRAM carveout (512MB)
- `pp_dpm_sclk` → current GPU clock (last line = active level)
- CPU temp from `/sys/class/hwmon/hwmon*/temp1_input` where name = `k10temp`

## Process Management (server.mjs)
- **LlamaManager class**: owns subprocess or adopts existing via `/tmp/neuralforge-llama.pid`
- Spawn with `LD_LIBRARY_PATH=~/.local/bin`, pipe stdout into 100-line circular buffer
- Health check via `localhost:8081/health` in addition to PID
- **Autostart**: `AUTOSTART_ALIAS=coder` env var → auto-load coder model 3s after NeuralForge starts
- Model switch: SIGTERM current → wait for port to close → spawn new

## Dashboard UI (dark, teal accent #00d4aa)
```
┌─────────────────────────────────────────────────────────┐
│  ⬡ NeuralForge              [● RUNNING] Qwen3-Coder Q8  │
├──────────────────────────┬──────────────────────────────┤
│  GPU                     │  MODEL                       │
│  ████████░░ 82%  busy    │  Qwen3-Coder-Next Q8         │
│  GTT: 84.2 / 125 GB      │  ctx: 131072  slots: 2/2     │
│  VRAM: 376 / 512 MB      │  port: 8081   uptime: 2h14m  │
│  Clock: 1900 MHz         │  18.3 t/s avg                │
│  CPU temp: 62°C          │                              │
├──────────────────────────┴──────────────────────────────┤
│  SWITCH MODEL                                           │
│  [coder ●]  [qwen35]  [qwen9b]                          │
│  + discovered models auto-scanned from ~/models/        │
├─────────────────────────────────────────────────────────┤
│  SERVER LOG                                [↕ expand]   │
│  19:42:01 llm_load_tensors: done                        │
│  19:42:22 server listening on 0.0.0.0:8081              │
├─────────────────────────────────────────────────────────┤
│  [■ STOP]              [Open WebUI ↗]  [API ↗]          │
└─────────────────────────────────────────────────────────┘
```
- SSE-driven live updates every 2s
- GPU bar: green < 60%, amber < 85%, red > 85%
- GTT bar shows model memory pressure (key metric for Strix Halo unified memory)
- Model switch: click → confirm → spinner → live

## Caddy Config
`/etc/caddy/Caddyfile`:
```
NeuralForge {
    reverse_proxy localhost:5757
    header /events Cache-Control no-cache
}
```

## Systemd System Service
`/etc/systemd/system/neuralforge.service` — runs at boot, no login required:
```ini
[Unit]
Description=NeuralForge LLM Manager
After=network.target

[Service]
Type=simple
User=pmcdavid
Group=pmcdavid
ExecStart=/usr/bin/node /home/pmcdavid/Projects/NeuralForgeDash/server.mjs
WorkingDirectory=/home/pmcdavid/Projects/NeuralForgeDash
Restart=always
RestartSec=5
Environment=PORT=5757
Environment=MODELS_DIR=/home/pmcdavid/models
Environment=LLAMA_BIN=/home/pmcdavid/.local/bin/llama-server
Environment=LD_LIBRARY_PATH=/home/pmcdavid/.local/bin
Environment=AUTOSTART_ALIAS=coder

[Install]
WantedBy=multi-user.target
```

Same pattern as the existing `llama-server.service` — system service, runs as `pmcdavid`, starts at boot. No loginctl linger needed.

## Interaction with Existing llama-server.service

There is already an active system service at `/etc/systemd/system/llama-server.service` running `start-llama.sh`. NeuralForge must not fight with it.

**Approach: NeuralForge takes ownership, system service defers to it.**

The existing service runs as user `pmcdavid` and calls `start-llama.sh`. We replace it with a minimal stub that just starts NeuralForge's auto-start if NeuralForge isn't already managing the process. In practice, the simplest clean solution is:

1. **Disable the existing llama-server.service** — NeuralForge system service replaces it entirely
2. **NeuralForge adopts any already-running llama-server** via PID file + health check on startup
3. **`start-llama.sh` remains working** — if someone runs it manually, NeuralForge detects it via polling port 8081

This means after setup:
- Boot → systemd starts NeuralForge as system service → NeuralForge auto-starts coder model
- No separate llama-server.service needed — NeuralForge owns the process
- No login required for any of this

## Build Order
1. `sudo pacman -S caddy`
2. Write `models.json`, `server.mjs`, `public/index.html`
3. Test: `node server.mjs` → `http://localhost:5757`
4. Write `/etc/caddy/Caddyfile`, `sudo systemctl enable --now caddy`
5. Test: `http://NeuralForge` in browser
6. **Stop and disable existing service**: `sudo systemctl disable --now llama-server`
7. Install system service: `sudo systemctl enable --now neuralforge`

## Verification
- `http://NeuralForge` loads dashboard with live GPU stats
- Model switch completes cleanly, Open WebUI reconnects
- `start-llama.sh` still works independently (NeuralForge adopts via PID file)
- After reboot: NeuralForge auto-starts, auto-loads coder model
