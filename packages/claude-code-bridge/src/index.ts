import { createTIPClient, type TIPClientConfig } from '@llm-gateway/client'

export interface ClaudeCodeBridgeConfig extends TIPClientConfig {
  agentId: string
  ideVersion: string
  extensionVersion: string
}

export interface ClaudeCodeRequest {
  command: string
  context: string
  selection?: string
  temperature?: number
  maxTokens?: number
}

export interface ClaudeCodeResponse {
  text: string
  tokens: { input: number; output: number }
  model: string
  fallback: boolean
  confidence: number
}

export class ClaudeCodeBridge {
  private client: ReturnType<typeof createTIPClient>
  private config: ClaudeCodeBridgeConfig

  constructor(config: ClaudeCodeBridgeConfig) {
    this.config = {
      agentId: 'claude-code-ide',
      ideVersion: config.ideVersion,
      extensionVersion: config.extensionVersion,
      ...config
    }
    this.client = createTIPClient(this.config)
  }

  async explain(context: string, selection: string): Promise<ClaudeCodeResponse> {
    const prompt = `Explain the following code in detail:\n\n\`\`\`\n${selection}\n\`\`\`\n\nContext:\n${context}`
    return this.completion('explain', prompt)
  }

  async refactor(context: string, selection: string): Promise<ClaudeCodeResponse> {
    const prompt = `Refactor the following code to improve readability, performance, and maintainability:\n\n\`\`\`\n${selection}\n\`\`\`\n\nContext:\n${context}`
    return this.completion('refactor', prompt)
  }

  async test(context: string, selection: string): Promise<ClaudeCodeResponse> {
    const prompt = `Write comprehensive tests for the following code:\n\n\`\`\`\n${selection}\n\`\`\`\n\nContext:\n${context}`
    return this.completion('test', prompt)
  }

  async document(context: string, selection: string): Promise<ClaudeCodeResponse> {
    const prompt = `Write JSDoc/TSDoc documentation for the following code:\n\n\`\`\`\n${selection}\n\`\`\`\n\nContext:\n${context}`
    return this.completion('document', prompt)
  }

  async fixError(errorMessage: string, context: string): Promise<ClaudeCodeResponse> {
    const prompt = `Fix the following error:\n${errorMessage}\n\nContext:\n${context}`
    return this.completion('fix', prompt)
  }

  async completion(command: string, prompt: string, maxTokens = 2000): Promise<ClaudeCodeResponse> {
    const result = await this.client.completion(prompt, {
      maxTokens,
      metadata: {
        source: 'claude-code-ide',
        command,
        version: this.config.ideVersion
      }
    })

    return {
      text: result.text,
      tokens: result.tokens,
      model: result.model,
      fallback: result.fallback,
      confidence: result.confidence ?? 0
    }
  }

  async status() {
    return this.client.getStatus()
  }

  async health() {
    try {
      const status = await this.status()
      return {
        healthy: status.gateway === true || status.ollama !== 'offline',
        gateway: status.gateway,
        ollama: status.ollama,
        mode: status.mode
      }
    } catch (error) {
      return {
        healthy: false,
        gateway: false,
        ollama: 'offline' as const,
        mode: 'offline' as const,
        error: String(error)
      }
    }
  }
}

export default ClaudeCodeBridge
