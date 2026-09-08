# Trip Manager (trips.fichtmueller.org): fehlende Bilder + festhängende Sync-Leiste

Betrifft `rene/eo-global-pulse` auf GitLab — die Trip-Manager-PWA unter
`/planner`, ausgeliefert als `trips.fichtmueller.org`. Analysiert am
08.09.2026 anhand des Screenshots vom 07./08.09., 23:32 Uhr.

Es sind **zwei voneinander unabhängige Ursachen**. Die eine ist ein
Deployment-Unfall und braucht keinen neuen Code, die andere sind echte
Fehler im Service Worker; nur für die liegt hier eine Patch-Serie.

Die Serie liegt in diesem Gateway-Repo, weil der GitLab-Zugang der
erzeugenden Session **read-only** ist (nur Lese-Tools, kein Push). Die
Basisdateien wurden vor dem Patchen per SHA-256 byte-genau gegen GitLab
verifiziert und die Serie mit `git am` auf einem frischen Baseline-Stand
gegengeprüft.

---

## Problem 1 — Die Bilder: der Fix existiert schon, er ist nur nicht mehr deployt

**Das ist kein neuer Bug. Der Fix wurde am 01.09. gebaut, produktiv
verifiziert und ist danach durch ein Deployment von einem anderen Branch
wieder verschwunden.** Deshalb waren die Bilder „schon einmal da".

Der Hergang:

```
b7406992  fix: finish mobile booking dms and announcements      01.09., 11:52
   │
   ├─► codex/trip-images-hotfix-20260901
   │      9c14cfb4  fix(planner): restore destination images    01.09., 21:13  ← der Fix
   │      6aec613d  docs(release): record trip image rollout
   │      8a982f4b  docs(release): confirm current trip images
   │
   └─► codex/mobile-ui-followup-20260901
          2bcfbf30 … dbc40334  (Twenty-/CRM-Arbeit)             02.09., 17:23  ← ohne den Fix
```

Beide Branches zweigen vom selben Commit ab. Der Bildfix liegt
ausschließlich auf `codex/trip-images-hotfix-20260901` und wurde nie in
die Linie gemerged, aus der die späteren Deployments kamen. `main` ist
mit `aac6b8ec` (02.08.) noch weiter zurück und enthält ihn ebenfalls nicht.

Was der verlorene Fix behebt (laut `TASKS.md` des Hotfix-Branches, in
Produktion belegt): Der Client zog Stadtfotos von `source.unsplash.com` —
dieser Dienst ist abgeschaltet und liefert HTTP 503. Der eingebaute
Rückfall auf `picsum.photos` wird von der produktiven CSP blockiert. Also
bleibt genau die graue Fläche übrig, die im Screenshot unter „ITW KENYA"
steht. `9c14cfb4` ersetzt beide Fremdhosts durch die same-origin-Route
`/api/planner/destination-image` (serverseitig aufgelöste Wikimedia-Bilder,
nur `upload.wikimedia.org/wikipedia/commons/`, keine Redirects, 7-s-Timeout,
8-MB-Limit, Signaturprüfung, lokaler SVG-Fallback) und öffnet in
`src/middleware.ts` und `next.config.ts` eine eng gefasste Cache-Ausnahme
für genau diesen einen öffentlichen Endpunkt.

Der Commit bringt 15 Dateien inklusive Tests mit; die Release-Gates waren
laut Protokoll grün (556/556 Tests) und die Route war produktiv verifiziert.

### Lösung: den Commit auf die ausgelieferte Linie holen

Geprüft: zwischen `b7406992` und `dbc40334` wurde **keine** der sieben vom
Hotfix berührten Dateien angefasst (`get_branch_diffs` liefert für diese
Pfade eine leere Diff-Liste). Der Cherry-Pick greift also sauber.

```bash
cd /pfad/zu/eo-global-pulse
git fetch --all --prune

# auf die Linie, aus der deployt wird
git checkout codex/mobile-ui-followup-20260901
git cherry-pick 9c14cfb4908510436c4854a02a27f0a5a61f7b61
```

Alternativ den ganzen Branch mergen, wenn die beiden Doku-Commits
mitsollen:

```bash
git merge --no-ff codex/trip-images-hotfix-20260901
```

