import { createTIPClient, type TIPCompletionResult } from '@llm-gateway/client'
import {
  createConnection,
  TextDocuments,
  TextDocumentSyncKind,
  MarkupKind,
  CompletionItemKind,
  type CompletionItem,
  type CompletionParams,
  type DefinitionParams,
  type Hover,
  type HoverParams,
  type InitializeResult,
  type ServerCapabilities,
  type TextDocumentChangeEvent
} from 'vscode-languageserver/node.js'
import { TextDocument } from 'vscode-languageserver-textdocument'

/** Render a TIP completion as an LSP completion item. */
export function toCompletionItem(response: TIPCompletionResult): CompletionItem {
  return {
    label: response.text.split('\n')[0] ?? '',
    kind: CompletionItemKind.Snippet,
    documentation: {
      kind: MarkupKind.Markdown,
      value: `**Model**: ${response.model}\n**Confidence**: ${(response.confidence * 100).toFixed(1)}%`
    },
    insertText: response.text,
    detail: response.fallback ? '(Ollama fallback)' : '(Gateway)'
  }
}

/** Render a TIP completion as LSP hover markdown. */
export function toHoverMarkdown(response: TIPCompletionResult): string {
  return `${response.text}\n\n*${response.model} (${(response.confidence * 100).toFixed(0)}%)*`
}

export class CodexLSPAdapter {
  private connection = createConnection()
  private documents = new TextDocuments(TextDocument)
  private client = createTIPClient({
    agentId: process.env.AGENT_ID || 'codex-lsp-server',
    ollamaUrl: process.env.OLLAMA_URL || 'http://localhost:11434'
  })

  constructor() {
    this.setupHandlers()
  }

  private setupHandlers() {
    this.connection.onInitialize(this.handleInitialize.bind(this))
    this.connection.onCompletion(this.handleCompletion.bind(this))
    this.connection.onHover(this.handleHover.bind(this))
    this.connection.onDefinition(this.handleDefinition.bind(this))
    this.documents.onDidChangeContent(this.handleDocumentChange.bind(this))
    this.documents.listen(this.connection)
  }

  private handleInitialize(): InitializeResult {
    const capabilities: ServerCapabilities = {
      textDocumentSync: TextDocumentSyncKind.Full,
      completionProvider: {
        resolveProvider: true,
        triggerCharacters: ['.', ' ', '(']
      },
      hoverProvider: true,
      definitionProvider: true,
      codeActionProvider: true,
      executeCommandProvider: {
        commands: ['codex.explain', 'codex.refactor', 'codex.test', 'codex.fix']
      }
    }

    return { capabilities }
  }

  private async handleCompletion(params: CompletionParams): Promise<CompletionItem[]> {
    const doc = this.documents.get(params.textDocument.uri)
    if (!doc) return []

    try {
      const response = await this.client.completion(
        `Complete the following code:\n\n${doc.getText()}\n\n[cursor here]`,
        { maxTokens: 500 }
      )

      return [toCompletionItem(response)]
    } catch {
      return []
    }
  }

  private async handleHover(params: HoverParams): Promise<Hover | null> {
    const doc = this.documents.get(params.textDocument.uri)
    if (!doc) return null

    const selectedText = doc.getText({
      start: { line: params.position.line, character: 0 },
      end: { line: params.position.line + 1, character: 0 }
    })

    try {
      const response = await this.client.completion(
        `Briefly explain this code:\n${selectedText}`,
        { maxTokens: 200 }
      )

      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: toHoverMarkdown(response)
        }
      }
    } catch {
      return null
    }
  }

  private async handleDefinition(_params: DefinitionParams): Promise<null> {
    // Definition lookup would need symbol indexing — not implemented yet.
    return null
  }

  private handleDocumentChange(_change: TextDocumentChangeEvent<TextDocument>): void {
    // Diagnostics on significant changes could be added here.
  }

  start() {
    this.connection.listen()
  }
}

export default CodexLSPAdapter
