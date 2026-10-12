# GitHub Copilot Bridge

Exposes GitHub Copilot as an OpenAI-compatible API endpoint for LLM Gateway integration.

## Architecture

```
LLM Gateway
    ↓
copilot-bridge (port 8791)
    ↓
GitHub Copilot API Proxy (copilot-api, port 8792)
    ↓
GitHub Copilot API (requires GitHub subscription)
```

## Prerequisites

- **Node.js 20+** installed
- **GitHub Account** with GitHub Copilot subscription (not free)
- **GitHub CLI** (for initial authentication)
- **PM2** for process management (optional, but recommended)

## Installation

### 1. Install Dependencies

```bash
cd copilot-bridge
npm install
```

This installs `copilot-api` as a dependency.

### 2. Authenticate with GitHub Copilot

```bash
# Method 1: Using npm script
npm run auth

# Method 2: Direct npx command
npx copilot-api@latest auth
```

This opens a browser window for GitHub OAuth authentication. Follow the prompts:
1. Click the authorization link
2. Approve access to GitHub Copilot API
3. The CLI will save your GitHub and Copilot tokens locally

**Important**: Authentication is **per-machine** and persists in `~/.copilot-api/` or similar directory.

### 3. Verify Authentication

```bash
# Check GitHub Copilot subscription and usage
npm run debug

# Or use the wrapper to verify both are working
node server.js
```

## Configuration

### Environment Variables

| Variable | Default | Notes |
|----------|---------|-------|
| `COPILOT_BRIDGE_PORT` | 8791 | Port for this wrapper |
| `COPILOT_API_INTERNAL_PORT` | 8792 | Internal port for copilot-api |

### Example .env

```bash
COPILOT_BRIDGE_PORT=8791
COPILOT_API_INTERNAL_PORT=8792
```

## Running

### Local Development

```bash
npm start
```

This will:
1. Start the GitHub Copilot API proxy on port 8792
2. Start the bridge wrapper on port 8791
3. Expose OpenAI-compatible `/v1/chat/completions` endpoint

### With PM2

```bash
npm run pm2

# Or manually
pm2 start server.js --name copilot-bridge
```

### Verify Health

```bash
curl http://localhost:8791/health
```

Response:
```json
{
  "status": "ok",
  "provider": "github-copilot",
  "version": "1.0.0",
  "copilot_api_port": 8792,
  "healthy": true
}
```

## Usage

### Direct API Call

```bash
curl -X POST http://localhost:8791/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4",
    "messages": [
      {
        "role": "user",
        "content": "Write a hello world function in TypeScript"
      }
    ],
    "temperature": 0.3,
    "max_tokens": 2048
  }'
```

### Via LLM Gateway

Once integrated into the gateway:

```bash
curl -X POST http://localhost:8791/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "model": "copilot",
    "messages": [
      {
        "role": "user",
        "content": "Explain quantum computing"
      }
    ]
  }'
```

## Integration with LLM Gateway

### 1. Add to external-providers.ts

```typescript
export const EXTERNAL_PROVIDERS: ExternalProviderConfig = {
  // ... other providers
  copilot: {
    name: 'GitHub Copilot',
    baseUrl: 'http://localhost:8791',
    requiresAuth: false, // Auth handled internally by copilot-api
    models: ['gpt-4', 'gpt-3.5-turbo'],
    rateLimit: 60, // requests per minute
    pricing: 'subscription-based'
  }
}
```

### 2. Update ecosystem.config.cjs

```javascript
{
  apps: [
    // ... other apps
    {
      name: 'copilot-bridge',
      script: './server.js',
      env: {
        COPILOT_BRIDGE_PORT: 8791,
        COPILOT_API_INTERNAL_PORT: 8792
      },
      error_file: '/var/log/llm-gateway/copilot-bridge.err.log',
      out_file: '/var/log/llm-gateway/copilot-bridge.out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z'
    }
  ]
}
```

