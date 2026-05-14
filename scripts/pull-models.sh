#!/bin/bash
OLLAMA_URL="${OLLAMA_URL:-http://192.168.178.169:11434}"
echo "Pulling models from $OLLAMA_URL..."
for model in "qwen2.5:3b" "qwen2.5:14b" "qwen2.5:32b"; do
  echo "Pulling $model..."
  curl -s -X POST "$OLLAMA_URL/api/pull" -d "{\"name\":\"$model\"}" | python3 -c "import sys; [print(l) for l in sys.stdin.read().split('\n') if 'status' in l]" 2>/dev/null || echo "Done: $model"
done
echo "All models pulled"
