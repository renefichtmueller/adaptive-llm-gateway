#!/usr/bin/env python3
"""
shelly-monitor — Inventar, Erreichbarkeits-Check und Alarm fuer Shelly-Geraete.

Kernidee: Geraete werden ueber die MAC gefuehrt, nicht ueber die IP. Ein Shelly,
der per DHCP eine neue IP bekommt, gilt damit nicht als "verschwunden" — nur ein
Geraet, das gar nicht mehr antwortet, loest Alarm aus.

  shelly-monitor.py            einmal pruefen, Inventar aktualisieren, ggf. Alarm
  shelly-monitor.py --status   aktuellen Stand als Tabelle
  shelly-monitor.py --json     Stand als JSON (fuer Dashboards)
  shelly-monitor.py --forget MAC   Geraet dauerhaft aus dem Inventar werfen

Nur Python-Standardbibliothek. Getestet gegen Shelly Gen1/Gen2/Gen3 (/shelly).
"""

import argparse
import json
import os
import re
import socket
import subprocess
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

HOME = os.path.expanduser("~/.shelly-monitor")
INVENTORY = os.path.join(HOME, "inventory.json")
STATUS = os.path.join(HOME, "status.json")
CONFIG = os.path.join(HOME, "config.json")
LOG = os.path.join(HOME, "monitor.log")

PROBE_TIMEOUT = 2.0
WORKERS = 64
# Erst nach so vielen Fehlversuchen in Folge wird Alarm geschlagen. Verhindert,
# dass ein einzelner WLAN-Haenger eine Meldung ausloest.
ALERT_AFTER_MISSES = 3

# Stand des Scans vom 25.08.2026. Diese Geraete werden erwartet, auch wenn sie
# beim ersten Lauf nicht antworten — sonst wuerde ein fehlendes Geraet nie
# auffallen, weil es gar nicht erst ins Inventar kaeme.
SEED = {
    "E465B8FA5AC8": "Fussbodenheizung Kueche",
    "C4D8D542FA6C": "Dachkasten Haus links",
    "FCB467277BA8": "Dachkasten Haus rechts",
    "34B7DACA8F14": "Beleuchtung Haus hinten",
    "E86BEAEBA410": "Treppenhaus oben Licht",
    "8CBFEA96FC40": "(2PM G3, unbenannt)",
    "08927254ABF0": "(Plug MG3, unbenannt)",
    "08927254AE10": "(Plug MG3, unbenannt)",
    "E4B063F1DDDC": "(Outdoor Plug SG3, unbenannt)",
    "08927254CAA8": "(Plug MG3, unbenannt)",
    # Seit dem Scan vom 25.08.2026 vermisst — vermutlich Wohnzimmer Esstisch + Spots.
    "C4D8D54357C0": "VERMISST — vermutlich Wohnzimmer (Esstisch/Spots)",
    "D48AFC59A230": "VERMISST — vermutlich Wohnzimmer (Esstisch/Spots)",
}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def log(msg):
    os.makedirs(HOME, exist_ok=True)
    line = f"{now()}  {msg}"
    with open(LOG, "a") as fh:
        fh.write(line + "\n")
    return line


