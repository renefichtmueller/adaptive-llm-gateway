> **Hinweis zum Ablageort:** Diese Tools haben inhaltlich nichts mit dem
> LLM-Gateway zu tun. Sie liegen hier nur auf dem Branch
> `claude/missing-shelly-devices-8jgpt5`, damit sie per `git clone` auf dem
> Mac Studio verfuegbar sind. Gehoeren langfristig in ein eigenes Repo.

# shelly-monitor

Vier Werkzeuge, damit kein Shelly mehr unbemerkt aus dem Netz faellt.

| Werkzeug | Zweck |
|---|---|
| `shelly-monitor.py` | Inventar, Erreichbarkeit, Alarm bei Ausfall |
| `shelly-audit.py`   | liest die Konfiguration, benennt Ausfallursachen und prueft, was bei Funkausfall traegt |
| `shelly-setip.py`   | setzt feste IPs, damit alle in einem Adressblock liegen |
| `shelly-mqtt.py`    | schaltet MQTT ein und richtet es auf einen Broker aus |

Alle schreibenden Werkzeuge laufen ohne `--apply` als Trockenlauf.

## Installation (Mac Studio)

```bash
mkdir -p ~/bin && cp shelly-*.py ~/bin/ && chmod +x ~/bin/shelly-*.py
~/bin/shelly-monitor.py

sed "s|REPLACE_WITH_PATH|$HOME/bin|" com.rf.shelly-monitor.plist \
  > ~/Library/LaunchAgents/com.rf.shelly-monitor.plist
launchctl load ~/Library/LaunchAgents/com.rf.shelly-monitor.plist
```

## Konfiguration

`~/.shelly-monitor/config.json`, alles optional:

```json
{
  "password": "<Geraete-Passwort fuer Shellys mit auth_en>",
  "ip_block": [40, 69],
  "subnets": ["192.168.178"],
  "webhook": "https://…",
  "mqtt": { "user": "…", "pass": "…" }
}
```

## Der Adressblock

Shellys sollen in **192.168.178.40–69** liegen, damit man sie am Netzplan
erkennt. `shelly-monitor.py` markiert jedes Geraet ausserhalb.

`plan.json` enthaelt die vier noch offenen Umzuege:

```bash
~/bin/shelly-setip.py --plan plan.json            # zeigt nur an
~/bin/shelly-setip.py --plan plan.json --apply    # fuehrt aus
```

Der ruhigere Weg ist eine **DHCP-Reservierung in der Fritzbox**
(*Heimnetz → Netzwerk → Gerät bearbeiten → „Diesem Netzwerkgerät immer die
gleiche IPv4-Adresse zuweisen"*). Ein Tippfehler kostet dort einen zweiten
Versuch statt eines Werksresets. `shelly-setip.py` ist fuer Geraete gedacht,
die bereits statisch konfiguriert sind und deshalb keine Reservierung annehmen.

## Zugriff, wenn das WLAN weg ist

Ein Shelly ist ein WLAN-Geraet. Faellt das WLAN aus, ist er ueber IP nicht
erreichbar — **auch nicht ueber MQTT**, denn der Broker haengt am selben Netz.
Was trotzdem traegt:

1. **Der Wandschalter.** Solange der Eingang nicht auf `detached` steht,
   schaltet der Shelly lokal, voellig ohne Netz. Bei `detached` braucht er ein
   Skript oder eine Szene auf dem Geraet, sonst bleibt das Licht aus.
   `shelly-audit.py` zeigt den Eingangsmodus und meldet
   betroffene Geraete am Ende als "Bei Funkausfall stumm".
2. **Bluetooth.** Gen2/Gen3 sprechen BLE. Der vorhandene BluGw (`B0B21CFABD80`)
   erreicht die Geraete auch ohne WLAN — der einzige echte Fernzugriff bei
   Funkausfall.
3. **Der eigene Access Point des Geraets.** Verliert ein Shelly die
   WLAN-Verbindung, macht er ein eigenes Netz auf. Damit kommt man per Handy
   direkt dran. Der AP-Modus sollte deshalb aktiviert bleiben.
4. **Zweites WLAN (`sta1`).** Gen2+ kann ein Ersatznetz hinterlegen, etwa einen
   LTE-Router. Faellt die Fritzbox aus, wechseln die Geraete selbsttaetig.

MQTT loest also nicht den Funkausfall, sondern das Abfrageproblem: die Geraete
melden ihren Zustand von sich aus, der Broker haelt ihn als Retained Message
vor, und der Monitor muss nicht mehr das ganze Netz abklappern.

```bash
~/bin/shelly-mqtt.py --broker 192.168.178.82:1883           # zeigt nur an
~/bin/shelly-mqtt.py --broker 192.168.178.82:1883 --apply
```

### Pruefen, was ohne WLAN traegt

```bash
~/bin/shelly-audit.py
```

Markiert mit `!!` alles, was bei Funkausfall beisst: Eingaenge auf `detached`
ohne Skript, abgeschalteten AP-Modus, fehlendes `sta1`, deaktiviertes BLE oder
BLE-RPC. Am Ende steht, ueber wie viele Geraete der BluGw noch herankommt und
welche bei Funkausfall stumm blieben.

## Wie der Monitor arbeitet

- Probt **jede** Adresse im lokalen /24 direkt per HTTP auf `/shelly`.
  Bewusst ohne Ping/ARP: `ping -W` ist auf macOS in Millisekunden, ein
  Ping-Sweep uebersieht damit die Haelfte der Geraete.
- Fuehrt das Inventar ueber die **MAC**, nicht die IP. Ein Geraet mit neuer
  DHCP-Adresse gilt so nicht als verschwunden.
- Alarm erst nach drei Fehlversuchen in Folge (15 Minuten).
- Bei Ausfall zusaetzlich ein WLAN-Scan nach Shelly-APs. Ein Treffer
  unterscheidet ein Geraet mit verlorenen Zugangsdaten von einem stromlosen.

## Dateien

| Pfad | Inhalt |
|---|---|
| `~/.shelly-monitor/inventory.json` | alle je gesehenen Geraete, `last_seen`, `missing_since` |
| `~/.shelly-monitor/status.json`    | Kurzstand fuer Dashboards |
| `~/.shelly-monitor/monitor.log`    | Verlauf: wann weg, wann zurueck |
