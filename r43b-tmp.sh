cd ~/llama.cpp
nohup ./build/bin/llama-server -m ~/models/Qwen2.5-7B-Instruct-Q4_K_M.gguf -np 4 -c 8192 -ngl 99 --host 127.0.0.1 --port 8080 > ~/llama-server.log 2>&1 &
for i in $(seq 1 60); do sleep 2; curl -sf http://127.0.0.1:8080/health >/dev/null && break; done
curl -s http://127.0.0.1:8080/health; echo
source ~/.nvm/nvm.sh >/dev/null
mkdir -p ~/teams-ai-e2e
rsync -a --delete --exclude node_modules --exclude .git --exclude web/node_modules --exclude '*-tmp.sh' /mnt/c/Users/Administrator/workspace/luke-lab/teams-ai/ ~/teams-ai-e2e/
cd ~/teams-ai-e2e && npm ci --no-audit --no-fund >/dev/null 2>&1 && echo deps-ok
nvidia-smi --query-gpu=memory.used --format=csv,noheader
