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

Open <http://localhost:8080>. The demo plant has a 33 kV incomer with CGL, Galvalume, CCL, pickling, slitters, trimming line, boiler, ETP, RO, LPG yard, utility and workshop. Phones and other PCs on the same network open `http://<plant-pc-ip>:8080`.
To fill two weeks of demo history: `python tools/seed_demo.py --config config.json`.

## Your company's look

Settings → **Branding** (admin only):
- Company name and plant name, shown in the side bar, the browser tab and the sign-in page.
- **Logo**: drop a PNG, JPG, SVG or WebP file (under 1 MB). It is stored on the PC next to the database.
- **Company colour**: used for live power flow, charts and buttons. Red always stays for alarms.
- **Screen**: dark (control room), light (office) or follow the device. Anyone can still flip it with the sun button.

### Machine names and pictures

Every machine on the plant diagram has a name and a picture, and both can be changed at any time:

- **On the machine's own page** (click it on the Plant diagram): press **Rename** to change its name or area,
  or click the picture to change it. Logging carries on; nothing restarts.
- **In Settings → Machines and meters**: the same, plus whether it sits above the busbar as a **main incomer**
  or below it as a feeder.

The picture picker has drawings of the machines found in steel plants, grouped and searchable:

| Group | Pictures |
|---|---|
| Power | Transformer / incomer, DG set, capacitor bank / APFC |
| Coating lines | CGL line (galvanizing), Galvalume line, CCL line (colour coating) |
| Rolling and strip processing | Hot rolling mill, cold rolling mill (CRM), pickling line, annealing furnace |
| Finishing | HR slitter, CR slitter, trimming line, cut-to-length line |
| Utilities | Utility, boiler, LPG yard, ETP, RO plant, cooling tower, air compressor, pump, motor, fan / blower, oxygen / gas plant, fume extraction |
| Melting and casting | Induction furnace, arc furnace, ladle furnace, continuous caster, reheating furnace |
| Handling and buildings | EOT crane, workshop, lighting, office, other feeder |

If none fits, choose **Upload a photo or drawing** (PNG, JPG, SVG or WebP under 1 MB; a square photo works best).
Uploaded pictures are kept on the plant PC in `data/branding/machines/`. When no picture is chosen, one is picked
from the machine's name (for example "HR Slitter 2" gets the HR slitter drawing).

## Insights: analysis and advice

The **Insights** page reads the last 7 full days of data and says what to fix, with a rough rupee value per month.
It runs on the plant PC with no internet. It checks:

- **Power factor** at the main incomer, the kVAr of capacitor bank needed to reach 0.99, and the lowest-PF feeders.
  With kVAh billing it shows what the poor PF costs.
- **Maximum demand** against contract demand: a warning near the limit, or a suggestion to lower the contract if it is far below.
- **Idle running**: machines that stay on at under 15% of their normal load (lines stopped but drives, hydraulics or heaters left on).
- **Peak hours**: flexible machines (slitters, trimming, ETP, RO, workshop, compressors, pumps) using energy in the peak tariff window.
- **Trends**: machines using over 15% more energy than the week before, and unusual days.
- **Electrical health**: current unbalance, voltage unbalance, voltage harmonics (THD) and voltage level.

It also shows the plant load for each hour of the day against the peak window, and where the energy goes by machine.
Set your tariff (kVAh or kWh billing, rates, demand charge, peak hours) at the bottom of the page so the money figures match your bill.

**Ask Claude (optional).** An admin can paste a Claude API key (from console.anthropic.com) on the Insights page.
Then anyone can ask questions in plain words, such as "how do I cut my maximum demand?". Each question sends this
week's summary (daily totals, hourly averages and the findings, not raw readings) to Anthropic over the internet,
and is billed to that API key. Leave the key empty to keep everything on the plant PC.

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
