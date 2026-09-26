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
import time
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
# Nachfassen fuer Geraete, die der schnelle Durchgang verpasst hat.
VERIFY_TIMEOUT = 6.0
VERIFY_ATTEMPTS = 3
RETRY_PAUSE = 1.0
# Erst nach so vielen Fehlversuchen in Folge wird Alarm geschlagen. Verhindert,
# dass ein einzelner WLAN-Haenger eine Meldung ausloest.
ALERT_AFTER_MISSES = 3

# Stand des Scans vom 17.09.2026. Diese Geraete werden erwartet, auch wenn sie
# beim ersten Lauf nicht antworten — sonst wuerde ein fehlendes Geraet nie
# auffallen, weil es gar nicht erst ins Inventar kaeme.
SEED = {
    "D48AFC59A230": "Esstisch Lampe",
    "E465B8FA5AC8": "Fussbodenheizung Kueche",
    "C4D8D542FA6C": "Dachkasten Haus links",
    "C4D8D54357C0": "Spots Sitzecke",
    "FCB467277BA8": "Dachkasten Haus rechts",
    "34B7DACA8F14": "Beleuchtung Haus hinten",
    "A0A3B34EEB2C": "Brunnenpumpe",
    "E86BEAEBA410": "Treppenhaus oben Licht",
    "8CBFEA96FC40": "(2PM G3, unbenannt)",
    "08927254ABF0": "(Plug MG3, unbenannt)",
    "08927254AE10": "(Plug MG3, unbenannt)",
    "08927254AC68": "(Plug MG3, unbenannt)",
    "E4B063F1DDDC": "(Outdoor Plug SG3, unbenannt)",
    "B0B21CFABD80": "(BluGw, unbenannt)",
    "08927254CAA8": "(Plug MG3, unbenannt)",
}

# Alle Shellys sollen in einem zusammenhaengenden Adressblock liegen. Geraete
# ausserhalb werden markiert, damit Streuung sichtbar bleibt statt einzureissen.
IP_BLOCK = (40, 69)

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


def probe(ip, timeout=PROBE_TIMEOUT, attempts=1):
    """Fragt /shelly ab. Gibt die Geraeteinfo zurueck oder None.

    Ein Shelly auf schwachem Signal antwortet nicht immer beim ersten Versuch.
    Ein einzelner Aussetzer darf nicht als Ausfall durchgehen, deshalb laesst
    sich hier mehrfach fragen.
    """
    data = None
    for n in range(attempts):
        try:
            req = urllib.request.Request(f"http://{ip}/shelly",
                                         headers={"Accept": "application/json"})
            # Kein Proxy — Shellys sind immer direkt im LAN erreichbar.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(req, timeout=timeout) as resp:
                data = json.loads(resp.read(8192).decode("utf-8", "replace"))
            break
        except (urllib.error.URLError, OSError, ValueError, socket.timeout):
            if n + 1 < attempts:
                time.sleep(RETRY_PAUSE)
    if data is None:
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


