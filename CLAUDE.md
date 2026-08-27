# CLAUDE.md

Projekt-Konventionen für Claude-Sessions in diesem Repository.

## Arbeitskonventionen (Rene)

- Der Dropbox-Ordner **"Paper Pro"** (oberste Ebene im Dropbox-Root, NICHT
  unter Laufende Projekte) ist die zentrale Ablage fürs reMarkable Paper Pro:
  Dort können auf Zuruf **alle** Arten von Dokumenten abgelegt werden — immer
  dann, wenn Rene es sagt (z. B. **"bitte aufs Paper pro"**). Rene importiert
  von dort über die Dropbox-Integration des reMarkable.
- Struktur (Stand 2026-08-27, per `list_folder` verifiziert):
  `/Paper Pro/Laufende Projekte/` — laufende Projektdokumente (z. B. die
  Beo-Infrastruktur-PDFs) — und `/Paper Pro/Daily Journal/`. Neue
  projektbezogene Dokumente gehören nach `/Paper Pro/Laufende Projekte/`.
- Vorgehen: Dokument als PDF im 4:3-Format erzeugen (594×792 pt hoch bzw.
  792×594 pt quer), den bestehenden Ordner per Suche/Listing finden (nicht
  blind neu anlegen; nur erstellen, falls wirklich nicht vorhanden — andere
  Claude-Sessions legen parallel in denselben Ordner ab, vor dem Anlegen
  daher immer erst listen/suchen) und die Datei dort ablegen. Ist der
  Dropbox-Connector in der Session nicht verfügbar, die Datei zusätzlich im
  Chat übergeben und darauf hinweisen.
- PDFs für das Paper Pro: Vektor statt Raster, kräftige Kontraste (E-Ink),
  Basisschriften oder eingebettete Subsets.

## Infrastruktur-Doku

- Betriebs-Doku zum Server "Beo" liegt unter `docs/infrastructure/`.
- Dieses Repo ist öffentlich: konkrete Domains und Ports werden dort nur als
  Platzhalter dokumentiert (`<basisdomain>`, `<PORT>`); echte Werte gehören in
  die private `.env` bzw. Proxy-Konfiguration (analog `.env.example` — auch
  bestehende Dateien scrubben Ports zu `0000`).
