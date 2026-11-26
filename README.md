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
- **Plant diagram in your real layout**: panel by panel as on the SLD (HT panel, DG synchronizing panel, each PCC),
  with live power flow along the cables, breakers that open and close, dead buses shown with no supply, and grid power
  and DG power in different colours.
- **DG sets**: live status (stopped, cranking, running, on load), start and stop times, running timer, run hours per day
  and in total (matched to the engine hour meter), kWh generated, load %, estimated diesel and cost, and a log of every grid power cut.
- **Power cuts** are logged with start, end and duration, along with each DG start and stop and each PCC changeover.
- **Sign-in for everyone**. Each person gets a user ID with name, designation and phone, and the admin picks which pages
  (Plant, DG, Insights, Reports, Alarms) and which panels they can see. Accounts can be blocked at once.
- **Shifts** (for example A, B, C or Day and Night) with shift-wise reports: kWh, max demand, PF, DG hours, diesel and power cuts per shift.
- Installs as an app (PWA): in Chrome or Edge choose *Install app*; on a phone choose *Add to Home screen*.
- A built-in **meter simulator**, so everything can be tried before connecting real meters.

## Quick start (try it with simulated meters)

Needs Python 3.10 or newer.

- **Windows**: double-click `start-windows.bat`
- **macOS**: double-click `start-mac.command` (first time: right-click, Open)
- Or by hand: `pip install -r requirements.txt` then `python run.py`

Open <http://localhost:8080> on the plant PC. The first time, it asks you to create the admin account (this can only
be done on the plant PC itself). After that everyone signs in; add people under Settings → Users and access.
Phones and other PCs on the same network open `http://<plant-pc-ip>:8080`.

The demo plant follows the CRM Complex SLD: 22 kV HT panel with TR-1 to TR-5, two 1010 kVA DG sets on a synchronizing
panel, and the 6HI, CCL line and CGL line PCCs, each with a transformer incomer and a DG incomer.
To fill two weeks of demo history (with power cuts and DG runs): `python tools/seed_demo.py --config config.json`.

**Demo power cut switch**: on the Plant page an admin sees a *Grid ON / OFF* lever (only with simulated meters).
Switching it off cuts the grid: the HT panel goes dead, both DGs crank, synchronise and close on to the PCCs about
12 seconds later, and the PCCs change over to DG. Switching it back on restores the grid, the PCCs change back and the
DGs cool down for about a minute and stop. Everything is logged, the same as a real power cut.

## Plant layout, DG sets, users and shifts

- **Plant layout**: Settings → Plant layout lists the panels top to bottom. Under Machines and meters each meter gets
  its panel, whether it is an incomer or a feeder, what feeds an incomer (a transformer feeder or a panel such as the
  DG panel), and which panel a transformer feeder supplies. Only the grid incomer and the DGs count in the plant total.
- **DG sets**: give the DG meter the picture *DG set / generator*. A DG counts as running when its frequency is above
  40 Hz with voltage, or while it carries load. Diesel is an estimate from the usual generator fuel line
  (litres per hour = 0.08145 × rated kW + 0.246 × kW output); set your own numbers and diesel price on the DG page.
  Type the engine hour meter reading there once, so total run hours match the engine.
- **Users**: roles are Admin (everything, plus settings) and Viewer (only the pages and panels ticked).
- **Shifts**: Settings → Shifts. A night shift belongs to the date it starts. Reports → Show → Shift-wise.

## Installers: Windows .exe and Mac .dmg

Ready-made installers are on the GitHub **Releases** page of this repository:

- **Windows 10/11**: `EnergyMonitoring-Setup-<version>.exe`. Run it and keep the ticks for *start logging when Windows
  starts* and *allow phones on the plant network*. Open *Energy Monitoring* from the Start menu.
- **Mac**: `EnergyMonitoring-<version>-mac-arm64.dmg` for Apple Silicon (M1 to M4), `...-x86_64.dmg` for Intel Macs.
  Drag the app to Applications. The first time, macOS may block it because it is not signed with an Apple
  certificate yet: System Settings → Privacy & Security → *Open Anyway*.

