#!/usr/bin/env bash
#
# Richtet den Shelly-Monitor vollstaendig ein. Mehrfach ausfuehrbar —
# vorhandene Konfiguration wird nicht ueberschrieben.
#
#   bash install.sh
#
set -euo pipefail

BIN="$HOME/bin"
STATE="$HOME/.shelly-monitor"
AGENTS="$HOME/Library/LaunchAgents"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

say() { printf '\n== %s\n' "$1"; }
warn() { printf '   !! %s\n' "$1"; }

[ "$(uname -s)" = "Darwin" ] || { echo "Nur fuer macOS."; exit 1; }
command -v python3 >/dev/null || { echo "python3 fehlt (xcode-select --install)"; exit 1; }

# --- Messpunkt pruefen ------------------------------------------------------
# Wo der Monitor laeuft, entscheidet ueber die Qualitaet der Messung. Ein
# Laptop im WLAN schlaeft, wechselt Baender und haengt womoeglich an einem
# anderen Repeater als die Geraete — dann melden sich Shellys als vermisst,
# die in Ordnung sind.
say "Messpunkt"
echo "   Rechner: $(hostname)"
IF=$(route -n get default 2>/dev/null | awk '/interface:/{print $2}' || true)
if [ -n "${IF:-}" ] && networksetup -listallhardwareports 2>/dev/null \
     | grep -A2 -i 'Wi-Fi' | grep -q "Device: ${IF}$"; then
  warn "Dieser Rechner haengt per WLAN ($IF) am Netz."
  warn "Der Monitor gehoert auf eine Maschine, die dauerhaft laeuft und"
  warn "moeglichst per Kabel angebunden ist — sonst gibt es Fehlalarme."
else
  echo "   Netzanbindung: ${IF:-unbekannt} (kein WLAN erkannt — gut)"
fi

# --- Werkzeuge --------------------------------------------------------------
say "Werkzeuge nach $BIN"
mkdir -p "$BIN"
for f in "$SRC"/shelly-*.py; do
  install -m 755 "$f" "$BIN/$(basename "$f")"
  echo "   $(basename "$f")"
done

# --- Konfiguration ----------------------------------------------------------
say "Konfiguration"
mkdir -p "$STATE"
if [ -f "$STATE/config.json" ]; then
  echo "   $STATE/config.json bleibt unveraendert."
else
  cat > "$STATE/config.json" <<'JSON'
{
  "password": "",
  "ip_block": [40, 69],
  "sta1": { "ssid": "", "pass": "" },
  "mqtt": { "user": "", "pass": "" }
}
JSON
  chmod 600 "$STATE/config.json"
  echo "   $STATE/config.json angelegt (Rechte 600)."
  warn "Geraete-Passwort dort eintragen — ohne es bleiben Geraete mit"
  warn "aktivierter Authentifizierung fuer Audit und Fix unlesbar."
fi

# --- Hintergrundjobs --------------------------------------------------------
say "Hintergrundjobs"
mkdir -p "$AGENTS"
for label in shelly-monitor shelly-enforce; do
  plist="com.rf.$label.plist"
  [ -f "$SRC/$plist" ] || continue
  target="$AGENTS/$plist"
  sed "s|REPLACE_WITH_PATH|$BIN|" "$SRC/$plist" > "$target"
  launchctl unload "$target" 2>/dev/null || true
  launchctl load "$target"
  echo "   $label geladen"
done
echo "   Monitor: alle 5 Minuten. Haertung: taeglich 4:30."

# --- Erster Lauf ------------------------------------------------------------
say "Erster Scan"
"$BIN/shelly-monitor.py"

say "Fertig"
cat <<'TXT'
   Naechste Schritte:
     1. Geraete-Passwort in ~/.shelly-monitor/config.json eintragen
     2. shelly-audit.py          -- Ursachen und Funkausfall-Risiken
     3. shelly-fix.py --all      -- zeigt, was die taegliche Haertung setzen wird
     4. shelly-monitor.py --history   -- nach ein paar Tagen: das Muster
TXT
