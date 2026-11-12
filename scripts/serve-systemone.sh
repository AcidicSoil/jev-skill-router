#!/usr/bin/env bash
# Launch an installed System One adapter and its llama.cpp model as one owned process.
set -euo pipefail

if [[ "${1:-}" == "staged" ]]; then
  if (( $# != 4 )) || [[ "$3" != "--port" ]]; then
    echo "Usage: serve-systemone.sh staged GGUF --port API_PORT" >&2
    exit 2
  fi
  adapter="staged"
  gguf="$2"
  llama_port="$4"
  api_port="$4"
  adapter_input=""
else
  if (( $# != 6 )) || [[ "$5" != "--port" ]]; then
    echo "Usage: serve-systemone.sh {intern|startlux} GGUF LLAMA_PORT MODEL_DIR_OR_ID --port API_PORT" >&2
    exit 2
  fi
  adapter="$1"
  gguf="$2"
  llama_port="$3"
  adapter_input="$4"
  api_port="$6"
fi

if [[ ! -f "$gguf" || ! "$llama_port" =~ ^[0-9]+$ || ! "$api_port" =~ ^[0-9]+$ ]] ||
   (( llama_port < 1024 || llama_port > 65535 || api_port < 1024 || api_port > 65535 )); then
  echo "Invalid model path or loopback ports" >&2
  exit 2
fi
if [[ "$adapter" != "intern" && "$adapter" != "startlux" && "$adapter" != "staged" ]] ||
   [[ "$adapter" != "staged" && "$llama_port" == "$api_port" ]]; then
  echo "Unsupported adapter or overlapping ports" >&2
  exit 2
fi

llama="${JEV_LLAMA_BIN:-llama-server}"
runtime="${JEV_DROID_LEASE_DIR:-$HOME/.local/share/jev-skill-router/adapters}"
mkdir -p "$runtime"
chmod 700 "$runtime"
llama_pid=""
adapter_pid=""
stage_dir=""
cleanup() {
  [[ -z "$adapter_pid" ]] || kill "$adapter_pid" 2>/dev/null || true
  [[ -z "$llama_pid" ]] || kill "$llama_pid" 2>/dev/null || true
  [[ -z "$adapter_pid" ]] || wait "$adapter_pid" 2>/dev/null || true
  [[ -z "$llama_pid" ]] || wait "$llama_pid" 2>/dev/null || true
  if [[ -n "$stage_dir" ]]; then
    rm -f -- "$stage_dir/model.gguf"
    rmdir -- "$stage_dir"
  fi
}
trap 'exit 0' TERM INT
trap cleanup EXIT

if [[ "$adapter" == "staged" ]]; then
  available_kb=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)
  required_bytes=$(stat -c '%s' "$gguf")
  if (( available_kb * 1024 < required_bytes + 3 * 1024 * 1024 * 1024 )); then
    echo "Insufficient available RAM for memory-backed GGUF staging" >&2
    exit 1
  fi
  stage_dir=$(mktemp -d /dev/shm/jev-droid-gguf.XXXXXXXX)
  dd if="$gguf" of="$stage_dir/model.gguf" bs=1M iflag=fullblock status=none
  if [[ $(stat -c '%s' "$stage_dir/model.gguf") != "$required_bytes" ]]; then
    echo "Staged GGUF size mismatch" >&2
    exit 1
  fi
  gguf="$stage_dir/model.gguf"
fi

llama_args=(--model "$gguf" --host 127.0.0.1 --port "$llama_port"
  --no-webui --ctx-size "${JEV_LLAMA_CTX_SIZE:-4096}" --parallel 1
  --n-gpu-layers "${JEV_LLAMA_GPU_LAYERS:-99}")
if [[ -n "${JEV_LLAMA_FIT:-}" ]]; then
  llama_args+=(--fit "$JEV_LLAMA_FIT")
fi
if [[ "${JEV_LLAMA_DISABLE_OP_OFFLOAD:-0}" == "1" ]]; then
  llama_args+=(--no-op-offload)
fi
if [[ -n "${JEV_LLAMA_LOAD_MODE:-}" ]]; then
  llama_args+=(--load-mode "$JEV_LLAMA_LOAD_MODE")
fi
if [[ "${JEV_LLAMA_NO_WARMUP:-0}" == "1" ]]; then
  llama_args+=(--no-warmup)
fi
"$llama" "${llama_args[@]}" > "$runtime/llama.log" 2>&1 &
llama_pid=$!

ready=0
for (( i=0; i<100; i++ )); do
  if curl -fsS --max-time 2 "http://127.0.0.1:$llama_port/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$llama_pid" 2>/dev/null; then break; fi
  sleep 1
done
if (( !ready )); then
  echo "llama.cpp failed to load model; inspect $runtime/llama.log" >&2
  exit 1
fi

if [[ "$adapter" == "staged" ]]; then
  wait "$llama_pid"
  exit $?
fi

if [[ "$adapter" == "intern" ]]; then
  if [[ ! -d "${JEV_INTERN_SRC:-}" ]]; then
    echo "JEV_INTERN_SRC must point to the installed Intern adapter source" >&2
    exit 2
  fi
  PYTHONPATH="$JEV_INTERN_SRC" "${JEV_INTERN_PYTHON:-python3}" \
    -m jev_local_bridge.intern_gguf --port "$api_port" \
    --llama-url "http://127.0.0.1:$llama_port" --model-id "$adapter_input" &
else
  "${JEV_STARTLUX_BIN:-startlux-decide}" serve --model "$adapter_input" \
    --backend llamacpp --llamacpp-url "http://127.0.0.1:$llama_port" \
    --host 127.0.0.1 --port "$api_port" --name "${JEV_MODEL_ID:-startlux}" &
fi
adapter_pid=$!
wait "$adapter_pid"
