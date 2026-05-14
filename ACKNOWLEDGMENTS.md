# Acknowledgments

> _"If I have seen further, it is by standing on the shoulders of giants."_

The Adaptive LLM Gateway exists because several smart people put their ideas
into open source first. Most of the unique-USP features in this repo are
original work, but the **conceptual frame** for several of them was set by
prior projects we want to credit explicitly.

## Token compression — `lean-ctx` and `rtk`

The idea that you can shrink an LLM prompt **before** it leaves your machine
— without losing meaning, by detecting repetition, boilerplate, ANSI noise,
or low-signal padding — was crystallised by two parallel projects in the
Claude Code community:

### lean-ctx ([github.com/yvgude/lean-ctx](https://github.com/yvgude/lean-ctx))
- **Author**: [Yves Gugger](https://github.com/yvgude)
- **License**: MIT
- **What it did first**: A CLI-side proxy that intercepted Claude Code
  invocations, ran a lightweight file-context compression pass over the
  attached project context, and forwarded a smaller payload upstream.
  Yves made the case publicly that even modest, deterministic compression
  could cut a multi-thousand-token context window by 30–60 % for typical
  developer workflows, with no semantic loss.

### rtk — Rust Token Killer ([github.com/rtk-ai/rtk](https://github.com/rtk-ai/rtk))
- **Author**: [Patrick Szymkowiak](https://github.com/rtk-ai)
- **License**: MIT
- **What it did first**: A high-performance Rust CLI proxy that sat in front
  of LLM calls and applied in-stream token reduction across multiple
  strategies — signature mapping, code-block trimming, comment elision.
  Patrick demonstrated that the right compression strategy depends heavily
  on the content type (code vs prose vs JSON) and that selecting between
  strategies dynamically can outperform a single fixed approach.

### Our compressor
`packages/gateway/src/modules/context-compressor.ts` is a **530-line,
independent TypeScript implementation** written specifically for the
gateway use case (request-time, multi-strategy, caller-attribution,
five-axis savings tracking). It does not contain code from either of the
above projects. The architecture decisions — four strategies (`verbatim_compact`
/ `budgeted_high_signal` / `aggressive_code` / `signature_map`), token-budget
heuristics, the "safeguard: inflation-rejected" failsafe — are inspired by
the ideas Yves and Patrick demonstrated, then re-derived for our request
shape.

If you're using this gateway, please consider also starring and following
their original projects.

## Prompt-injection defense

The 20+ patterns in `injection-defense.ts` are original to this repo, but
the attack-family taxonomy follows the public consensus that has emerged
around **OWASP LLM-01: Prompt Injection** ([owasp.org/www-project-top-10-for-large-language-model-applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/)).
Academic prior art that shaped our thinking:

- Greshake, K. et al. (2023) — _Not What You've Signed Up For: Compromising
  Real-World LLM-Integrated Applications with Indirect Prompt Injection_
- Yi, J. et al. (2023) — _Benchmarking and Defending Against Indirect Prompt
  Injection Attacks on Large Language Models_

## PII redaction

The Luhn algorithm (for credit-card validation) and the IBAN mod-97 check
are standard publicly-documented algorithms. The pattern set in
`pii-redaction.ts` is original to this repo.

## MCP server mode

Implements a subset of the [Model Context Protocol](https://modelcontextprotocol.io)
specification published by Anthropic. The protocol is open and unencumbered.

## Subscription bridge tooling

The CLI subscription bridges are thin wrappers around the official tools
each provider ships:

| Bridge | Wraps |
|---|---|
| `claude-code-bridge` | The `claude` CLI shipped by Anthropic with Claude Code Max |
| `openai-bridge` | The OpenAI / ChatGPT CLI session |
| `copilot-bridge` | [`github/copilot-api`](https://github.com/ericc-ch/copilot-api) by Eric Riggers — MIT |
| `codex-lsp-adapter` | OpenAI's Codex CLI |
| `m365-copilot-bridge` | Microsoft Graph + Copilot endpoints |

The bridges contain only the local HTTP-wrapping glue; the underlying
provider tools and their respective licenses, terms of service, and rate
limits apply when you route through them.

## Inspiration from the broader LLM-gateway ecosystem

We learned what _to_ build by studying what others built:

- [**LiteLLM**](https://github.com/BerriAI/litellm) — set the bar for
  multi-provider routing breadth
- [**Portkey AI Gateway**](https://github.com/Portkey-AI/gateway) — showed
  how a routing-config-as-data approach scales for enterprises
- [**OneAPI**](https://github.com/songquanpeng/one-api) — demonstrated the
  power of bundling user-management with the gateway

We learned what _not_ to build by realising none of them addresses
flat-rate subscriptions — which is our entire wedge.

## Inspiration on the dashboard side

The "gamified savings tracker" with buddy / XP / achievements is inspired by
how productivity tools like [WakaTime](https://wakatime.com) and language-
learning apps like [Duolingo](https://www.duolingo.com) make boring
operational metrics fun to look at. None of their code or assets are used.

## And to everyone who filed an issue, a PR, or a question

Once we're public, this section will grow. Thank you in advance.
