# Acknowledgments

The Adaptive LLM Gateway's token-compression approach was inspired by the
broader open-source effort to make LLM API calls cheaper:

- **lean-ctx** (MIT, © Yves Gugger) — https://github.com/yvgude/lean-ctx
  · pioneered the "shrink context before sending to LLM" pattern in the
    Claude Code community

- **rtk** / Rust Token Killer (MIT, © Patrick Szymkowiak) — https://github.com/rtk-ai/rtk
  · CLI proxy approach for in-stream token reduction

None of their source code is included in this repository. The compressor in
`packages/gateway/src/modules/context-compressor.ts` is an independent
TypeScript implementation written for the gateway's caller-attribution +
multi-axis savings tracking use case.

## Subscription bridge tooling

The CLI subscription bridges are thin wrappers around the official tools each
provider ships:

- `claude-code-bridge` calls the `claude` CLI shipped by Anthropic with Claude Code Max
- `openai-bridge` proxies the official OpenAI / ChatGPT CLI session
- `copilot-bridge` wraps github/copilot-api by Eric Riggers
- `codex-lsp-adapter` integrates with OpenAI's Codex CLI
- `m365-copilot-bridge` uses the Microsoft Graph + Copilot endpoints

Their respective licenses and conditions apply when you use them through the
gateway.