The app opens the dashboard in its own window. Closing the window does not stop logging: the logger keeps running in
the background, serves phones and other PCs on the network, and starts again with the computer. *Stop logging* is in
the Start menu (Windows); on a Mac run `"/Applications/Energy Monitoring.app/Contents/MacOS/EnergyMonitoring" --stop`.
Settings and data live in `%LOCALAPPDATA%\Energy Monitoring` (Windows) or `~/Library/Application Support/Energy Monitoring`
(Mac), so updating or uninstalling the app keeps them.

To make new installers: push a tag such as `v1.5.1` (with the same number in `energylogger/__init__.py`), or run the
*Installers* workflow by hand from the Actions tab. The recipe is in `packaging/` and `.github/workflows/installers.yml`.
The installers are not code-signed; signing needs a Windows code-signing certificate and an Apple Developer account
(about US$99 a year), which removes the security warnings.

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

Everything is done on the plant PC, in **Settings → Machines and meters** (signed in as an admin).

**What you need**

- **RS485 meters**: a USB-RS485 converter (an industrial one with isolation is best, such as a CH340, FTDI or CP2102
  based converter) and a twisted-pair shielded cable. Connect the converter's A(+) and B(−) to the meter's A and B
  (Schneider and some others call them D1/D0 or + / −). Up to about 30 meters can share one RS485 line, each with its own
  Modbus ID; put a 120 Ω resistor across A and B at the far end of a long line.
- **Ethernet meters** (PM5300 with Ethernet, ABB M2M Ethernet and so on): the meter and the PC on the same network.
- **Gateway**: an RS485-to-Ethernet gateway for meters that are far from the PC. Choose *Modbus TCP gateway* when the
  gateway converts the protocol, or *Transparent* when it only passes raw bytes through.

On each meter, note its communication settings from its own menu: **Modbus ID** (slave address), **baud rate**,
**parity** and **stop bits**. Meters on one RS485 line must share the same baud rate and parity and each needs a different ID.

**Steps**

1. **Remove demo machines** (the box at the top). The simulated machines and their made-up history are removed so totals,
   reports and Insights show only real data. Panels, branding, users and shifts stay.
2. **Connections**: the page lists the serial (COM) ports it finds on this PC, such as *COM4 (USB-SERIAL CH340)*.
   Put that port in the RS485 connection with the meters' baud rate, parity and stop bits. For an Ethernet meter or a
   gateway, choose that type and type its IP address (port 502 unless changed).
3. **Add machine**: name, area, connection, **meter model**, **Modbus address (slave ID)**. If it is the main grid
   incomer, set *Plant total* to *Counted*.
4. Press **Test reading**. It shows voltage, current, kW, kVA, PF, frequency and kWh: compare them with the meter's
   display. If the numbers only make sense with the two halves of each value swapped, it says so: press
   **Use this word order**. If nothing comes back, it says why in plain words (port not found or in use, no answer at
   that ID and baud rate, wrong model, IP not reachable).
5. **Save and restart logging**. The machine appears on the Plant page within seconds and is logged every minute.

The meter models in the list come from `profiles/`; a model not in the list can be added by pasting its register map
from the meter's Modbus manual under *Meter models* (address, `float32`/`int16`/`uint32`…, scale, holding or input
registers, word order). If the manual numbers registers from 1 or as 40001…, set `"address_offset": -1` or subtract 40001.

**Testing without a meter**: `python tools/fake_meter.py --port 5020` answers like an Ethernet meter on this PC
(127.0.0.1, port 5020, ID 1, model *generic_float32_template*); `--profile selec_mfm384` pretends to be that model,
`--pty` (Linux/Mac) makes a virtual RS485 port, and `--serial COM5` answers on a real serial port.

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
- Email / SMS / WhatsApp alarm alerts, monthly bill-style reports.
- The SLD PDF was cut off at the right edge: the Galvalume transformer (panel 7), the spare, the 5th 6HI feeder,
  CCL feeders O/G-7 and O/G-8, and the 5th CGL feeder are guessed or left out. Contract demand (10,000 kVA) is a guess.
- Production-per-tonne (kWh/ton) reports if furnace tonnage is entered.
