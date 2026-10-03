# ChatGPT API Adapter

OpenAI API compatibility adapter for LLM Gateway. Allows OpenAI client SDKs and curl requests to transparently use LLM Gateway.

## Overview

Provides an HTTP server that implements the OpenAI Chat Completions API specification, transparently routing requests to the LLM Gateway. Existing OpenAI client code requires only a baseURL configuration change.

## Installation

```bash
npm install @llm-gateway/chatgpt-api-adapter
```

## Usage

### As a Standalone Server

```bash
# Start the adapter (listens on port 8788)
npx chatgpt-api

# Or with custom port
CHATGPT_API_PORT=8080 npx chatgpt-api

# Or in Node.js
import ChatGPTAPIAdapter from '@llm-gateway/chatgpt-api-adapter'

const adapter = new ChatGPTAPIAdapter(8788)
await adapter.start()
```

### With OpenAI Client SDK

```typescript
import OpenAI from 'openai'

const client = new OpenAI({
  apiKey: 'not-needed',
  baseURL: 'http://localhost:8788/v1'
})

const response = await client.chat.completions.create({
  model: 'gpt-4',
  messages: [
    { role: 'user', content: 'Hello, world!' }
  ]
})
```

### With curl

```bash
curl http://localhost:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {"role": "user", "content": "Explain TypeScript"}
    ],
    "max_tokens": 500
  }'
```

### Streaming

```bash
curl http://localhost:8788/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {"role": "user", "content": "List 5 ideas"}
    ],
    "stream": true
  }'
```

## Features

### Implemented

- **Chat Completions** (`POST /v1/chat/completions`): Full OpenAI API compatibility
- **Streaming** (`stream: true`): Server-Sent Events (SSE) with chunked responses
- **Models** (`GET /v1/models`): Lists available GPT models
- **Health** (`GET /health`): Gateway health status
- **Model Mapping**: Automatic mapping from OpenAI to gateway model names

### Model Mapping

| OpenAI Model | Gateway Model |
|--------------|---------------|
| gpt-4 | qwen2.5:32b |
| gpt-4-turbo | qwen2.5:32b |
| gpt-3.5-turbo | qwen2.5:14b |
| gpt-4-mini | qwen2.5:3b |

## Architecture

```
OpenAI Client
    ↓
ChatGPT API Adapter (HTTP server)
    ↓
LLM Gateway API
    ↓
Model Selection (claude, Ollama, external)
```

## Environment Variables

```bash
CHATGPT_API_PORT=8788                          # Listen port
GATEWAY_URL=http://localhost:8787  # LLM Gateway endpoint
OLLAMA_URL=http://localhost:11434              # Local Ollama fallback
AGENT_ID=chatgpt-api-adapter                   # Agent identifier
LOG_LEVEL=debug                                # Logging level
```

## API Endpoints

### POST /v1/chat/completions

Chat completion request using OpenAI format.

**Request:**
```json
{
  "model": "gpt-4",
  "messages": [
    {"role": "system", "content": "You are helpful..."},
    {"role": "user", "content": "Hello"}
  ],
  "temperature": 0.7,
  "max_tokens": 2000,
  "top_p": 1,
  "stream": false
}
```

**Response (non-streaming):**
```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "gpt-4",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 10,
    "completion_tokens": 5,
    "total_tokens": 15
  }
}
```

**Response (streaming):**
```
data: {"id":"chatcmpl-123","object":"text_completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"H"},"finish_reason":null}]}
data: {"id":"chatcmpl-123","object":"text_completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"ello"},"finish_reason":null}]}
...
data: {"id":"chatcmpl-123","object":"text_completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
data: [DONE]
```

### GET /v1/models

List available models.

**Response:**
```json
{
  "object": "list",
  "data": [
    {"id": "gpt-4", "object": "model", "owned_by": "openai"},
    {"id": "gpt-4-turbo", "object": "model", "owned_by": "openai"},
    {"id": "gpt-3.5-turbo", "object": "model", "owned_by": "openai"},
    {"id": "gpt-4-mini", "object": "model", "owned_by": "openai"}
  ]
}
```

### GET /health

Gateway health status.

**Response:**
```json
{
  "status": "ok",
  "gateway": {
    "uptime": 123456,
    "models": ["qwen2.5:3b", "qwen2.5:14b"],
    "latency_ms": 250
  }
}
```

## Performance

Typical latencies:
- **Gateway mode**: 100-500ms (depends on model)
- **Ollama fallback**: 200-2000ms (depends on hardware)
- **Streaming chunk**: 10-50ms per chunk
- **Timeout**: 30s (configurable via gateway)

## Testing

```bash
npm test
```

Tests cover:
- Chat completions (streaming and buffered)
- Model listing
- Error handling and fallback behavior
- Token counting accuracy
- Message formatting
- Health checks

## Security

- No API key validation (assumes network-isolated deployment)
- CORS enabled for all origins (configure as needed)
- Messages logged at DEBUG level only
- Automatic cleanup on shutdown (SIGTERM, SIGINT)

## Troubleshooting

### OpenAI client not connecting

1. Verify adapter is running: `curl http://localhost:8788/health`
2. Check baseURL in client: should be `http://localhost:8788/v1` (with `/v1` at the end)
3. Ensure gateway is accessible: `curl $GATEWAY_URL/health`

### Streaming not working

1. Verify `stream: true` in request body
2. Check for SSE support in client library
3. Ensure no intermediate proxies are buffering responses

### Slow responses

1. Check gateway latency: `curl -w "%{time_total}\n" $GATEWAY_URL/health`
2. Verify model availability: `curl http://localhost:8788/v1/models`
3. Check system resources on gateway (CPU, memory, disk)

## Compatibility

- OpenAI Client SDK (Python, Node.js, Go, etc.)
- LiteLLM
- Anthropic Bedrock (proxy mode)
- Any HTTP client using OpenAI API format
