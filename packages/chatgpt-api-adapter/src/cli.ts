#!/usr/bin/env node

import ChatGPTAPIAdapter, { DEFAULT_PORT } from './index.js'

const port = parseInt(process.env.CHATGPT_API_PORT || String(DEFAULT_PORT), 10)
const adapter = new ChatGPTAPIAdapter(port)

adapter.start().catch(error => {
  console.error('[ChatGPT API] Failed to start:', error)
  process.exit(1)
})

process.on('SIGTERM', async () => {
  console.error('[ChatGPT API] SIGTERM received, shutting down...')
  await adapter.stop()
  process.exit(0)
})

process.on('SIGINT', async () => {
  console.error('[ChatGPT API] SIGINT received, shutting down...')
  await adapter.stop()
  process.exit(0)
})
