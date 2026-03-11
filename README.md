# NeuralForge Dashboard

A lightweight local LLM manager for llama.cpp on Strix Halo (AMD unified memory). Runs multiple models simultaneously, each on its own port, with a single dark web dashboard showing live GPU/CPU/GTT/disk stats, server logs, one-click load/stop, and HuggingFace model downloads. NeuralForge owns every llama-server process — one service, no external dependencies, no npm.

## Access

- Dashboard: `http://NeuralForge` (or `http://localhost:5757` directly)
- OpenAI-compatible API proxy: `http://localhost:5757/v1` — routes to the right running model by alias
- Individual llama-server instances: `http://localhost:8081`, `8082`, … (assigned automatically)

Point Open WebUI (or any OpenAI client) at `http://localhost:5757/v1` to see all running models.

## Installation

```bash
git clone https://github.com/ehippy/NeuralForgeDash
cd NeuralForgeDash
bash deploy/install.sh          # installs systemd unit, enables service
sudo systemctl start neuralforge
```

`install.sh` substitutes your username/home/project path into the service template and calls `daemon-reload` + `enable` automatically.

## Adding a Model

Models can be added two ways:

**From the dashboard** — click the 🤗 button in the navbar, paste a HuggingFace URL or `owner/repo`, pick a GGUF file. It downloads to `~/models/` and registers the alias automatically.

**Manually** — edit `models.json` and add an entry to `aliases`:

```json
"myalias": {
  "name": "Display Name",
  "model": "~/models/path/to/file.gguf",
  "ctx": 32768,
  "parallel": 2
}
```

No restart needed — the dashboard reads `models.json` live. The model won't appear if the `.gguf` file doesn't exist on disk.

## Per-Model Parameters

Every parameter can be overridden per alias from the **pencil ✏️ button** in the dashboard, or set directly in `models.json`. Unset fields fall back to `defaults`.

| Field | Default | Description |
|---|---|---|
| `ctx` | — | Context window size (tokens) |
| `parallel` | `3` | Simultaneous request slots (each costs `ctx × kv_size` GTT) |
| `gpuLayers` | `999` | Layers offloaded to GPU; 999 = all |
| `batchSize` | `512` | Logical prefill batch (`-b`); smaller = fairer GPU sharing across models |
| `ubatchSize` | `512` | Physical micro-batch (`-ub`); smaller = more frequent scheduling interleave |
| `flashAttn` | `true` | Flash Attention — faster + less memory at long contexts |
| `cacheTypeK` | `q8_0` | KV cache K quantisation (`f16`/`q8_0`/`q5_0`/`q4_0`) |
| `cacheTypeV` | `q8_0` | KV cache V quantisation (same options) |
| `enableThinking` | `null` | Qwen3 thinking mode: `true`=always, `false`=never, `null`=client decides |
| `autoLoad` | — | Load this model automatically on NeuralForge start |

## Autostart

Set `AUTOSTART_ALIAS` in the systemd unit (or uncomment in `deploy/neuralforge.service`), or tick the **autoload** checkbox on any model card in the dashboard. Multiple models can autoload simultaneously.

## Service Management

```bash
sudo systemctl restart neuralforge   # restart (autoload models reload after 3s)
sudo systemctl stop neuralforge       # stops NeuralForge and all llama-server children
journalctl -u neuralforge -f          # follow logs
curl -s http://localhost:5757/api/status | jq    # check running instances
curl -s http://localhost:5757/v1/models | jq     # OpenAI model list
```

## File Layout

```
NeuralForgeDash/
├── server.mjs          # Node.js backend (zero npm deps)
├── models.json         # Model registry + defaults
├── public/
│   ├── index.html      # Dashboard UI (Alpine.js + Bootstrap)
│   └── app.js          # Alpine store, SSE handler, HF download logic
└── deploy/
    ├── neuralforge.service   # systemd unit template
    └── install.sh            # install/update script
```

Config files outside the repo:
- `/etc/systemd/system/neuralforge.service` — installed by `deploy/install.sh`
- `/etc/caddy/Caddyfile` — reverse proxy (`NeuralForge` hostname → port 5757)

## API

| Method | Path | Description |
|---|---|---|
| GET | `/api/status` | All running instances with pid, port, uptime, healthy |
| GET | `/api/models` | Configured aliases (on-disk only) + discovered GGUFs |
| GET | `/api/gpu` | Live GPU/CPU/GTT/disk stats |
| GET | `/api/logs` | Last 100 lines from all llama-server instances |
| POST | `/api/start` | `{ "alias": "coder" }` — start a model |
| POST | `/api/stop` | `{ "alias": "coder" }` — graceful stop |
| POST | `/api/models/update` | Update per-model params (writes `models.json`) |
| POST | `/api/models/delete` | Remove alias + delete file from disk |
| POST | `/api/models/set-autoload` | Toggle autoload flag |
| GET | `/api/hf/files?repo=owner/repo` | List GGUF files in a HF repo |
| POST | `/api/hf/add` | Start downloading a HF model |
| GET | `/api/hf/downloads` | In-progress download status |
| POST | `/api/hf/cancel` | Cancel a download |
| GET | `/events` | SSE stream — pushes `update`, `started`, `stopped`, `hf-progress`, etc. |
| GET | `/v1/models` | OpenAI-compatible model list (running instances only) |
| POST | `/v1/chat/completions` | Proxied to instance matching `model` field |
| POST | `/v1/completions` | Same proxy |
| POST | `/v1/embeddings` | Same proxy |

## Hardware Notes (Strix Halo)

The key metric is **GTT** (unified system RAM used by the GPU) — this is where models actually live, not the 512 MB dedicated VRAM carveout. Watch the GTT bar in the navbar.

With multiple models loaded, GTT is divided up at load time and stays fixed — models don't fight over memory at runtime. They do share GPU compute cycles: prefill (long prompt ingestion) is the bully since it's compute-bound. The `batchSize`/`ubatchSize: 512` defaults cap how long a single prefill can monopolize the shader engines before other models get a turn.

If a model fails to load with OOM, check for orphan processes:

```bash
pgrep -fa llama-server
sudo systemctl restart neuralforge
```
