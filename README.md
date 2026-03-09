# NeuralForge Dashboard

A lightweight local LLM manager for llama.cpp on Strix Halo (AMD unified memory). Dark web dashboard with live GPU stats, server logs, and one-click model switching. NeuralForge owns the llama-server process completely — one service, no external dependencies.

## Access

- Dashboard: `http://NeuralForge` (or `http://localhost:5757` directly)
- Open WebUI connects to `http://localhost:8081`

## Adding a Model

Edit `models.json` and add an entry to `aliases`:

```json
"myalias": {
  "name": "Display Name",
  "model": "~/models/path/to/file.gguf",
  "ctx": 65536,
  "parallel": 2
}
```

No restart needed — the dashboard reads this file live. The model won't appear if the `.gguf` file doesn't exist on disk.

Per-alias overrides (all optional, fall back to `defaults`):
- `ctx` — context size
- `parallel` — number of slots
- `gpuLayers` — GPU layers (default 999 = all)

## Changing the Autostart Model

Edit `/etc/systemd/system/neuralforge.service`, change `AUTOSTART_ALIAS=coder` to your alias, then:

```bash
sudo systemctl daemon-reload && sudo systemctl restart neuralforge
```

## Service Management

```bash
sudo systemctl restart neuralforge   # restart everything (model reloads after 3s)
sudo systemctl stop neuralforge       # stops NeuralForge and kills llama-server
sudo systemctl status neuralforge     # check state
journalctl -u neuralforge -f          # follow service logs
```

The dashboard's Server Log panel shows llama-server stdout directly — that's the best place to watch model loading progress.

## File Layout

```
NeuralForgeDash/
├── server.mjs       # Node.js backend, no npm deps
├── models.json      # Model registry
└── public/
    └── index.html   # Dashboard UI
```

Config files:
- `/etc/systemd/system/neuralforge.service` — systemd unit
- `/etc/caddy/Caddyfile` — reverse proxy (port 80 → 5757)

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | Running state, model, pid, uptime, healthy |
| GET | `/api/models` | Configured aliases (present on disk only) + discovered GGUFs |
| GET | `/api/gpu` | Live GPU stats |
| GET | `/api/logs` | Last 100 lines of llama-server output |
| POST | `/api/start` | `{ "alias": "coder" }` — start a model |
| POST | `/api/stop` | Graceful stop |
| GET | `/events` | SSE stream, pushes updates every 2s |

## Hardware Notes (Strix Halo)

The key metric is **GTT** (unified memory used by GPU) — this is where models actually live, not the 512MB dedicated VRAM carveout. Watch the GTT bar in the dashboard to see memory pressure. At 125GB pool, the Q8_0 coder model uses ~85GB leaving ~40GB for the OS and other processes.

If a model fails to load with OOM, check for orphaned llama-server processes holding GTT memory:

```bash
pgrep -fa llama-server
# kill any that aren't children of neuralforge, then restart
sudo systemctl restart neuralforge
```
