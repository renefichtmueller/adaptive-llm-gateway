# Claude Code Bridge

Integration layer between Claude Code IDE and LLM Gateway.

## Overview

Provides a high-level API for Claude Code to leverage the LLM Gateway's multi-model orchestration, confidence gating, and fallback capabilities.

## Installation

```bash
npm install @llm-gateway/claude-code-bridge
```

## Usage

```typescript
import { ClaudeCodeBridge } from '@llm-gateway/claude-code-bridge'

const bridge = new ClaudeCodeBridge({
  gatewayUrl: 'http://localhost:0000',
  agentId: 'claude-code-ide',
  ideVersion: '1.0.0',
  extensionVersion: '1.0.0',
  ollamaUrl: 'localhost:11434' // Local fallback
})

// Explain selected code
const explanation = await bridge.explain(context, selectedCode)

// Refactor code
const refactored = await bridge.refactor(context, selectedCode)

// Generate tests
const tests = await bridge.test(context, selectedCode)

// Add documentation
const docs = await bridge.document(context, selectedCode)

// Fix errors
const fix = await bridge.fixError(errorMessage, context)

// Check health
const status = await bridge.health()
```

## Features

- **Code Explanation**: Analyze and explain code snippets
- **Refactoring**: Suggest improvements to existing code
- **Test Generation**: Automatically generate test cases
- **Documentation**: Create JSDoc/TSDoc comments
- **Error Fixing**: Debug and fix code errors
- **Fallback**: Automatic fallback to local Ollama when gateway unavailable
- **Confidence Tracking**: Monitor model confidence in responses
- **Token Counting**: Track usage for billing/analytics

## Architecture

The bridge implements the three-layer agent integration stack from ADR-0005:

1. **Transport Layer**: HTTP/WebSocket communication with gateway
2. **Adapter Layer**: ClaudeCodeBridge wraps client SDK
3. **Protocol Layer**: Standardized request/response format

## Health Status

```typescript
const health = await bridge.health()
// {
//   healthy: true,
//   gateway: true,
//   ollama: 'running',
//   mode: 'gateway'
// }
```

Modes:
- `gateway`: Using LLM Gateway (preferred)
- `fallback`: Using local Ollama (gateway unavailable)
- `offline`: Both gateway and Ollama offline (error)

## Configuration

```typescript
interface ClaudeCodeBridgeConfig {
  gatewayUrl: string                 // LLM Gateway endpoint
  agentId: string                    // Agent identifier (default: 'claude-code-ide')
  ideVersion: string                 // Claude Code version
  extensionVersion: string           // Bridge extension version
  ollamaUrl?: string                 // Local Ollama URL (optional)
  apiKey?: string                    // Gateway API key (if required)
  requestTimeout?: number            // Request timeout in ms (default: 30000)
}
```

## Response Format

```typescript
interface ClaudeCodeResponse {
  text: string           // Generated response
  tokens: {
    input: number        // Input tokens
    output: number       // Output tokens
  }
  model: string          // Model used
  fallback: boolean      // Whether using fallback
  confidence: number     // 0-1 confidence score
}
```

## Testing

```bash
npm test
```

Tests cover:
- Health checks
- All completion methods (explain, refactor, test, document, fix)
- Fallback behavior
- Token limiting
- Metadata tracking
