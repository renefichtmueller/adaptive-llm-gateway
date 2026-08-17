# Security skills (curated)

23 of 817 skills from [mukul975/Anthropic-Cybersecurity-Skills](https://github.com/mukul975/Anthropic-Cybersecurity-Skills)
(commit `4c0b700ac5d280ba46695062077f0fe922ce3602`), selected for relevance to this
gateway's own threat model (`SECURITY.md`) and to the Magatama dashboard's 9-pillar
taxonomy. Community project, not affiliated with Anthropic PBC. Apache-2.0 —
see `LICENSE-anthropic-cybersecurity-skills`; files are unmodified copies from upstream.

Full library has 817 skills across 29 domains, most unrelated to this project
(AD forensics, ICS/SCADA, mobile, memory forensics, etc.) — deliberately not imported.

## Mapping to Magatama pillars

| Pillar | Skills here |
|---|---|
| mind (ShieldX / AI-LLM security) | detecting-indirect-prompt-injection, testing-for-system-prompt-leakage, auditing-mcp-servers-for-tool-poisoning, securing-agentic-ai-tool-invocation, red-teaming-llms-with-garak, defending-llms-with-guardrails |
| guard (Enforcement Hub) | building-incident-response-playbook, building-soc-escalation-matrix |
| strike (Self Pentest Center) | conducting-internal-network-penetration-test, executing-red-team-exercise |
| comply (compliance frameworks) | conducting-cyber-risk-assessment-with-nist-800-30, executing-nist-rmf-authorization-to-operate, implementing-hipaa-security-rule-safeguards |
| den (Cowrie honeypot) | implementing-network-deception-with-honeypots, deploying-honeytokens-and-canarytokens |
| recon (Security Atlas) | implementing-attack-surface-management, performing-subdomain-enumeration-with-subfinder |
| cloud | auditing-cloud-with-cis-benchmarks |
| code (supply chain / DevSecOps) | generating-and-analyzing-sboms, detecting-dependency-confusion, performing-container-security-scanning-with-trivy |
| web | integrating-dast-with-owasp-zap-in-pipeline, testing-api-security-with-owasp-top-10 |

`cloud` only has one entry because the actual cloud/hosting provider wasn't confirmed
(repo list suggests Proxmox/self-hosted rather than AWS/Azure/GCP) — add
provider-specific skills from the upstream repo once that's known.
