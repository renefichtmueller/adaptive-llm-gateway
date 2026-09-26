#!/usr/bin/env python3
"""
shelly-fix — stellt die Zugangswege her, die shelly-audit.py als fehlend
meldet: AP-Modus, Bluetooth samt BLE-RPC, Fallback-WLAN.

Anders als shelly-setip.py ist hier nichts riskant: alle Aenderungen fuegen
einen Zugangsweg hinzu, keine nimmt einen weg. Selbst wenn eine davon
fehlschlaegt, bleibt das Geraet ueber seine bisherige Adresse erreichbar.
Trotzdem gilt Trockenlauf als Default.

  shelly-fix.py --all                 zeigt, was passieren wuerde
  shelly-fix.py --all --apply         fuehrt es aus
  shelly-fix.py --ap --ble --apply    nur diese beiden
  shelly-fix.py --sta1 --apply        Fallback-WLAN aus config.json setzen

Fuer --sta1 gehoert in ~/.shelly-monitor/config.json:
  "sta1": { "ssid": "LTE-Backup", "pass": "..." }
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

HOME = os.path.expanduser("~/.shelly-monitor")
INVENTORY = os.path.join(HOME, "inventory.json")
CONFIG = os.path.join(HOME, "config.json")
TIMEOUT = 5.0
REBOOT_WAIT = 45


def opener(ip, password):
    handlers = [urllib.request.ProxyHandler({})]
    if password:
        mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
        mgr.add_password(None, f"http://{ip}/", "admin", password)
        handlers.append(urllib.request.HTTPDigestAuthHandler(mgr))
    return urllib.request.build_opener(*handlers)


def rpc(ip, method, password, params=None):
    body = json.dumps({"id": 1, "method": method, "params": params or {}}).encode()
    req = urllib.request.Request(f"http://{ip}/rpc", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with opener(ip, password).open(req, timeout=TIMEOUT) as r:
            return json.loads(r.read(16384).decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, ValueError):
        return None


def alive(ip):
    try:
        op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with op.open(f"http://{ip}/shelly", timeout=TIMEOUT) as r:
            return json.loads(r.read(8192).decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, ValueError):
        return None


def fix_one(mac, entry, args, device_pw, sta1):
    ip = entry.get("ip")
    name = entry.get("name") or mac
    if not ip:
        print(f"  {name}: keine IP bekannt — uebersprungen")
        return False

    info = alive(ip)
    if not info:
        print(f"  {name}: {ip} antwortet nicht — uebersprungen")
        return False
    if int(info.get("gen", 1)) < 2:
        print(f"  {name}: Gen1 — dieses Werkzeug deckt nur Gen2+ ab")
        return False

    # Nur aendern, was wirklich fehlt. Ein Geraet, das schon richtig steht,
    # soll keinen Neustart abbekommen.
    todo, wifi, ble = [], {}, {}
    wcfg = rpc(ip, "WiFi.GetConfig", device_pw) or {}
    wcfg = wcfg.get("result", wcfg)
    bcfg = rpc(ip, "BLE.GetConfig", device_pw) or {}
    bcfg = bcfg.get("result", bcfg)

    if args.ap and not (wcfg.get("ap") or {}).get("enable"):
        wifi["ap"] = {"enable": True}
        todo.append("AP-Modus ein")

    if args.sta1 and sta1.get("ssid"):
        cur = (wcfg.get("sta1") or {})
        if not cur.get("enable") or cur.get("ssid") != sta1["ssid"]:
            wifi["sta1"] = {"enable": True, "ssid": sta1["ssid"],
                            "pass": sta1.get("pass"), "ipv4mode": "dhcp"}
            todo.append(f"Fallback-WLAN {sta1['ssid']}")

    if args.ble:
        if not bcfg.get("enable"):
            ble["enable"] = True
            todo.append("BLE ein")
        if not (bcfg.get("rpc") or {}).get("enable"):
            ble["rpc"] = {"enable": True}
            todo.append("BLE-RPC ein")

    if not todo:
        print(f"  {name}: steht schon richtig")
        return True

    print(f"  {name} ({ip}): {', '.join(todo)}")
    if not args.apply:
        return True

    if wifi and rpc(ip, "WiFi.SetConfig", device_pw, {"config": wifi}) is None:
        print("    FEHLER: WiFi.SetConfig abgelehnt (Geraete-Passwort?)")
        return False
    if ble and rpc(ip, "BLE.SetConfig", device_pw, {"config": ble}) is None:
        print("    FEHLER: BLE.SetConfig abgelehnt")
        return False

    rpc(ip, "Shelly.Reboot", device_pw)
    print(f"    Neustart, warte bis zu {REBOOT_WAIT}s ...")
    deadline = time.time() + REBOOT_WAIT
    while time.time() < deadline:
        if alive(ip):
            print("    OK")
            return True
        time.sleep(3)
    print(f"    WARNUNG: {ip} kam nicht zurueck — von Hand pruefen")
    return False


def main():
    ap = argparse.ArgumentParser(
        description="Zugangswege auf allen Shellys herstellen")
    ap.add_argument("--ap", action="store_true", help="AP-Modus aktivieren")
    ap.add_argument("--ble", action="store_true", help="BLE und BLE-RPC aktivieren")
    ap.add_argument("--sta1", action="store_true", help="Fallback-WLAN setzen")
    ap.add_argument("--all", action="store_true", help="alle drei")
    ap.add_argument("--only", help="nur diese MAC")
    ap.add_argument("--apply", action="store_true", help="wirklich schreiben")
    args = ap.parse_args()

    if args.all:
        args.ap = args.ble = args.sta1 = True
    if not (args.ap or args.ble or args.sta1):
        ap.error("waehle --ap, --ble, --sta1 oder --all")

    if not os.path.exists(INVENTORY):
        print("Kein Inventar. Erst shelly-monitor.py laufen lassen.", file=sys.stderr)
        return 1
    inv = json.load(open(INVENTORY))
    conf = json.load(open(CONFIG)) if os.path.exists(CONFIG) else {}
    sta1 = conf.get("sta1", {})
    if args.sta1 and not sta1.get("ssid"):
        print("Hinweis: --sta1 ohne \"sta1\" in config.json — wird uebersprungen.")

    items = ([(args.only.upper(), inv[args.only.upper()])]
             if args.only and args.only.upper() in inv
             else sorted(inv.items(), key=lambda kv: kv[1].get("ip") or "zz"))

    print("TROCKENLAUF — es wird nichts geschrieben.\n" if not args.apply
          else "SCHREIBMODUS\n")
    ok = sum(bool(fix_one(mac, e, args, conf.get("password"), sta1))
             for mac, e in items)
    print(f"\n{ok}/{len(items)} erledigt.")
    return 0 if ok == len(items) else 1


if __name__ == "__main__":
    sys.exit(main())