Danach bauen und ausrollen wie beim letzten Cutover, und **`main`
nachziehen** — sonst passiert dasselbe beim nächsten Deployment aus einem
anderen Branch noch einmal. Solange `main` auf dem Stand vom 02.08. steht
und produktiv aus wechselnden `codex/*`-Branches deployt wird, ist diese
Art von Rückfall strukturell möglich.

Nach dem Rollout muss die PWA einmal vollständig geschlossen und neu
geöffnet werden — ein laufendes altes JS-Bundle tauscht sich nicht ohne
Navigation aus.

---

## Problem 2 — „31 Änderungen bereit zum Sync" geht nicht weg

Das ist ein echter Fehler und hier gepatcht. Drei Defekte im Service
Worker (`public/sw.js`) greifen ineinander:

1. **Ein einziger Eintrag blockiert die ganze Schlange.** Der Replay-Lauf
   beendet sich beim ersten Eintrag, dessen `fetch` überhaupt wirft
   (`catch { break; }`). Alles dahinter bleibt liegen — dauerhaft, egal wie
   oft „Jetzt synchronisieren" gedrückt wird. Genau das erklärt die
   Beobachtung „geht nicht weg": der Knopf arbeitet, er kommt nur nie an
   den zweiten Eintrag.

2. **Kein Limit für Fehlversuche.** Ein Eintrag, den der Server dauerhaft
   mit 401/408/429/5xx beantwortet, bleibt für immer in der Schlange. Es
   gibt keinen Weg, bei dem der Zähler je auf 0 fällt.

3. **Die Schlange wächst von selbst.** Der Fetch-Handler legt *jede*
   abgebrochene POST/PUT-Anfrage als „ausstehende Änderung" ab. Ein
   React-Unmount, eine Navigation oder — auf dem iPhone besonders häufig —
   das Suspendieren der PWA durch iOS verwerfen laufende Requests, und die
   landen alle im Zähler, obwohl der Nutzer nur normal gearbeitet hat. Das
   erklärt, wie 31 Einträge zusammenkommen.

Dazu zwei kleinere Defekte im selben Pfad, beide im Screenshot sichtbar
bzw. anfassbar:

- **„Aktualisiert —"** steht fest auf dem Platzhalter. Die Leiste liest den
  Header `X-Pulse-Cache-Time`, den im ganzen Repo niemand setzt.
- Der Offline-**„Retry"**-Knopf sendet `REFRESH_CACHE`. Für diese Nachricht
  gibt es im Worker keinen Handler, und `CACHE_REFRESHED` sendet nie
  jemand — der Knopf dreht sich endlos.

### Die Patches

| Patch | Datei | Inhalt |
| --- | --- | --- |
| 0001 | `public/sw.js` | Lauf stoppt nur noch bei echtem Offline-Zustand, sonst läuft er weiter; `QUEUE_MAX_ATTEMPTS = 5` (401 zählt bewusst nicht mit, dort ist Neuanmeldung die Lösung); Abbrüche werden nicht mehr eingereiht, und nur same-origin `/api/`-Mutationen sind replay-fähig; `X-Pulse-Cache-Time` wird gestempelt; `REFRESH_CACHE` bekommt einen Handler; Cache auf `pulse-v20` |
| 0002 | `src/components/offline-status.tsx` | „Jetzt synchronisieren" hängt nicht mehr, wenn es keinen `controller` gibt (Fallback auf den aktiven Worker der Registration, plus 12-s-Watchdog); verworfene Einträge werden nicht mehr als „Sync abgeschlossen" verkauft; kommt ein Lauf nicht durch, sagt die Leiste das und zeigt statt des nackten × ein beschriftetes „Verwerfen" |

Wichtig: Die IndexedDB-Queue wird nicht angefasst. Die bereits
gestrandeten 31 Einträge laufen mit der neuen Logik ab — es braucht keine
Neuinstallation der PWA.

### Anwenden

```bash
cd /pfad/zu/eo-global-pulse
git fetch --all --prune
git checkout -b fix/offline-queue-wedge codex/mobile-ui-followup-20260901
git am /pfad/zu/trips-fixes/patches/*.patch
```

Basis der Serie ist `dbc40334` (`codex/mobile-ui-followup-20260901`).
Greift ein Patch nach weiteren Commits nicht mehr, nutzt `git am -3` die
mitgelieferten Blob-Referenzen für einen 3-Wege-Merge.

