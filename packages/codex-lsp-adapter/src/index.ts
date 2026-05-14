import { createTIPClient } from '@llm-gateway/client'
import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  InitializeResult,
  ServerCapabilities,
  Position,
  Range,
  CompletionItem,
  CompletionItemKind,
  MarkupKind
} from 'vscode-languageserver'
import { TextDocument } from 'vscode-languageserver-textdocument'

export class CodexLSPAdapter {
  private connection = createConnection()
  private documents = new TextDocuments(TextDocument)
  private client = createTIPClient({
    agentId: 'codex-lsp-server',
    ollamaUrl: process.env.OLLAMA_URL || 'localhost:11434'
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

  private handleInitialize() {
    const capabilities: ServerCapabilities = {
      textDocumentSync: 1,
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

    const result: InitializeResult = { capabilities }
    return result
  }

  private async handleCompletion(params: any) {
    const doc = this.documents.get(params.textDocument.uri)
    if (!doc) return []

    const position = params.position
    const text = doc.getText()
    const offset = doc.offsetAt(position)

    try {
      const response = await this.client.completion(
        `Complete the following code:\n\n${text}\n\n[cursor here]`,
        { maxTokens: 500 }
      )

      return [
        {
          label: response.text.split('\n')[0],
          kind: CompletionItemKind.Snippet,
          documentation: {
            kind: MarkupKind.Markdown,
            value: `**Model**: ${response.model}\n**Confidence**: ${(response.confidence * 100).toFixed(1)}%`
          },
          insertText: response.text,
          detail: response.fallback ? '(Ollama fallback)' : '(Gateway)'
        } as CompletionItem
      ]
    } catch (error) {
      return []
    }
  }

  private async handleHover(params: any) {
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
          value: `${response.text}\n\n*${response.model} (${(response.confidence * 100).toFixed(0)}%)*`
        }
      }
    } catch (error) {
      return null
    }
  }

  private async handleDefinition(params: any) {
    // Definition lookup would be more complex in real implementation
    // For now, return null - could integrate with symbol indexing
    return null
  }

  private async handleDocumentChange(change: any) {
    const doc = change.document
    // Could perform diagnostics here on significant changes
  }

  start() {
    this.connection.listen()
  }
}

export default CodexLSPAdapter