def verify_missing(inv, found):
    """Zweiter Durchgang, nur fuer Geraete, die der schnelle Sweep nicht sah.

    Laengeres Timeout, mehrere Versuche, gezielt auf die letzte bekannte
    Adresse. Das trennt ein wirklich abwesendes Geraet von einem, das beim
    ersten Anlauf nur zu langsam war — der haeufigste Grund fuer Fehlalarme,
    wenn vom WLAN aus gescannt wird.
    """
    candidates = [(mac, e.get("ip")) for mac, e in inv.items()
                  if mac not in found and e.get("ip")]
    if not candidates:
        return 0
    recovered = 0
    with ThreadPoolExecutor(max_workers=min(WORKERS, 16)) as pool:
        results = pool.map(
            lambda c: (c[0], probe(c[1], VERIFY_TIMEOUT, VERIFY_ATTEMPTS)),
            candidates)
        for mac, dev in results:
            if dev and dev["mac"] == mac:
                found[mac] = dev
                recovered += 1
    if recovered:
        log(f"VERIFY {recovered} Geraet(e) erst im zweiten, geduldigeren "
            f"Durchgang erreicht — Signal oder Netzweg ist grenzwertig")
    return recovered


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
    first_run = not os.path.exists(INVENTORY)
    inv = load(INVENTORY, {})
    known = set(inv)

    # Erstlauf: erwartete Geraete anlegen, damit Fehlende ueberhaupt auffallen.
    for mac, name in SEED.items():
        inv.setdefault(mac, {"name": name, "first_seen": None, "last_seen": None,
                             "misses": 0, "alerted": False})

    seen = sweep()
    slow = verify_missing(inv, seen)

    for mac, dev in seen.items():
        e = inv.setdefault(mac, {"first_seen": now(), "misses": 0, "alerted": False})
        was_missing = e.get("alerted")
        if dev.get("name"):
            e["name"] = dev["name"]
        elif not e.get("name"):
            e["name"] = f"({dev.get('app') or dev.get('model')}, unbenannt)"
        e.update({"ip": dev["ip"], "model": dev["model"], "gen": dev["gen"],
                  "seen_from": socket.gethostname(),
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

    # Ein neu aufgetauchter Shelly soll auffallen: er braucht einen Namen und
    # eine feste Adresse, sonst faengt das Raetselraten von vorn an.
    fresh = [(m, d) for m, d in seen.items() if m not in known and not first_run]
    if fresh:
        names = ", ".join(
            f"{inv[m].get('name') or m} ({d['ip']})" for m, d in fresh)
        notify(f"{len(fresh)} neuer Shelly im Netz", names)
        log(f"NEW {names}")

    if gone:
        names = ", ".join(e.get("name") or mac for mac, e in gone)
        notify(f"{len(gone)} Shelly nicht erreichbar", names)
        aps = ap_scan()
        if aps:
            log(f"AP-Modus in Funkreichweite: {', '.join(aps)}")
            notify("Shelly im AP-Modus gefunden",
                   "WLAN-Zugang verloren: " + ", ".join(aps))

    save(INVENTORY, inv)
    save(STATUS, {"checked_at": now(), "scanned_from": socket.gethostname(),
                  "slow_responders": slow, "online": len(seen),
                  "total": len(inv),
                  "missing": sorted(m for m, e in inv.items()
                                    if e.get("misses", 0) >= ALERT_AFTER_MISSES),
                  "outside_block": sorted(m for m, e in inv.items()
                                          if outside_block(e.get("ip")))})
    return inv


def ip_block():
    lo, hi = load(CONFIG, {}).get("ip_block", IP_BLOCK)
    return int(lo), int(hi)


def outside_block(ip):
    """True, wenn die Adresse nicht im vorgesehenen Shelly-Block liegt."""
    if not ip:
        return False
    lo, hi = ip_block()
    try:
        return not (lo <= int(ip.rsplit(".", 1)[1]) <= hi)
    except (ValueError, IndexError):
        return False


def render(inv):
    rows = sorted(inv.items(),
                  key=lambda kv: (kv[1].get("misses", 0) > 0, kv[1].get("ip") or "zz"))
    lo, hi = ip_block()
    print(f"Shelly-Block: 192.168.x.{lo}-{hi}")
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
        flag = "  <- ausserhalb des Shelly-Blocks" if outside_block(e.get("ip")) else ""
        print(f"{state:<9} {(e.get('ip') or '-'):<16} {mac:<14} {e.get('name') or '?'}{flag}")
        if state == "FEHLT" and e.get("missing_since"):
            print(f"{'':<9} seit {e['missing_since']}")


def history():
    """Fasst monitor.log zusammen: wer faellt aus, wie oft, zu welcher Stunde.

    Ein Muster sagt mehr als ein Einzelfall. Immer dasselbe Geraet deutet auf
    Funk oder Stromversorgung dort; alle gleichzeitig auf Router, DHCP oder das
    Netz des scannenden Rechners; immer zur selben Stunde auf etwas
    Zeitgesteuertes wie eine WLAN-Nachtschaltung oder einen Lease-Wechsel.
    """
    if not os.path.exists(LOG):
        print("Noch kein Log — der Monitor lief noch nicht.")
        return 0
    per_device, per_hour, slow = {}, {}, 0
    for line in open(LOG):
        parts = line.split()
        if len(parts) < 3:
            continue
        stamp, kind = parts[0], parts[1]
        if kind == "VERIFY":
            slow += 1
            continue
        if kind not in ("MISSING", "RECOVERED"):
            continue
        mac = parts[2]
        name = " ".join(parts[3:]).split(" seit ")[0] or mac
        d = per_device.setdefault(mac, {"name": name, "MISSING": 0, "RECOVERED": 0})
        d[kind] += 1
        if kind == "MISSING":
            hour = stamp[11:13]
            per_hour[hour] = per_hour.get(hour, 0) + 1

    if not per_device:
        print("Keine Ausfaelle im Log.")
    else:
        print("Ausfaelle je Geraet (Meldungen, nicht Einzelminuten):")
        for mac, d in sorted(per_device.items(),
                             key=lambda kv: -kv[1]["MISSING"]):
            print(f"  {d['MISSING']:>4}x weg, {d['RECOVERED']:>3}x zurueck   "
                  f"{mac}  {d['name']}")
        if per_hour:
            print("\nVerteilung ueber den Tag (UTC):")
            peak = max(per_hour.values())
            for h in sorted(per_hour):
                bar = "#" * max(1, round(per_hour[h] * 30 / peak))
                print(f"  {h}:00  {bar} {per_hour[h]}")
    if slow:
        print(f"\n{slow}x antwortete ein Geraet erst im geduldigeren zweiten "
              f"Durchgang — Signal oder Netzweg ist dort grenzwertig.")
    return 0


def main():
    ap = argparse.ArgumentParser(description="Shelly-Erreichbarkeitsmonitor")
    ap.add_argument("--status", action="store_true", help="nur Inventar anzeigen")
    ap.add_argument("--json", action="store_true", help="Inventar als JSON")
    ap.add_argument("--history", action="store_true",
                    help="Muster der Ausfaelle aus dem Log")
    ap.add_argument("--forget", metavar="MAC", help="Geraet aus dem Inventar loeschen")
    args = ap.parse_args()

    if args.history:
        return history()

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
