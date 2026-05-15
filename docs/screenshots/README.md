# Screenshots

Drop PNGs here, named exactly as shown below, and the main README will
pick them up automatically. Recommended dimensions: **1600×1000** at 2x
(retina) or 1280×800 at 1x. PNG, < 500 KB each (run through `pngquant`).

## Required captures

| Filename | What to capture | Tab to open |
|---|---|---|
| `01-overview.png` | Hero stats: tokens saved, cost-without-vs-with, buddy, daily activity heatmap, forecast | **01 overview** |
| `02-subscriptions.png` | The auto-gateway banner, both buttons (⚡ discover & connect all and ⟳ spawn missing bridges), all detected subscription cards in a grid | **02 subscriptions** |
| `06-wallet.png` | Subscription-quota wallet showing usage of each subscription this billing period | **06 wallet** |
| `07-memory.png` | Knowledge-graph view of facts the gateway has accumulated per caller | **07 memory** |
| `08-races.png` | Multi-model race results — leaderboard of model speed/quality wins | **08 races** |

## Optional captures (regenerate locally without production data)

| Filename | What to capture |
|---|---|
| `03-api-tab.png` | The four API endpoint cards. **Note:** make sure no production URLs or internal caller names are visible. |
| `04-activity.png` | The live request log table. **Note:** capture against a fresh local DB so caller names are generic. |
| `05-savings.png` | The 5-axis breakdown. **Note:** clear cached caller names before capturing. |
| `09-discover-report.png` | Result of clicking **⚡ discover & connect all** — three-column report card |
| `10-dashboard-dark.png` | Same dashboard with dark-mode toggle (if applicable) |

## How to capture them

1. Run the gateway locally (`docker compose up -d`)
2. Open `http://localhost:0000`
3. Either click each tab manually and `Cmd+Shift+4` (macOS) / `Win+Shift+S` (Windows), or use Playwright:

```bash
npm install -D playwright
npx playwright codegen http://localhost:0000
# … click around, save screenshots
```

A scripted capture flow is in [`scripts/capture-screenshots.mjs`](../../scripts/capture-screenshots.mjs)
(run with `node scripts/capture-screenshots.mjs http://localhost:0000`).

## Hosting

For the public README to show images even in cloned tarballs, commit the
PNGs directly. For the GitHub-rendered page only, you can also paste
images into a release-note draft and use the `user-images.githubusercontent.com`
CDN URL — but that breaks for forks, so we prefer the in-repo copy.
