import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import FastifyCors from '@fastify/cors'
import { createTIPClient } from '@llm-gateway/client'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  temperature?: number
  max_tokens?: number
  top_p?: number
  stream?: boolean
}

interface ChatCompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: string
      content: string
    }
    finish_reason: string
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

interface ChatCompletionStreamEvent {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      content?: string
    }
    finish_reason: string | null
  }>
}

export const DEFAULT_PORT = 8788

/** Split completion text into whitespace-preserving chunks for SSE delivery. */
export function chunkText(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? []
}

export class ChatGPTAPIAdapter {
  private fastify = Fastify()
  private client = createTIPClient({
    agentId: process.env.AGENT_ID || 'chatgpt-api-adapter',
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434'
  })

  constructor(private port: number = DEFAULT_PORT) {
    this.setupRoutes()
  }

  private formatMessagesToPrompt(messages: ChatMessage[]): string {
    return messages
      .map(msg => `[${msg.role.toUpperCase()}]\n${msg.content}`)
      .join('\n\n')
  }

  private mapModelName(openaiModel: string): string {
    const modelMap: Record<string, string> = {
      'gpt-4': 'qwen2.5:32b',
      'gpt-4-turbo': 'qwen2.5:32b',
      'gpt-3.5-turbo': 'qwen2.5:14b',
      'gpt-4-mini': 'qwen2.5:3b'
    }
    return modelMap[openaiModel] || 'qwen2.5:14b'
  }

  private setupRoutes() {
    this.fastify.register(FastifyCors, {
      origin: '*',
      credentials: true
    })

    this.fastify.get('/v1/models', async () => {
      return {
        object: 'list',
        data: [
          { id: 'gpt-4', object: 'model', owned_by: 'openai' },
          { id: 'gpt-4-turbo', object: 'model', owned_by: 'openai' },
          { id: 'gpt-3.5-turbo', object: 'model', owned_by: 'openai' },
          { id: 'gpt-4-mini', object: 'model', owned_by: 'openai' }
        ]
      }
    })

    this.fastify.post<{ Body: ChatCompletionRequest }>(
      '/v1/chat/completions',
      async (request, reply) => {
        const {
          messages,
          model,
          temperature = 0.7,
          max_tokens = 2000,
          stream = false
        } = request.body

        const prompt = this.formatMessagesToPrompt(messages)
        const mappedModel = this.mapModelName(model)

        if (stream) {
          // The gateway does not stream through the TIP client yet, so the
          // completion is fetched in full and replayed as SSE chunks.
          reply.hijack()
          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
          })

          const streamId = `chatcmpl-${randomUUID()}`
          const createdAt = Math.floor(Date.now() / 1000)

          try {
            const response = await this.client.completion(prompt, {
              model: mappedModel,
              maxTokens: max_tokens,
              temperature
            })

            for (const chunk of chunkText(response.text)) {
              const event: ChatCompletionStreamEvent = {
                id: streamId,
                object: 'chat.completion.chunk',
                created: createdAt,
                model,
                choices: [
                  {
                    index: 0,
                    delta: { content: chunk },
                    finish_reason: null
                  }
                ]
              }
              reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
            }

            const finalEvent: ChatCompletionStreamEvent = {
              id: streamId,
              object: 'chat.completion.chunk',
              created: createdAt,
              model,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: 'stop'
                }
              ]
            }
            reply.raw.write(`data: ${JSON.stringify(finalEvent)}\n\n`)
            reply.raw.write('data: [DONE]\n\n')
          } catch (error) {
            request.log.error({ err: error }, 'streaming completion failed')
            reply.raw.write(
              `data: ${JSON.stringify({ error: 'Completion failed' })}\n\n`
            )
          } finally {
            reply.raw.end()
          }
        } else {
          try {
            const response = await this.client.completion(prompt, {
              model: mappedModel,
              maxTokens: max_tokens,
              temperature
            })

            const result: ChatCompletionResponse = {
              id: `chatcmpl-${randomUUID()}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model,
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: response.text
                  },
                  finish_reason: 'stop'
                }
              ],
              usage: {
                prompt_tokens: response.tokens.input,
                completion_tokens: response.tokens.output,
                total_tokens: response.tokens.input + response.tokens.output
              }
            }
            return result
          } catch (error) {
            request.log.error({ err: error }, 'completion failed')
            return reply.code(500).send({
              error: {
                message: 'Completion request failed',
                type: 'server_error',
                param: null,
                code: 'internal_error'
              }
            })
          }
        }
      }
    )

    this.fastify.get('/health', async () => {
      const health = await this.client.health()
      return {
        status: health.healthy ? 'ok' : 'degraded',
        gateway: health
      }
    })
  }

  async start() {
    await this.fastify.listen({ port: this.port, host: '0.0.0.0' })
    console.error(`[ChatGPT API] Server listening on port ${this.port}`)
    console.error('[ChatGPT API] OpenAI API compatibility endpoints:')
    console.error('  POST /v1/chat/completions')
    console.error('  GET  /v1/models')
    console.error('  GET  /health')
  }

  async stop() {
    await this.fastify.close()
  }
}

export default ChatGPTAPIAdapter
