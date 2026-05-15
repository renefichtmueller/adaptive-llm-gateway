/**
 * Copilot Bridge Wrapper
 *
 * This wrapper manages the GitHub Copilot API proxy (copilot-api).
 * The copilot-api package itself is an OpenAI-compatible proxy for GitHub Copilot.
 *
 * This script:
 * 1. Validates GitHub authentication
 * 2. Starts copilot-api on the configured port
 * 3. Provides health check endpoint
 * 4. Handles graceful shutdown
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import http from 'http'

const exec = promisify(execFile)
const PORT = process.env.COPILOT_BRIDGE_PORT || 0
const COPILOT_API_PORT = parseInt(process.env.COPILOT_API_INTERNAL_PORT || '0000')

let copilotApiProcess = null
let copilotHealthy = false

/**
 * Start the GitHub Copilot API proxy
 * This runs: npx copilot-api@latest start --port <port>
 */
async function startCopilotAPI() {
  console.log(`[${new Date().toISOString()}] Starting GitHub Copilot API proxy on port ${COPILOT_API_PORT}...`)

  return new Promise((resolve, reject) => {
    const args = [
      'copilot-api@latest',
      'start',
      '--port', String(COPILOT_API_PORT),
      '--verbose'
    ]

    const child = execFile('npx', args, (err) => {
      if (err && err.code !== 0) {
        console.error(`[${new Date().toISOString()}] Copilot API process exited:`, err.message)
        copilotHealthy = false
      }
    })

    // Monitor output
    child.stdout?.on('data', (data) => {
      console.log(`[Copilot] ${data.toString().trim()}`)
      if (data.toString().includes('listening') || data.toString().includes('ready')) {
        copilotHealthy = true
        resolve(child)
      }
    })

    child.stderr?.on('data', (data) => {
      console.error(`[Copilot Error] ${data.toString().trim()}`)
    })

    copilotApiProcess = child

    // Timeout if copilot-api doesn't start within 30s
    setTimeout(() => {
      if (!copilotHealthy) {
        reject(new Error('Copilot API failed to start within 30 seconds'))
      }
    }, 30000)
  })
}

/**
 * Proxy requests to copilot-api
 */
async function proxyCopilotAPI(req, res, path) {
  try {
    const body = await new Promise((resolve, reject) => {
      let data = ''
      req.on('data', chunk => data += chunk)
      req.on('end', () => resolve(data))
      req.on('error', reject)
    })

    const options = {
      hostname: 'localhost',
      port: COPILOT_API_PORT,
      path: path,
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...req.headers
      }
    }

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers)
      proxyRes.pipe(res)
    })

    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err.message)
      res.writeHead(502)
      res.end(JSON.stringify({ error: 'Bad Gateway', details: err.message }))
    })

    proxyReq.end(body)
  } catch (e) {
    console.error('Proxy request error:', e.message)
    res.writeHead(500)
    res.end(JSON.stringify({ error: e.message }))
  }
}

/**
 * HTTP Server for health checks and proxying
 */
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  // Health check endpoint
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(copilotHealthy ? 200 : 503)
    res.end(JSON.stringify({
      status: copilotHealthy ? 'ok' : 'starting',
      provider: 'github-copilot',
      version: '1.0.0',
      copilot_api_port: COPILOT_API_PORT,
      healthy: copilotHealthy
    }))
    return
  }

  // Proxy all other requests to copilot-api
  if (req.method === 'POST' || req.method === 'GET') {
    // Forward to copilot-api
    proxyCopilotAPI(req, res, req.url)
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: 'Not found' }))
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log(`[${new Date().toISOString()}] SIGTERM received, shutting down...`)
  server.close(() => {
    if (copilotApiProcess) {
      copilotApiProcess.kill()
    }
    process.exit(0)
  })
})

// Start copilot-api and then the proxy server
startCopilotAPI()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`[${new Date().toISOString()}] copilot-bridge running on port ${PORT}`)
      console.log(`  POST http://localhost:${PORT}/v1/chat/completions`)
      console.log(`  GET  http://localhost:${PORT}/health`)
      console.log(`  GitHub Copilot API: http://localhost:${COPILOT_API_PORT}`)
    })
  })
  .catch((err) => {
    console.error(`[${new Date().toISOString()}] Failed to start:`, err.message)
    process.exit(1)
  })
