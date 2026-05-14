---
name: Bug report
about: Something isn't working
title: '[bug] '
labels: bug
---

**What happened?**


**What did you expect?**


**Reproducer**
```bash
# minimal curl or code that triggers it
```

**Environment**
- Gateway version (`git rev-parse HEAD` or release tag):
- Node version (`node -v`):
- Postgres version:
- OS / arch:
- Active providers (output of `GET /api/dashboard/discover`):

**Relevant logs**
```
# `pm2 logs llm-gateway --lines 50` or equivalent
```

**`llm_calls` row (if applicable, redact prompts if sensitive)**
```
# psql output
```
