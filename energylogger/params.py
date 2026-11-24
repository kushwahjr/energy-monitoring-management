"""The electrical parameters the logger stores for every meter.

Each key is a column in the readings table. Meter profiles map these keys to
Modbus registers. A profile does not have to provide every parameter.
"""

PARAMS = {
    "v_ln": {"label": "Voltage L-N avg", "unit": "V"},
    "v_ll": {"label": "Voltage L-L avg", "unit": "V"},
    "v1": {"label": "Voltage R-N", "unit": "V"},
    "v2": {"label": "Voltage Y-N", "unit": "V"},
    "v3": {"label": "Voltage B-N", "unit": "V"},
    "i_avg": {"label": "Current avg", "unit": "A"},
    "i1": {"label": "Current R", "unit": "A"},
    "i2": {"label": "Current Y", "unit": "A"},
    "i3": {"label": "Current B", "unit": "A"},
    "kw": {"label": "Active power", "unit": "kW"},
    "kva": {"label": "Apparent power", "unit": "kVA"},
    "kvar": {"label": "Reactive power", "unit": "kVAr"},
    "pf": {"label": "Power factor", "unit": ""},
    "hz": {"label": "Frequency", "unit": "Hz"},
    "kwh": {"label": "Active energy", "unit": "kWh"},
    "kvah": {"label": "Apparent energy", "unit": "kVAh"},
    "kvarh": {"label": "Reactive energy", "unit": "kVArh"},
    "thd_v": {"label": "Voltage THD", "unit": "%"},
    "thd_i": {"label": "Current THD", "unit": "%"},
}

PARAM_KEYS = list(PARAMS)
ENERGY_KEYS = ("kwh", "kvah", "kvarh")
