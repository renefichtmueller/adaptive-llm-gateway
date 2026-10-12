import { execFile } from 'child_process'
import { createServer } from 'http'
import { promisify } from 'util'

const exec = promisify(execFile)
const PORT = process.env.OPENAI_BRIDGE_PORT || 8790
const API_KEY = process.env.OPENAI_API_KEY
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4-turbo'

const SYSTEM_CODEX = `You are an expert code generation AI.
Generate clean, well-documented, production-ready code.
Output only the code — no explanations, no markdown blocks, no preamble.`

const SYSTEM_CHATGPT = `You are a helpful AI assistant.
Provide clear, concise, accurate responses.
Output only the response — no preamble.`

async function callOpenAI(messages, model, temperature = 0.3, maxTokens = 2048) {
  if (!API_KEY) {
    throw new Error('OPENAI_API_KEY not configured')
  }

  const args = [
    'api', 'chat.completions.create',
    '-m', model,
    '-t', String(temperature),
    '-M', String(maxTokens),
  ]

  for (const msg of messages) {
    args.push('-g', msg.role, msg.content)
  }

  return new Promise((resolve) => {
    const env = {
      ...process.env,
      OPENAI_API_KEY: API_KEY
    }

    exec('openai', args, { env, timeout: 300_000, maxBuffer: 1024 * 1024 * 10 }, (err, stdout) => {
      if (err) {
        resolve({
          success: false,
          content: null,
          error: err.message.slice(0, 500),
          stderr: err.stderr?.slice(0, 500)
        })
      } else {
        try {
          const result = JSON.parse(stdout)
          const content = result.choices?.[0]?.message?.content || result.message?.content || stdout
          resolve({ success: true, content, error: null })
        } catch (e) {
          resolve({ success: true, content: stdout.trim(), error: null })
        }
      }
    })
  })
}

const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200)
    res.end(JSON.stringify({
      status: 'ok',
      version: '1.0.0',
      provider: 'openai',
      model: DEFAULT_MODEL,
      configured: !!API_KEY
    }))
    return
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', async () => {
      try {
        const { model, messages, temperature, max_tokens, type } = JSON.parse(body)

        if (!messages || !Array.isArray(messages)) {
          res.writeHead(400)
          res.end(JSON.stringify({ error: 'messages array required' }))
          return
        }

        const selectedModel = model || DEFAULT_MODEL
        const temp = temperature ?? 0.3
        const maxTok = max_tokens ?? 2048

        console.log(`[${new Date().toISOString()}] OpenAI ${selectedModel} (${type || 'chat'})`)

        const result = await callOpenAI(messages, selectedModel, temp, maxTok)

        if (result.success) {
          res.writeHead(200)
          res.end(JSON.stringify({
            success: true,
            content: result.content,
            provider: 'openai',
            model: selectedModel
          }))
        } else {
          res.writeHead(500)
          res.end(JSON.stringify({
            success: false,
            error: result.error,
            stderr: result.stderr
          }))
        }
      } catch (e) {
        console.error('Error:', e.message)
        res.writeHead(500)
        res.end(JSON.stringify({ error: e.message }))
      }
    })
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: 'not found' }))
})

server.listen(PORT, () => {
  console.log(`openai-bridge running on port ${PORT}`)
  console.log(`  POST http://localhost:${PORT}/v1/chat/completions`)
  console.log(`  GET  http://localhost:${PORT}/health`)
  console.log(`  Model: ${DEFAULT_MODEL}`)
  console.log(`  API Key configured: ${!!API_KEY}`)
})
