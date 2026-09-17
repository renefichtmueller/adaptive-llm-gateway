> **Hinweis zum Ablageort:** Diese Tools haben inhaltlich nichts mit dem
> LLM-Gateway zu tun. Sie liegen hier nur auf dem Branch
> `claude/missing-shelly-devices-8jgpt5`, damit sie per `git clone` auf dem
> Mac Studio verfuegbar sind. Gehoeren langfristig in ein eigenes Repo.

# shelly-monitor

Meldet, wenn ein Shelly aus dem Netz faellt — statt dass es Wochen spaeter
beim Lichtanschalten auffaellt.

Fuehrt Geraete ueber die **MAC**, nicht die IP. Ein Shelly mit neuer DHCP-Adresse
gilt damit nicht als verschwunden; nur ein Geraet, das gar nicht mehr antwortet,
loest Alarm aus.

## Installation (Mac Studio)

```bash
mkdir -p ~/bin && cp shelly-monitor.py ~/bin/ && chmod +x ~/bin/shelly-monitor.py
~/bin/shelly-monitor.py            # erster Lauf, legt ~/.shelly-monitor an

sed "s|REPLACE_WITH_PATH|$HOME/bin|" com.rf.shelly-monitor.plist \
  > ~/Library/LaunchAgents/com.rf.shelly-monitor.plist
launchctl load ~/Library/LaunchAgents/com.rf.shelly-monitor.plist
```

Prüfen: `~/bin/shelly-monitor.py --status`

## Dateien

| Pfad | Inhalt |
|---|---|
| `~/.shelly-monitor/inventory.json` | alle je gesehenen Geraete, `last_seen`, `missing_since` |
| `~/.shelly-monitor/status.json`    | Kurzstand fuer Dashboards |
| `~/.shelly-monitor/monitor.log`    | Verlauf: wann weg, wann zurueck |
| `~/.shelly-monitor/config.json`    | optional: `{"webhook": "...", "subnets": ["192.168.178"]}` |

## Verhalten

- Probt **jede** Adresse im lokalen /24 direkt per HTTP auf `/shelly`.
  Bewusst ohne Ping/ARP — Geraete, die ICMP verschlucken, wuerden sonst fehlen.
- Alarm erst nach 3 Fehlversuchen in Folge (15 Min). Ein einzelner WLAN-Haenger
  meldet sich also nicht.
- Faellt ein Geraet aus, wird zusaetzlich das WLAN nach Shelly-APs gescannt.
  Treffer = das Geraet lebt, hat aber seine WLAN-Zugangsdaten verloren.
- Kommt es zurueck: Entwarnung plus Eintrag im Log.

Die 12 bekannten Geraete (10 online + die 2 vermissten) sind als Erwartung
vorbelegt, damit Fehlende ab dem ersten Lauf als `FEHLT` erscheinen.
