#!/usr/bin/env python3
"""
shelly-audit — liest die Konfiguration aller Shellys und benennt zwei Sorten
von Problemen.

Rein lesend. Aendert nichts.

1. Was Ausfaelle verursacht
     * Signalstaerke (RSSI)   -- unter -75 dBm reisst die Verbindung ab
     * IPv4-Modus             -- DHCP ohne Reservierung = wandernde IP
     * Adressblock            -- Geraete ausserhalb 192.168.178.40-69
     * Geraetename            -- ohne Namen ist ein Ausfall nicht zuzuordnen

2. Was bei Funkausfall noch traegt
     * Eingangsmodus          -- 'detached' heisst: ohne Netz kein Licht
     * AP-Modus               -- eigenes Netz des Geraets als Notzugang
     * Fallback-WLAN (sta1)   -- zweites Netz, etwa ein LTE-Router
     * Bluetooth + BLE-RPC    -- der einzige echte Fernzugriff ohne WLAN

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
IP_BLOCK = (40, 69)


def opener(ip, password):
    handlers = [urllib.request.ProxyHandler({})]
    if password:
        mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
        mgr.add_password(None, f"http://{ip}/", "admin", password)
        handlers.append(urllib.request.HTTPDigestAuthHandler(mgr))
    return urllib.request.build_opener(*handlers)


def rpc(ip, method, password, params=None):
    url = f"http://{ip}/rpc/{method}"
    data = None
    if params:
        url = f"http://{ip}/rpc"
        data = json.dumps({"id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(
        url, data=data,
        headers={"Content-Type": "application/json"} if data else {})
    try:
        with opener(ip, password).open(req, timeout=TIMEOUT) as r:
            out = json.loads(r.read(16384).decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, ValueError):
        return None
    return out.get("result", out) if isinstance(out, dict) else out


def audit_one(item):
    mac, entry, password, block = item
    ip = entry.get("ip")
    row = {"mac": mac, "ip": ip, "name": entry.get("name"),
           "findings": [], "offline_risks": [], "ble": False}
    if not ip:
        row["findings"].append("nicht erreichbar — keine IP bekannt")
        return row

    status = rpc(ip, "WiFi.GetStatus", password)
    config = rpc(ip, "WiFi.GetConfig", password)
    if status is None and config is None:
        row["findings"].append(
            "Konfiguration nicht lesbar (Passwort in config.json fehlt?)")
        return row

    # --- Ausfallursachen ---
    if status:
        row["rssi"] = status.get("rssi")
        if isinstance(row["rssi"], int) and row["rssi"] <= RSSI_WEAK:
            row["findings"].append(
                f"Signal schwach ({row['rssi']} dBm) — Abbrueche zu erwarten")

    if config:
        sta = config.get("sta") or {}
        row["ipv4mode"] = sta.get("ipv4mode")
        if sta.get("ipv4mode") == "dhcp":
            row["findings"].append(
                "IP per DHCP — in der Fritzbox feste Adresse reservieren")
        if not (config.get("sta1") or {}).get("enable"):
            row["offline_risks"].append(
                "kein Fallback-WLAN (sta1) — kein Ausweichnetz bei Ausfall")
        if not (config.get("ap") or {}).get("enable"):
            row["offline_risks"].append(
                "AP-Modus aus — kein Notzugang, wenn das WLAN wegbricht")

    try:
        last = int(ip.rsplit(".", 1)[1])
        if not block[0] <= last <= block[1]:
            row["findings"].append(
                f"ausserhalb des Shelly-Blocks .{block[0]}-{block[1]}")
    except (ValueError, IndexError):
        pass

    if not entry.get("name") or str(entry.get("name")).startswith("("):
        row["findings"].append("kein Geraetename gesetzt")

    # --- Was ohne WLAN traegt ---
    # 'detached' trennt den Wandschalter vom Relais: ohne Netz passiert nichts,
    # es sei denn, auf dem Geraet laeuft ein Skript, das den Eingang auswertet.
    scripts = rpc(ip, "Script.List", password) or {}
    has_script = bool(scripts.get("scripts"))
    for sid in (0, 1):
        sw = rpc(ip, "Switch.GetConfig", password, {"id": sid})
        if not sw:
            continue
        mode = sw.get("in_mode")
        row.setdefault("inputs", []).append(f"{sid}:{mode}")
        if mode == "detached" and not has_script:
            row["offline_risks"].append(
                f"Eingang {sid} auf 'detached' und kein Skript — "
                f"schaltet bei Funkausfall NICHT mehr")

    ble = rpc(ip, "BLE.GetConfig", password)
    if ble is not None:
        row["ble"] = bool(ble.get("enable")) and bool(
            (ble.get("rpc") or {}).get("enable"))
        if not row["ble"]:
            row["offline_risks"].append(
                "BLE oder BLE-RPC aus — ueber den BluGw nicht erreichbar")

    return row


def main():
    if not os.path.exists(INVENTORY):
        print("Kein Inventar. Erst shelly-monitor.py laufen lassen.", file=sys.stderr)
        return 1
    inv = json.load(open(INVENTORY))
    conf = json.load(open(CONFIG)) if os.path.exists(CONFIG) else {}
    password = conf.get("password")
    block = tuple(conf.get("ip_block", IP_BLOCK))

    with ThreadPoolExecutor(max_workers=16) as pool:
        rows = list(pool.map(audit_one,
                             [(m, e, password, block) for m, e in inv.items()]))

    rows.sort(key=lambda r: (not (r["findings"] or r["offline_risks"]),
                             r.get("ip") or "zz"))

    stumm, ble_ok, total_findings = [], 0, 0
    for r in rows:
        extra = []
        if r.get("rssi") is not None:
            extra.append(f"{r['rssi']} dBm")
        if r.get("ipv4mode"):
            extra.append(r["ipv4mode"])
        if r.get("inputs"):
            extra.append("in " + ",".join(r["inputs"]))
        print(f"{(r.get('ip') or '—'):<16} {r['mac']:<14} {r.get('name') or '?'}"
              + (f"   [{', '.join(extra)}]" if extra else ""))
        for f in r["findings"]:
            print(f"    -> {f}")
            total_findings += 1
        for f in r["offline_risks"]:
            print(f"    !! {f}")
            total_findings += 1
            if "schaltet bei Funkausfall NICHT" in f:
                stumm.append(r.get("name") or r["mac"])
        if not (r["findings"] or r["offline_risks"]):
            print("    ok")
        if r["ble"]:
            ble_ok += 1

    print(f"\n{total_findings} Befund(e) ueber {len(rows)} Geraete.")
    print(f"Per Bluetooth erreichbar (BluGw): {ble_ok}/{len(rows)}")
    if stumm:
        print("Bei Funkausfall stumm: " + ", ".join(sorted(set(stumm))))
    else:
        print("Bei Funkausfall stumm: keines — alle Wandschalter wirken lokal.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
