# Mosquitto fuer die Shellys

## Einrichten (auf Erik, 192.168.178.82)

```bash
sudo mkdir -p /opt/mosquitto && cd /opt/mosquitto
# docker-compose.yaml und mosquitto.conf hierher kopieren

# Benutzer anlegen. Das Passwort landet gehasht in ./passwd,
# im Klartext nur in deinem Passwortmanager.
docker run --rm -it -v "$PWD:/c" eclipse-mosquitto:2 \
  mosquitto_passwd -c /c/passwd shelly

docker compose up -d
docker compose logs --tail=20 mosquitto
```

## Testen

```bash
# Lauschen (Terminal 1)
mosquitto_sub -h 192.168.178.82 -u shelly -P '<passwort>' -t 'shelly/#' -v

# Shellys darauf ausrichten (Terminal 2)
shelly-mqtt.py --broker 192.168.178.82:1883 --apply
```

Danach sollten Topics wie `shelly/esstisch-lampe/status/switch:0` eintrudeln,
sobald jemand das Licht schaltet.

Zugangsdaten fuer die Werkzeuge nach `~/.shelly-monitor/config.json`:

```json
{ "mqtt": { "user": "shelly", "pass": "<passwort>" } }
```

## Was der Broker leistet — und was nicht

Er nimmt dir das Abklappern des Netzes ab: die Geraete melden Zustands-
aenderungen selbst, und Retained Messages halten den letzten Stand vor.

Er ersetzt **keinen** Zugriff bei Funkausfall. Broker und Shellys haengen am
selben Netz; faellt das WLAN, ist beides weg. Dafuer sind Wandschalter, BLE
ueber den BluGw, der geraeteeigene AP und ein Fallback-WLAN zustaendig — siehe
die README eine Ebene hoeher.

## Firewall

Port 1883 darf **nur** aus dem LAN erreichbar sein. Nicht im Router
weiterleiten. Wer MQTT von aussen braucht, nimmt VPN, nicht Portfreigabe.
