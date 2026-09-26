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
| `shelly-fix.py`     | stellt AP-Modus, BLE und Fallback-WLAN her |
| `mosquitto/`        | Broker-Deployment fuer Erik (Docker Compose) |

Alle schreibenden Werkzeuge laufen ohne `--apply` als Trockenlauf.

## Installation (Mac Studio)

```bash
bash install.sh
```

Das richtet alles ein: Werkzeuge nach `~/bin`, Konfigurationsgeruest,
beide Hintergrundjobs, erster Scan. Mehrfach ausfuehrbar — eine vorhandene
`config.json` wird nicht ueberschrieben. Das Skript warnt ausserdem, wenn es
auf einem Rechner laeuft, der per WLAN am Netz haengt.

Danach nur noch das Geraete-Passwort in `~/.shelly-monitor/config.json`
eintragen.

### Was dauerhaft laeuft

| Job | Takt | Aufgabe |
|---|---|---|
| `com.rf.shelly-monitor` | alle 5 Min | Erreichbarkeit, Alarm, neue Geraete |
| `com.rf.shelly-enforce` | taeglich 4:30 | AP-Modus, BLE + BLE-RPC, Fallback-WLAN nachsetzen |

Der zweite Job ist der Grund, dass die Haertung **bleibt**: verliert ein Geraet
seine Einstellungen — Werksreset, Austausch, Firmware-Update, das etwas
zurueckdreht — sind sie am naechsten Morgen wieder da. Geraete, die schon
richtig stehen, bleiben unberuehrt und bekommen keinen Neustart.

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

### Zugangswege herstellen

Was das Audit als fehlend meldet, setzt `shelly-fix.py` auch:

```bash
~/bin/shelly-fix.py --all            # zeigt, was fehlt
~/bin/shelly-fix.py --all --apply    # setzt AP-Modus, BLE + BLE-RPC, sta1
```

Anders als `shelly-setip.py` ist das ungefaehrlich: jede Aenderung fuegt einen
Zugangsweg hinzu, keine nimmt einen weg. Geraete, die schon richtig stehen,
bekommen keinen Neustart. Fuer `--sta1` braucht es das Ersatznetz in
`config.json`:

```json
{ "sta1": { "ssid": "LTE-Backup", "pass": "…" } }
```

## Wie der Monitor arbeitet

- Probt **jede** Adresse im lokalen /24 direkt per HTTP auf `/shelly`.
  Bewusst ohne Ping/ARP: `ping -W` ist auf macOS in Millisekunden, ein
  Ping-Sweep uebersieht damit die Haelfte der Geraete.
- Fuehrt das Inventar ueber die **MAC**, nicht die IP. Ein Geraet mit neuer
  DHCP-Adresse gilt so nicht als verschwunden.
- Alarm erst nach drei Fehlversuchen in Folge (15 Minuten).
- Bei Ausfall zusaetzlich ein WLAN-Scan nach Shelly-APs. Ein Treffer
  unterscheidet ein Geraet mit verlorenen Zugangsdaten von einem stromlosen.

## Wenn dauernd Geraete fehlen

```bash
~/bin/shelly-monitor.py --history
```

Zeigt, welches Geraet wie oft ausfiel und zu welcher Stunde. Das Muster sagt
mehr als der Einzelfall:

| Muster | Deutung |
|---|---|
| immer dasselbe Geraet | Funk oder Stromversorgung an diesem Ort |
| alle gleichzeitig | Router, DHCP, oder das Netz des scannenden Rechners |
| immer zur selben Stunde | Zeitgesteuertes: WLAN-Nachtschaltung, Lease-Wechsel |
| viele `VERIFY`-Zeilen | Signal grenzwertig, keine echten Ausfaelle |

**Von wo gescannt wird, entscheidet mit.** Laeuft der Monitor auf einem Laptop
im WLAN, kann ein Geraet unerreichbar erscheinen, das in Ordnung ist — anderes
Band, anderer Repeater, schlafendes Interface. Der Monitor gehoert auf einen
Rechner, der dauerhaft und moeglichst per Kabel am Netz haengt; `status.json`
haelt unter `scanned_from` fest, welche Maschine gemeldet hat.

Gegen kurze Aussetzer faellt der Monitor selbst nach: Geraete, die der schnelle
Durchgang verpasst, werden ein zweites Mal mit 6 s Timeout und drei Versuchen
gezielt angefragt. Erst wenn auch das scheitert, zaehlt ein Fehlversuch — und
Alarm gibt es erst nach dreien.

## Dateien

| Pfad | Inhalt |
|---|---|
| `~/.shelly-monitor/inventory.json` | alle je gesehenen Geraete, `last_seen`, `missing_since` |
| `~/.shelly-monitor/status.json`    | Kurzstand fuer Dashboards |
| `~/.shelly-monitor/monitor.log`    | Verlauf: wann weg, wann zurueck |
