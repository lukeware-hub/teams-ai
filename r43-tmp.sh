set -e
exec > /home/diego/r43-setup.log 2>&1
echo "start $(date -u +%FT%TZ)"
sudo -n apt-get update -qq
sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nvidia-cuda-toolkit build-essential git >/dev/null
nvcc --version | tail -1
[ -d ~/llama.cpp ] || git clone -q --depth 1 https://github.com/ggml-org/llama.cpp ~/llama.cpp
cd ~/llama.cpp
cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=86 -DLLAMA_CURL=OFF >/dev/null
cmake --build build --config Release -j 8 --target llama-server >/dev/null
ls -la build/bin/llama-server
mkdir -p ~/models
[ -f ~/models/Qwen2.5-7B-Instruct-Q4_K_M.gguf ] || curl -sSL -o ~/models/Qwen2.5-7B-Instruct-Q4_K_M.gguf https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF/resolve/main/Qwen2.5-7B-Instruct-Q4_K_M.gguf
ls -la ~/models
echo "done $(date -u +%FT%TZ)"