### 3. Update ensure-bridges.sh

```bash
# Add copilot-bridge deployment
if [ ! -d "$COPILOT_BRIDGE_DIR" ]; then
  echo "Deploying copilot-bridge..."
  mkdir -p "$COPILOT_BRIDGE_DIR"
  cp copilot-bridge/server.js "$COPILOT_BRIDGE_DIR/"
  cp copilot-bridge/package.json "$COPILOT_BRIDGE_DIR/"
  cd "$COPILOT_BRIDGE_DIR"
  npm install
  echo "✓ copilot-bridge deployed"
fi
```

## Provider Fallback Chain (After Integration)

```
Request → LLM Gateway
   ↓
1. Ollama (local)
2. claude-bridge (Claude subscription)
3. openai-bridge (OpenAI subscription)
4. copilot-bridge (GitHub Copilot subscription) ← NEW
5. cerebras (free tier)
6. groq (free tier)
7. mistral (free tier)
8. nvidia (free tier)
9. cloudflare (free tier)
```

## Troubleshooting

### Authentication Failed

```bash
# Clear cached tokens and re-authenticate
rm -rf ~/.copilot-api
npm run auth
```

### Port Already in Use

```bash
# Find process using port 8791
lsof -i :8791

# Kill if needed
kill -9 <PID>
```

### Copilot API Won't Start

```bash
# Test copilot-api directly
npx copilot-api@latest start --port 8792 --verbose

# Check for GitHub subscription
npm run debug
```

### Bridge Wrapper Fails

```bash
# Check logs
pm2 logs copilot-bridge

# Test direct server start
node server.js

# Verify Node.js version
node --version  # Should be 20+
```

### Subscription Issues

GitHub Copilot API requires an active GitHub Copilot subscription. If you see authentication errors:

1. Verify your GitHub Copilot subscription is active
2. Check payment method is valid
3. Re-authenticate: `npm run auth`
4. Review usage at: https://github.com/settings/copilot

## Security Notes

- **Authentication tokens** are stored in `~/.copilot-api/` on the local machine
- **Do NOT commit** authentication credentials to git
- **Environment variables** should be set via `.env` or PM2 environment
- **Rate limiting** is per GitHub account (not per API key)
- **Usage tracking** is available via GitHub Copilot dashboard

## Performance Characteristics

| Metric | Value | Notes |
|--------|-------|-------|
| **Cold start** | ~5-10s | copilot-api initialization |
| **Warm latency** | 200-500ms | Per request (varies by model) |
| **Rate limit** | 60 req/min | GitHub Copilot API limit |
| **Max tokens** | 2048 default | Configurable per request |
| **Timeout** | 300s | Global timeout |

## Cost Considerations

- **GitHub Copilot Individual**: $10/month (monthly) or $100/year (annual)
- **GitHub Copilot Business**: $19/month per user
- **No per-request cost** once subscription is active
- **Unlimited requests** within rate limits

## Differences from OpenAI

| Aspect | Copilot | OpenAI |
|--------|---------|--------|
| **Auth** | GitHub subscription | API key |
| **Cost** | Flat subscription | Per token |
| **Rate limit** | 60 req/min | Varies by plan |
| **Models** | Limited selection | More options |
| **Availability** | GitHub-backed | Anthropic-backed |

## Switching Providers

If you need to switch away from Copilot:

```bash
# Stop copilot-bridge
pm2 stop copilot-bridge
pm2 delete copilot-bridge

# Gateway will fall back to next provider automatically
# Restart gateway to clear connections
pm2 restart llm-gateway
```

## Next Steps

1. Deploy: follow your host integration steps
2. Test with LLM Gateway: Verify routing works correctly
3. Monitor usage: Track GitHub Copilot API quota
4. Optimize fallback chain: Adjust provider preferences based on performance

---

**Last Updated**: 2026-04-25
**Maintained By**: renefichtmueller
**License**: MIT
