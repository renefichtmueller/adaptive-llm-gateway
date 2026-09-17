#!/usr/bin/env python3
"""
shelly-mqtt — schaltet MQTT auf allen Gen2+/Gen3-Shellys ein und richtet sie
auf einen Broker aus.

Danach melden die Geraete ihren Zustand von sich aus an den Broker, statt dass
jemand 254 Adressen abklappert. Der Broker haelt mit Retained Messages den
letzten bekannten Stand, auch wenn ein Geraet gerade nicht da ist.

Wie shelly-setip laeuft es als Trockenlauf und schreibt erst mit --apply.
Jedes Geraet startet nach der Aenderung neu und wird danach verifiziert.

  shelly-mqtt.py --broker 192.168.178.82:1883
  shelly-mqtt.py --broker 192.168.178.82:1883 --apply

Zugangsdaten gehoeren nicht in die Shell-History — statt --user/--pass
besser in ~/.shelly-monitor/config.json unter "mqtt": {"user":…, "pass":…}.
"""

import argparse
import json
import os
import re
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


def topic_for(entry, mac):
    """shelly/wohnzimmer-esstisch-lampe — stabil, lesbar, ohne Sonderzeichen."""
    name = entry.get("name") or ""
    if not name or name.startswith("("):
        return f"shelly/{mac.lower()}"
    slug = re.sub(r"[^a-z0-9]+", "-",
                  name.lower().replace("ä", "ae").replace("ö", "oe")
                      .replace("ü", "ue").replace("ß", "ss")).strip("-")
    return f"shelly/{slug}"


def configure(mac, entry, broker, user, pw, device_pw, apply_it):
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

    topic = topic_for(entry, mac)
    print(f"  {name}: {ip} -> {broker}, Topic {topic}")
    if not apply_it:
        return True

    cfg = {"config": {"enable": True, "server": broker,
                      "topic_prefix": topic,
                      "rpc_ntf": True, "status_ntf": True}}
    if user:
        cfg["config"]["user"] = user
    if pw:
        cfg["config"]["pass"] = pw

    if rpc(ip, "MQTT.SetConfig", device_pw, cfg) is None:
        print("    FEHLER: MQTT.SetConfig abgelehnt (Geraete-Passwort?)")
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
    ap = argparse.ArgumentParser(description="MQTT auf allen Shellys aktivieren")
    ap.add_argument("--broker", required=True, help="host:port, z.B. 192.168.178.82:1883")
    ap.add_argument("--user", help="MQTT-Benutzer (besser: config.json)")
    ap.add_argument("--password", help="MQTT-Passwort (besser: config.json)")
    ap.add_argument("--only", help="nur diese MAC")
    ap.add_argument("--apply", action="store_true", help="wirklich schreiben")
    args = ap.parse_args()

    if not os.path.exists(INVENTORY):
        print("Kein Inventar. Erst shelly-monitor.py laufen lassen.", file=sys.stderr)
        return 1
    inv = json.load(open(INVENTORY))
    conf = json.load(open(CONFIG)) if os.path.exists(CONFIG) else {}
    mqtt = conf.get("mqtt", {})
    user = args.user or mqtt.get("user")
    pw = args.password or mqtt.get("pass")
    device_pw = conf.get("password")

    items = ([(args.only.upper(), inv[args.only.upper()])]
             if args.only and args.only.upper() in inv
             else sorted(inv.items(), key=lambda kv: kv[1].get("ip") or "zz"))

    print("TROCKENLAUF — es wird nichts geschrieben.\n" if not args.apply
          else "SCHREIBMODUS\n")
    ok = sum(bool(configure(mac, e, args.broker, user, pw, device_pw, args.apply))
             for mac, e in items)
    print(f"\n{ok}/{len(items)} erledigt.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