def load(path, default):
    try:
        with open(path) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def save(path, data):
    os.makedirs(HOME, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


# --- Netz --------------------------------------------------------------------

def local_prefixes():
    """Alle /24-Praefixe, in denen dieser Rechner eine IPv4 hat."""
    cfg = load(CONFIG, {})
    if cfg.get("subnets"):
        return cfg["subnets"]
    out = []
    try:
        raw = subprocess.run(["ifconfig"], capture_output=True, text=True,
                             timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        raw = ""
    for m in re.finditer(r"inet (\d+\.\d+\.\d+)\.(\d+) ", raw):
        pre = m.group(1)
        if pre.startswith(("127.", "169.254.")):
            continue
        if pre not in out:
            out.append(pre)
    return out


def probe(ip):
    """Fragt /shelly ab. Gibt die Geraeteinfo zurueck oder None."""
    try:
        req = urllib.request.Request(f"http://{ip}/shelly",
                                     headers={"Accept": "application/json"})
        # Kein Proxy — Shellys sind immer direkt im LAN erreichbar.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(req, timeout=PROBE_TIMEOUT) as resp:
            data = json.loads(resp.read(8192).decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, ValueError, socket.timeout):
        return None
    mac = data.get("mac")
    if not mac:
        return None
    return {
        "mac": mac.upper(),
        "ip": ip,
        "name": data.get("name"),
        "id": data.get("id"),
        "model": data.get("model") or data.get("type"),
        "gen": data.get("gen", 1),
        "app": data.get("app"),
        "fw": data.get("ver"),
        "auth": bool(data.get("auth_en")),
    }


def sweep():
    """Probt jede Adresse in jedem lokalen /24 direkt per HTTP.

    Bewusst ohne Ping/ARP: Shellys, die ICMP verschlucken oder noch nicht in der
    ARP-Tabelle stehen, wuerden sonst fehlen.
    """
    targets = [f"{p}.{i}" for p in local_prefixes() for i in range(1, 255)]
    found = {}
    if not targets:
        return found
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for dev in pool.map(probe, targets):
            if dev:
                found[dev["mac"]] = dev
    return found


def ap_scan():
    """Shellys im Werks-AP-Modus funken ein eigenes WLAN. Findet sie."""
    try:
        raw = subprocess.run(["system_profiler", "SPAirPortDataType"],
                             capture_output=True, text=True, timeout=45).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return sorted({m.group(0) for m in
                   re.finditer(r"[Ss]helly[A-Za-z0-9-]*", raw)})


def notify(title, message):
    """macOS-Benachrichtigung; zusaetzlich optionaler Webhook aus config.json."""
    try:
        subprocess.run(
            ["osascript", "-e",
             f'display notification {json.dumps(message)} with title {json.dumps(title)}'],
            capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        pass
    url = load(CONFIG, {}).get("webhook")
    if url:
        try:
            body = json.dumps({"title": title, "text": message}).encode()
            req = urllib.request.Request(
                url, data=body, headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=10).close()
        except (urllib.error.URLError, OSError):
            pass


# --- Inventar ----------------------------------------------------------------

def check():
    inv = load(INVENTORY, {})

    # Erstlauf: erwartete Geraete anlegen, damit Fehlende ueberhaupt auffallen.
    for mac, name in SEED.items():
        inv.setdefault(mac, {"name": name, "first_seen": None, "last_seen": None,
                             "misses": 0, "alerted": False})

    seen = sweep()

    for mac, dev in seen.items():
        e = inv.setdefault(mac, {"first_seen": now(), "misses": 0, "alerted": False})
        was_missing = e.get("alerted")
        if dev.get("name"):
            e["name"] = dev["name"]
        elif not e.get("name"):
            e["name"] = f"({dev.get('app') or dev.get('model')}, unbenannt)"
        e.update({"ip": dev["ip"], "model": dev["model"], "gen": dev["gen"],
                  "fw": dev["fw"], "id": dev["id"], "auth": dev["auth"],
                  "last_seen": now(), "misses": 0, "alerted": False})
        e.setdefault("first_seen", now())
        e.pop("missing_since", None)
        if was_missing:
            notify("Shelly wieder da", f"{e['name']} ({dev['ip']}) antwortet wieder")
            log(f"RECOVERED {mac} {e['name']} @ {dev['ip']}")

    gone = []
    for mac, e in inv.items():
        if mac in seen:
            continue
        e["misses"] = e.get("misses", 0) + 1
        e.setdefault("missing_since", now())
        if e["misses"] >= ALERT_AFTER_MISSES and not e.get("alerted"):
            e["alerted"] = True
            gone.append((mac, e))
        if e["misses"] >= ALERT_AFTER_MISSES:
            log(f"MISSING {mac} {e.get('name')} seit {e.get('missing_since')}")

    if gone:
        names = ", ".join(e.get("name") or mac for mac, e in gone)
        notify(f"{len(gone)} Shelly nicht erreichbar", names)
        aps = ap_scan()
        if aps:
            log(f"AP-Modus in Funkreichweite: {', '.join(aps)}")
            notify("Shelly im AP-Modus gefunden",
                   "WLAN-Zugang verloren: " + ", ".join(aps))

    save(INVENTORY, inv)
    save(STATUS, {"checked_at": now(), "online": len(seen),
                  "total": len(inv),
                  "missing": sorted(m for m, e in inv.items()
                                    if e.get("misses", 0) >= ALERT_AFTER_MISSES)})
    return inv


def render(inv):
    rows = sorted(inv.items(),
                  key=lambda kv: (kv[1].get("misses", 0) > 0, kv[1].get("ip") or "zz"))
    print(f"{'STATUS':<9} {'IP':<16} {'MAC':<14} {'NAME'}")
    print("-" * 78)
    for mac, e in rows:
        misses = e.get("misses", 0)
        if misses == 0:
            state = "ONLINE"
        elif misses < ALERT_AFTER_MISSES:
            state = "WACKELT"
        else:
            state = "FEHLT"
        print(f"{state:<9} {(e.get('ip') or '-'):<16} {mac:<14} {e.get('name') or '?'}")
        if state == "FEHLT" and e.get("missing_since"):
            print(f"{'':<9} seit {e['missing_since']}")


def main():
    ap = argparse.ArgumentParser(description="Shelly-Erreichbarkeitsmonitor")
    ap.add_argument("--status", action="store_true", help="nur Inventar anzeigen")
    ap.add_argument("--json", action="store_true", help="Inventar als JSON")
    ap.add_argument("--forget", metavar="MAC", help="Geraet aus dem Inventar loeschen")
    args = ap.parse_args()

    if args.forget:
        inv = load(INVENTORY, {})
        if inv.pop(args.forget.upper().replace(":", ""), None) is None:
            print("Nicht im Inventar.", file=sys.stderr)
            return 1
        save(INVENTORY, inv)
        print("Entfernt.")
        return 0

    inv = load(INVENTORY, {}) if (args.status or args.json) else check()

    if args.json:
        json.dump(inv, sys.stdout, indent=2, ensure_ascii=False)
        print()
    else:
        render(inv)
    return 0


if __name__ == "__main__":
    sys.exit(main())
