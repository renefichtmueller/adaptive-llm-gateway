#!/usr/bin/env python3
"""
shelly-audit — liest die WLAN- und Netzkonfiguration aller Shellys aus und
benennt die Schwachstellen, die zu Ausfaellen fuehren.

Rein lesend. Aendert nichts.

Geprueft wird pro Geraet:
  * Signalstaerke (RSSI)     -- unter -75 dBm reisst die Verbindung regelmaessig ab
  * IPv4-Modus               -- DHCP ohne feste Reservierung = wandernde IP
  * Fallback-WLAN (sta1)     -- zweites Netz, falls das erste weg ist
  * Geraetename              -- ohne Namen ist ein Ausfall nicht zuzuordnen

Passwort fuer Geraete mit aktivierter Authentifizierung:
  ~/.shelly-monitor/config.json  ->  {"password": "..."}
"""

import json
import os
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

HOME = os.path.expanduser("~/.shelly-monitor")
INVENTORY = os.path.join(HOME, "inventory.json")
CONFIG = os.path.join(HOME, "config.json")
TIMEOUT = 4.0
RSSI_WEAK = -75


def opener_for(ip, password):
    """Gen2+ nutzt Digest-Auth mit dem Benutzer 'admin'."""
    handlers = [urllib.request.ProxyHandler({})]
    if password:
        mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
        mgr.add_password(None, f"http://{ip}/", "admin", password)
        handlers.append(urllib.request.HTTPDigestAuthHandler(mgr))
    return urllib.request.build_opener(*handlers)


def rpc(ip, method, password):
    try:
        with opener_for(ip, password).open(
                f"http://{ip}/rpc/{method}", timeout=TIMEOUT) as r:
            return json.loads(r.read(16384).decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, ValueError):
        return None


def audit_one(item):
    mac, entry, password = item
    ip = entry.get("ip")
    row = {"mac": mac, "ip": ip, "name": entry.get("name"), "findings": []}
    if not ip:
        row["findings"].append("nicht erreichbar — keine IP bekannt")
        return row

    status = rpc(ip, "WiFi.GetStatus", password)
    config = rpc(ip, "WiFi.GetConfig", password)

    if status is None and config is None:
        # /shelly geht ohne Auth, RPC nicht -> Passwort fehlt oder falsch.
        row["findings"].append(
            "Konfiguration nicht lesbar (Passwort in config.json fehlt?)")
        return row

    if status:
        rssi = status.get("rssi")
        row["rssi"] = rssi
        row["ssid"] = status.get("ssid")
        if isinstance(rssi, int) and rssi <= RSSI_WEAK:
            row["findings"].append(
                f"Signal schwach ({rssi} dBm) — haeufige Abbrueche zu erwarten")

    if config:
        sta = config.get("sta") or {}
        sta1 = config.get("sta1") or {}
        row["ipv4mode"] = sta.get("ipv4mode")
        if sta.get("ipv4mode") == "dhcp":
            row["findings"].append(
                "IP per DHCP — in der Fritzbox feste Adresse reservieren")
        if not sta1.get("enable"):
            row["findings"].append("kein Fallback-WLAN (sta1) hinterlegt")

    if not entry.get("name") or str(entry.get("name")).startswith("("):
        row["findings"].append("kein Geraetename gesetzt")

    return row


def main():
    inv = json.load(open(INVENTORY)) if os.path.exists(INVENTORY) else {}
    if not inv:
        print("Kein Inventar. Erst shelly-monitor.py laufen lassen.",
              file=sys.stderr)
        return 1
    password = (json.load(open(CONFIG)).get("password")
                if os.path.exists(CONFIG) else None)

    items = [(mac, e, password) for mac, e in inv.items()]
    with ThreadPoolExecutor(max_workers=16) as pool:
        rows = list(pool.map(audit_one, items))

    rows.sort(key=lambda r: (not r["findings"], r.get("ip") or "zz"))
    total = 0
    for r in rows:
        head = f"{(r.get('ip') or '—'):<16} {r['mac']:<14} {r.get('name') or '?'}"
        extra = []
        if r.get("rssi") is not None:
            extra.append(f"{r['rssi']} dBm")
        if r.get("ipv4mode"):
            extra.append(r["ipv4mode"])
        print(head + (f"   [{', '.join(extra)}]" if extra else ""))
        for f in r["findings"]:
            print(f"    -> {f}")
            total += 1
        if not r["findings"]:
            print("    ok")
    print(f"\n{total} Befund(e) ueber {len(rows)} Geraete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
