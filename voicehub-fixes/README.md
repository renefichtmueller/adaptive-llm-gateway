# VoiceHub: Fixes für den Sperr-Vorfall vom 25.08

Git-Patch-Serie für `companyos/voicehub` (GitLab), erzeugt am 27.08.2026
gegen `main @ d9774492` (Stand 23.08). Sie liegt hier im Gateway-Repo, weil
der GitLab-Zugang der erzeugenden Session read-only war. Die Serie wurde
maschinell von Claude erzeugt; Basis-Dateien wurden vor dem Patchen per
SHA-256 byte-genau gegen GitLab verifiziert, und die Serie wurde mit
`git am` auf einem frischen Baseline-Stand gegengeprüft.

## Anwenden

```bash
cd /pfad/zu/voicehub          # Checkout von companyos/voicehub
git fetch --all --prune
git checkout -b fix/lock-screen-recording origin/main
git am /pfad/zu/voicehub-fixes/patches/*.patch
```

Falls `main` inzwischen weitergewandert ist und ein Patch nicht greift:
`git am -3` nutzt die mitgelieferten Blob-Referenzen für einen 3-Wege-Merge.

## Inhalt (10 Patches)

1. **fix(pwa)** `meeting-recorder.js`: `stop()` liefert auch bei einem von
   iOS still beendeten Recorder die gesammelten Chunks aus (der 25.08-
   Totalverlust); Mikrofon-Track-Events (`mute`/`ended`) und
   MediaRecorder-Fehler werden gemeldet; `micLive`/`hasAudio`-Getter.
2. **feat(pwa)** `app.js`: Screen Wake Lock am Zustands-Lebenszyklus
   (verhindert den Auto-Lock während Aufnahme/Pause/Upload),
   Unterbrechungs-Erkennung mit fail-closed Server-Pause
   (`audio_interrupted` – freier String, kein Server-Patch nötig),
   ehrliche Resume-Blockade bei totem Mikrofon, iOS-Hinweis beim Start.
3. **feat(pwa)** `chunk-vault.js` (neu) + `app.js` + `index.html`: Jeder
   2-s-Chunk wird sofort in IndexedDB persistiert; beim Start bietet ein
   Banner unterbrochene Aufnahmen zur Verarbeitung an (stoppt bei Bedarf
   die Server-Capture; ohne Meeting läuft der Upload ohne `meeting_id`).
4. **chore(pwa)**: Shell-Version v26 (URLs + Cache-Name, Muster vom
   23.08), `chunk-vault.js` in Shell-Cache und Update-Pfad.
5. **fix(ios)**: `UIBackgroundModes: audio` (Aufnahme übersteht die
   Sperre), AVAudioSession-Interruption-/Route-/Reset-Handling, Ablage in
   `Documents/Aufnahmen`, Datei wird erst nach erfolgreicher Verarbeitung
   gelöscht, Upload aus Datei statt komplett im RAM.
6. **feat(pi)**: `scripts/pi-jabra/voicehub-jabra.sh` + systemd-Units
   (`voicehub-pi-recorder.service`, `voicehub-pi-uploader.{service,timer}`)
   – Jabra-Aufnahme in eine retry-sichere Upload-Warteschlange statt
   manueller `arecord`/`curl`-Kette (Issue #4 Thin-Client-Gate).
7. **docs**: `project-log.md`-Eintrag zum Vorfall und zur Serie.
8. **fix(pwa)** Diktat-Rettung: Reißt die WebSocket-Verbindung mitten im
   Live-Diktat ab (passiert real beim 4-h-Session-Ablauf, der auch laufende
   WebSockets trennt), wandert der bisher erkannte Text in den
   Review-Zustand statt zu verfallen; dazu neuer „Text kopieren“-Button,
   der auch ohne erreichbaren Server funktioniert.
9. **docs** `docs/roadmap-2026-h2.md`: Beschluss vom 27.08 – alle 15
   Marktradar-Punkte (inkl. Bot-Pfad) in vier Releases, unter dem
   UX-Grundgesetz „autodidaktisch für Engineering, Buchhaltung und HR“.

## Verifiziert (ohne Gerät)

`node --check` für `app.js`, `meeting-recorder.js`, `chunk-vault.js`,
`sw.js`; `bash -n` für das Pi-Skript; YAML-/plist-/systemd-Parse-Checks;
`git diff --check` sauber.

## Nach dem Merge

- **Erik**: statische Dateien deployen (Shell v26 zieht dank
  `Cache-Control`-Regeln vom 23.08 sofort); kein Backend-Neustart nötig –
  die Serie ändert keinen Python-Code.
- **iOS**: `xcodegen` ausführen, bauen, auf dem iPhone testen –
  insbesondere die Sperr-Matrix aus Issue #9 (30 min gesperrt aufnehmen,
  Anruf, Force-Quit).
- **Pi**: Installation gemäß `scripts/pi-jabra/README.md`.

## Bewusst nicht enthalten

Login der nativen App (OIDC-Handoff), Meeting-Gate-Parität der App,
TestFlight – das ist der größere Umbau aus dem Konzept „VoiceHub Native“
(27.08) und braucht eigene Slices inkl. Server-Endpunkten.

**Patch 0010 – docs:** `docs/slices/r1-implementation-specs.md` – die sechs
R1-Slices als implementierungsfertige Spezifikationen (Scope, API-Vertrag,
UX-Akzeptanz, Schließbeweis), damit die Umsetzung im echten Checkout ohne
Klärungsrunde starten kann.
