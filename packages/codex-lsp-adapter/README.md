# Codex LSP Adapter

Language Server Protocol adapter for GitHub Copilot/Microsoft Codex integration with LLM Gateway.

## Overview

Implements the Language Server Protocol (LSP) to allow Codex and Copilot plugins to connect to the LLM Gateway. Bridges the gap between LSP's structured protocol and the gateway's completion API.

## Installation

```bash
npm install @llm-gateway/codex-lsp-adapter
```

## Usage

### As a Language Server

```bash
# Start the LSP server (listens on stdio)
npx codex-lsp

# Or in Node.js
import CodexLSPAdapter from '@llm-gateway/codex-lsp-adapter'

const adapter = new CodexLSPAdapter()
adapter.start()
```

### VS Code Extension Configuration

```json
{
  "languageServerHangingPercent": 0,
  "languageServers": {
    "codex": {
      "command": "codex-lsp",
      "args": [],
      "languages": [
        "javascript",
        "typescript",
        "python",
        "go",
        "rust"
      ]
    }
  }
}
```

## Features

### Implemented

- **Completions** (`textDocument/completion`): Code completion triggered by `.`, space, or `(`
- **Hover** (`textDocument/hover`): Hover documentation with code explanation
- **Text Sync**: Full document synchronization
- **Execute Commands**: `codex.explain`, `codex.refactor`, `codex.test`, `codex.fix`

### Architecture

The adapter translates LSP requests to gateway completions:

```
LSP Client (Copilot/IDE)
    ↓
CodexLSPAdapter (stdio bridge)
    ↓
LLM Gateway API
    ↓
Model Selection (claude, Ollama, external)
```

## Environment Variables

```bash
GATEWAY_URL=http://localhost:0000  # LLM Gateway endpoint
OLLAMA_URL=localhost:11434              # Local Ollama fallback
AGENT_ID=codex-lsp-server                      # Agent identifier
LOG_LEVEL=debug                                # Logging level
```

## Protocol Details

### Supported Capabilities

```typescript
{
  textDocumentSync: 1,                          // Full document sync
  completionProvider: {
    resolveProvider: true,
    triggerCharacters: ['.', ' ', '(']
  },
  hoverProvider: true,
  definitionProvider: true,
  codeActionProvider: true,
  executeCommandProvider: {
    commands: [
      'codex.explain',
      'codex.refactor',
      'codex.test',
      'codex.fix'
    ]
  }
}
```

### Response Format

Completion items include:
- **label**: First line of completion
- **insertText**: Full completion text
- **documentation**: Model name and confidence
- **detail**: Source (Gateway vs Ollama fallback)
- **kind**: CompletionItemKind.Snippet

## Testing

```bash
npm test
```

Tests cover:
- LSP initialization and shutdown
- Completion requests with various triggers
- Hover information extraction
- Error handling and fallback behavior
- Confidence score reporting

## Troubleshooting

### Server not connecting

1. Check if LSP server is running: `lsof -i :protocol`
2. Verify gateway is accessible: `curl http://localhost:0000/health`
3. Check logs: `LOG_LEVEL=debug codex-lsp`

### Slow completions

1. Reduce `maxTokens` in completion requests
2. Check gateway latency: `curl -w "@curl-format.txt" http://localhost:0000/health`
3. Verify Ollama is running if using fallback

### Poor suggestion quality

1. Adjust temperature/top_p in gateway requests
2. Check model selection (may be using fallback)
3. Provide more context in completion requests

## Performance

Typical latencies:
- **Gateway mode**: 100-500ms (depends on model)
- **Ollama fallback**: 200-2000ms (depends on hardware)
- **Timeout**: 30s (configurable)

## Security

- LSP communicates over stdio (no network exposure)
- Gateway API calls use configured authentication
- Ollama fallback is local-only by default
- No credentials stored in LSP adapter
