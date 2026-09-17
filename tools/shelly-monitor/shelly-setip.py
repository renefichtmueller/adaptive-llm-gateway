#!/usr/bin/env python3
"""
shelly-setip — weist Shellys eine feste IP zu, damit alle in einem
zusammenhaengenden Adressblock liegen.

VORSICHT: Das Geraet wechselt seine Adresse und startet neu. Stimmt Gateway
oder Maske nicht, ist es danach nur noch ueber einen Werksreset erreichbar.
Deshalb laeuft das Werkzeug standardmaessig als Trockenlauf und schreibt erst
mit --apply. Jedes Geraet wird nach dem Neustart auf der neuen Adresse
verifiziert, bevor das naechste drankommt.

Der ruhigere Weg ist eine DHCP-Reservierung in der Fritzbox — dort kostet ein
Tippfehler nur einen zweiten Versuch. Dieses Werkzeug ist fuer Geraete
gedacht, die bereits eine statische IP tragen und deshalb keine Reservierung
annehmen.

  shelly-setip.py --plan plan.json            Trockenlauf, zeigt was passiert
  shelly-setip.py --plan plan.json --apply    fuehrt es aus
  shelly-setip.py --mac AABBCC --ip 192.168.178.43 --apply
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
REBOOT_WAIT = 45      # Sekunden, die ein Gen2/Gen3 fuer den Neustart braucht
POLL_EVERY = 3


def opener(ip, password):
    handlers = [urllib.request.ProxyHandler({})]
    if password:
        mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
        mgr.add_password(None, f"http://{ip}/", "admin", password)
        handlers.append(urllib.request.HTTPDigestAuthHandler(mgr))
    return urllib.request.build_opener(*handlers)


def rpc(ip, method, password, params=None):
    body = json.dumps({"id": 1, "method": method,
                       "params": params or {}}).encode()
    req = urllib.request.Request(
        f"http://{ip}/rpc", data=body,
        headers={"Content-Type": "application/json"})
    try:
        with opener(ip, password).open(req, timeout=TIMEOUT) as r:
            return json.loads(r.read(16384).decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, ValueError):
        return None


def identify(ip):
    """Liest /shelly (ohne Auth) und gibt die MAC zurueck."""
    try:
        op = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with op.open(f"http://{ip}/shelly", timeout=TIMEOUT) as r:
            return json.loads(r.read(8192).decode("utf-8", "replace")).get("mac", "").upper()
    except (urllib.error.URLError, OSError, ValueError):
        return None


def wait_for(ip, mac, seconds):
    """Wartet, bis unter der neuen Adresse das erwartete Geraet antwortet."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        if identify(ip) == mac:
            return True
        time.sleep(POLL_EVERY)
    return False


def move(mac, target_ip, inv, password, gw, dns, apply_it):
    entry = inv.get(mac)
    if not entry or not entry.get("ip"):
        print(f"  {mac}: keine aktuelle IP im Inventar — uebersprungen")
        return False
    current = entry["ip"]
    name = entry.get("name") or mac

    if current == target_ip:
        print(f"  {name}: liegt bereits auf {target_ip}")
        return True

    live = identify(current)
    if live != mac:
        print(f"  {name}: {current} antwortet nicht als {mac} "
              f"(gefunden: {live or 'nichts'}) — uebersprungen")
        return False

    print(f"  {name}: {current} -> {target_ip}  (gw {gw}, dns {dns})")
    if not apply_it:
        return True

    cfg = {"config": {"sta": {"ipv4mode": "static", "ip": target_ip,
                              "netmask": "255.255.255.0", "gw": gw,
                              "nameserver": dns, "enable": True}}}
    if rpc(current, "WiFi.SetConfig", password, cfg) is None:
        print("    FEHLER: SetConfig abgelehnt (Passwort? Gen1-Geraet?)")
        return False

    rpc(current, "Shelly.Reboot", password)
    print(f"    Neustart, warte bis zu {REBOOT_WAIT}s ...")
    if wait_for(target_ip, mac, REBOOT_WAIT):
        print(f"    OK — antwortet auf {target_ip}")
        entry["ip"] = target_ip
        return True

    print(f"    WARNUNG: {target_ip} antwortet nicht. Pruefe {current} und "
          f"{target_ip} von Hand, bevor du weitermachst.")
    return False


def main():
    ap = argparse.ArgumentParser(description="Feste IPs fuer Shellys setzen")
    ap.add_argument("--plan", help="JSON: {\"MAC\": \"192.168.178.43\", ...}")
    ap.add_argument("--mac", help="einzelne MAC (ohne Doppelpunkte)")
    ap.add_argument("--ip", help="Ziel-IP fuer --mac")
    ap.add_argument("--gw", help="Gateway (Standard: x.x.x.1)")
    ap.add_argument("--dns", help="DNS (Standard: wie Gateway)")
    ap.add_argument("--apply", action="store_true",
                    help="wirklich schreiben statt nur anzeigen")
    args = ap.parse_args()

    if not os.path.exists(INVENTORY):
        print("Kein Inventar. Erst shelly-monitor.py laufen lassen.",
              file=sys.stderr)
        return 1
    inv = json.load(open(INVENTORY))
    password = (json.load(open(CONFIG)).get("password")
                if os.path.exists(CONFIG) else None)

    if args.plan:
        plan = json.load(open(args.plan))
    elif args.mac and args.ip:
        plan = {args.mac.upper().replace(":", ""): args.ip}
    else:
        ap.error("entweder --plan oder --mac zusammen mit --ip")

    first = next(iter(plan.values()))
    gw = args.gw or first.rsplit(".", 1)[0] + ".1"
    dns = args.dns or gw

    print("TROCKENLAUF — es wird nichts geschrieben.\n" if not args.apply
          else "SCHREIBMODUS\n")
    ok = 0
    for mac, target in plan.items():
        if move(mac.upper(), target, inv, password, gw, dns, args.apply):
            ok += 1

    if args.apply:
        with open(INVENTORY, "w") as fh:
            json.dump(inv, fh, indent=2, ensure_ascii=False)
    print(f"\n{ok}/{len(plan)} erledigt.")
    return 0 if ok == len(plan) else 1


if __name__ == "__main__":
    sys.exit(main())
