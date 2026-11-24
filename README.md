# Energy Monitoring Management

Logs electricity data from multifunction meters (MFMs) in a steel plant and shows it on
Windows, macOS, Android and iPhone. Data is kept on a plant PC and, optionally, copied to a
cloud server so it can be seen from anywhere.

```
 Meters ── RS485 / Ethernet / Gateway ──▶ Plant PC (logger + dashboard) ──internet──▶ Cloud server (dashboard + login)
                                              ▲   plant LAN / Wi-Fi                        ▲  anywhere
                                     Windows · Mac · phones                       Windows · Mac · phones
```

## What it does

- Reads meters over **Modbus RTU on RS485**, **Modbus TCP on Ethernet**, or through a **gateway**
  (Modbus TCP gateway, or a transparent serial-over-TCP gateway). Chosen per connection, many meters per RS485 line or gateway.
- Supports **many meter models**: each model is a register map in `profiles/` (or added on the Settings page).
- Logs voltage (per phase, L-N, L-L), current, kW, kVA, kVAr, PF, frequency, kWh, kVAh, kVArh and THD.
  Values are averaged between log writes; energy registers store the latest value.
- **Dashboard**: plant load, PF, energy today, max demand, live meter cards, trends (1 hour to 30 days).
- **Reports**: daily kWh / kVAh / kVArh, average PF, **maximum demand in 15-minute blocks** (with time), peak kW. CSV export for Excel.
- **Alarms**: low PF, high kVA/kW, voltage out of range, high current, high voltage THD, meter offline. All logged with time.
- **Cloud sync**: the plant PC pushes data every 30 s. If the internet drops, data waits on the PC and is sent later.
- **Login** on the cloud server (and optionally on the plant PC). Viewer and admin roles.
- Installs as an app (PWA): in Chrome or Edge choose *Install app*; on a phone choose *Add to Home screen*.
- A built-in **meter simulator**, so everything can be tried before connecting real meters.

## Quick start (try it with simulated meters)

Needs Python 3.10 or newer.

- **Windows**: double-click `start-windows.bat`
- **macOS**: double-click `start-mac.command` (first time: right-click, Open)
- Or by hand: `pip install -r requirements.txt` then `python run.py`

Open <http://localhost:8080>. Phones and other PCs on the same network open `http://<plant-pc-ip>:8080`.
To fill a week of demo history: `python tools/seed_demo.py --config config.json`.

## Your company's look

Settings → **Branding** (admin only):
- Company name and plant name, shown in the side bar, the browser tab and the sign-in page.
- **Logo**: drop a PNG, JPG, SVG or WebP file (under 1 MB). It is stored on the PC next to the database.
- **Company colour**: used for live power flow, charts and buttons. Red always stays for alarms.
- **Screen**: dark (control room), light (office) or follow the device. Anyone can still flip it with the sun button.

Settings → **Machines and meters**: pick a **picture** for each machine (transformer, induction furnace,
arc furnace, ladle furnace, rolling mill, continuous caster, compressor, motor/pump, fan, EOT crane,
DG set, capacitor bank, lighting, office, other) and whether it sits above the busbar as a **main incomer**
or below it as a feeder. The Plant page draws the single-line diagram from this.

## Connecting real meters

Open **Settings** on the plant PC itself (settings are only editable from the PC, or by an admin user).

1. **Connections**: add one per RS485 port (COM3, `/dev/ttyUSB0`, with baud rate, parity, stop bits as set on the meters),
   per Ethernet meter (IP, port 502), or per gateway (IP, port, and gateway type).
2. **Meter models**: the shipped profiles are **templates with placeholder addresses**. For each model you use,
   add its register map from the meter's Modbus manual (address, `float32`/`int16`/`uint32`…, scale, holding or input
   registers, word order). Save it as `profiles/<model>.json` or paste it into the Settings page.
   If your manual numbers registers from 1 or as 40001…, set `"address_offset": -1` or subtract 40001.
3. **Meters**: name, area, connection, model, Modbus address (slave ID), contract demand, and whether it is a
   **main incomer** (plant totals use main incomers, so feeders are not counted twice).
4. Press **Test reading** to check the wiring, then **Save and restart logging**.

## Meter models included

Each model's register map is in `profiles/`, with the source it came from. "Not confirmed" means the
addresses come from a third-party list or a partly readable manual: press **Test reading** once per model
and compare the numbers with the meter's own display before relying on it. Test reading also detects a
swapped word order and tells you the fix.

| Brand | Models | Map source | Status |
|---|---|---|---|
| Schneider | PM5300, PM5100, PM2100, EM6400NG/NG+ (PowerLogic map) | Schneider PM5350 register list (2010 draft) + third-party list, both agree | Not confirmed per model |
| Selec | MFM384, MFM383A | Third-party list (AGG Software) | Not confirmed |
| Rishabh | Rish Master 3440, 3440i | Rishabh manual (partly legible) + third-party list, agree | Check energy units |
| Secure | Elite 440 (445 likely same) | Third-party list | Not confirmed |
| Elmeasure | LG+ | Third-party list | Not confirmed, units assumed |
| Siemens | PAC3200 | Siemens manual | Check energy registers |
| Siemens | PAC3100 | Third-party list, partial (no energy) | Not confirmed |
| ABB | M2M Ethernet | ABB M2M Ethernet manual | Checked; RS485 model not confirmed |
| Socomec | DIRIS A40 / A41 | Socomec manual | Checked |

**Not included yet, no reliable register list found online:** Schneider EM6433, EM6436 (two sources
contradict each other), EM3250; Rishabh 3430; L&T WL series; ABB M4M; Socomec DIRIS A20. Send the
Modbus/communication manual for these (a photo or PDF is fine) and they can be added, or paste the
map into Settings → Meter models.

## Cloud server

Run the same program on any cloud VM (or with the `Dockerfile`) in cloud mode:

1. Copy `cloud.example.json` to `config.json` on the server.
2. `python run.py new-key` → put the output in `secret_key`, and again for each plant in `ingest_keys`.
3. `python run.py hash-password` → put the output in `users`.
4. Put it behind HTTPS (for example Caddy or nginx with a certificate). Do not expose it over plain HTTP.
5. On each plant PC: Settings → Cloud sync → server address and that plant's key.

The cloud dashboard shows all plants together, grouped by plant and area.

## Project layout

```
energylogger/   config, Modbus readers, collector, database, reports, cloud sync, login, web API
web/            dashboard (plain HTML/JS/CSS, works without internet)
profiles/       meter model register maps
tools/          fake_meter.py (Modbus test meter / gateway), seed_demo.py
tests/          end-to-end and report tests:  python -m pytest -q tests
```

## Not done yet

- Register maps for Schneider EM6433/EM6436/EM3250, Rishabh 3430, L&T WL, ABB M4M, Socomec DIRIS A20.
- Native installers (a Windows `.exe` service and a Mac app). For now the start scripts are used.
- Email / SMS / WhatsApp alarm alerts, monthly bill-style reports, shift-wise (A/B/C) reports.
- Production-per-tonne (kWh/ton) reports if furnace tonnage is entered.