---

## Sofort, ohne Deployment

Die Leiste lässt sich schon mit dem laufenden Build loswerden: rechts in
der blauen Leiste, hinter „Jetzt synchronisieren", sitzt ein kleines **×**.
Das leert die Warteschlange nach einer Rückfrage. Es ist als 16-px-Icon
ohne Beschriftung praktisch unsichtbar — genau deshalb wirkt die Leiste
unentfernbar, und genau das ändert Patch 0002.

Zu beachten: Die 31 Einträge sind mit hoher Wahrscheinlichkeit größtenteils
abgebrochene Requests aus Defekt 3 und keine echten ungespeicherten
Änderungen. Sicher ist das ohne Blick in die Queue nicht — wer prüfen will,
was drinsteht, bevor er verwirft, kann sie in den Safari-Entwicklertools
unter IndexedDB → `PulseOffline` → `pulse-offline-queue` einsehen (`path`
und `timestamp` je Eintrag).

---

## Verifiziert (ohne Checkout des Zielprojekts)

- Basisdateien `public/sw.js` (12.488 B) und
  `src/components/offline-status.tsx` (9.382 B) byte-genau gegen GitLab
  `dbc40334` per SHA-256 abgeglichen:
  `b5eeb93f…60fd56` bzw. `14c5813b…f84dda`.
- `node --check public/sw.js` grün.
- `tsc --strict` auf `offline-status.tsx` ohne echte Fehler (nur die
  erwarteten Meldungen für nicht auflösbare Module/React-Typen, da hier
  keine `node_modules` liegen).
- `git am` der Serie auf einem frischen Baseline-Klon: beide Patches
  sauber angewendet, Ergebnisbaum identisch zum Arbeitsstand,
  `git diff --check` sauber.
- Cherry-Pick-Konfliktfreiheit für Problem 1 über
  `get_branch_diffs(b7406992 → dbc40334)` auf den sieben betroffenen
  Pfaden belegt (leere Diff-Liste).

Die vollständige Testsuite, ESLint und der Produktionsbuild des
Zielprojekts wurden **nicht** ausgeführt — dafür fehlt hier der Checkout
mit Abhängigkeiten. Das gehört vor den Rollout.

## Produktionsstand am 08.09.2026 (nachgemessen)

Gegen die Live-Seite geprüft, nachdem gemeldet wurde, dass das Problem
weiterhin besteht:

- `https://trips.fichtmueller.org/sw.js` ist mit
  `b5eeb93f0ff1b8f33e95423c30ad56934736282cd2008f379576b49e1260fd56`
  **byte-identisch zu `dbc40334`**, meldet `pulse-v19` und enthält kein
  `QUEUE_MAX_ATTEMPTS`. Die Patch-Serie aus diesem Verzeichnis ist also
  nicht ausgerollt.
- `GET /api/planner/destination-image?city=Nairobi&country=KE` liefert
  **401** statt eines Bildes. Die Middleware-Ausnahme aus `9c14cfb4` fehlt,
  der Bildfix ist ebenfalls nicht ausgerollt.

Beides zusammen: In Produktion läuft unverändert `dbc40334`. Solange
niemand Cherry-Pick, `git am`, Build und Erik-Cutover ausführt, ändert
sich an beiden Symptomen nichts.

### Nach dem Rollout so verifizieren

```bash
# Bild-Route muss öffentlich ein Bild liefern, nicht 401
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' \
  'https://trips.fichtmueller.org/api/planner/destination-image?city=Nairobi&country=KE'
# erwartet: 200 image/jpeg  (oder image/svg+xml als Fallback)

# Service Worker muss die neue Queue-Logik tragen
curl -s https://trips.fichtmueller.org/sw.js | grep -c QUEUE_MAX_ATTEMPTS
# erwartet: 1   (und pulse-v20 statt pulse-v19)
```

Danach die PWA einmal vollständig schließen und neu öffnen.

## Bewusst nicht enthalten

Der eigentliche Auslöser hinter Problem 1 — dass produktiv aus wechselnden
`codex/*`-Branches deployt wird, während `main` seit dem 02.08. stillsteht —
ist ein Prozessthema und hier nicht gelöst. Solange das so bleibt, kann
jeder bereits behobene Fehler durch das nächste Deployment aus einem
Nachbarbranch zurückkommen.
