#!/usr/bin/env node

import CodexLSPAdapter from './index.js'

const adapter = new CodexLSPAdapter()

// Start the LSP server
adapter.start()

// Log startup
console.error('[Codex LSP] Server started on stdio')
console.error(`[Codex LSP] Gateway URL: ${process.env.GATEWAY_URL || 'default'}`)
console.error(`[Codex LSP] Ollama URL: ${process.env.OLLAMA_URL || 'http://localhost:11434'}`)
