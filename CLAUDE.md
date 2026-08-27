# CLAUDE.md

Projekt-Konventionen für Claude-Sessions in diesem Repository.

## Arbeitskonventionen (Rene)

- **"Bitte aufs Paper pro"** bedeutet: Das Dokument als PDF im 4:3-Format
  (594×792 pt hoch bzw. 792×594 pt quer — reMarkable Paper Pro) erzeugen und
  in **Dropbox** unter `Laufende Projekte/Paper pro/` ablegen. Rene importiert
  es von dort über die Dropbox-Integration des reMarkable. Existiert der
  Ordner noch nicht, anlegen. Ist der Dropbox-Connector in der Session nicht
  verfügbar, die Datei zusätzlich im Chat übergeben und darauf hinweisen.
- PDFs für das Paper Pro: Vektor statt Raster, kräftige Kontraste (E-Ink),
  Basisschriften oder eingebettete Subsets.

## Infrastruktur-Doku

- Betriebs-Doku zum Server "Beo" liegt unter `docs/infrastructure/`.
- Dieses Repo ist öffentlich: konkrete Domains und Ports werden dort nur als
  Platzhalter dokumentiert (`<basisdomain>`, `<PORT>`); echte Werte gehören in
  die private `.env` bzw. Proxy-Konfiguration (analog `.env.example` — auch
  bestehende Dateien scrubben Ports zu `0000`).
