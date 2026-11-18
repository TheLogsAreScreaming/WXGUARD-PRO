"""Place labels (spec section 16.2): one rule for every place and town name a
reply shows, the rule apps implement, so a ZIP or a town reads the same texted
to the bot as shown in the app."""

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from meshcore_weather.core import render_text as rt
from meshcore_weather.geodata import resolver
from meshcore_weather.geodata.names import place_label, place_name, title_case

DATA = Path(__file__).resolve().parent.parent / "meshcore_weather" / "client_data"

# The same hashes are pinned in the app: MeshWXZipTests (ZIPs) and
# WeatherZipPlaceTests (towns). Labels joined by newlines, ZIPs in ZIP order,
# towns in places.json order.
ZIP_LABELS_SHA256 = "f7bed783cf389ba4e2e2a7ab8ea8d83808f635f55a4376f2ca017c7d590c505f"
TOWN_LABELS_SHA256 = "26c6cde0f481cca8377b5c491117cd89d41c1e2e9f994281419f4553978e150a"


@pytest.mark.parametrize("raw, shown", [
    ("HELL'S KITCHEN", "Hell's Kitchen"),                       # 's after a letter stays lower
    ("CENTRAL 14TH STREET / SPRING ROAD", "Central 14th Street / Spring Road"),   # ordinal after digits
    ("MCGUIRE AFB", "McGuire AFB"),                             # Mc, and an initialism
    ("VILLA HUGO II COMUNIDAD", "Villa Hugo II"),
    ("DOWNTOWN DC", "Downtown DC"),                             # the one state code that is a code
    ("H STREET NE", "H Street NE"),
    ("LA GRANGE", "La Grange"),                                 # state-code letters that are words
    ("DE QUEEN", "De Queen"),
    ("VALLEY HI", "Valley Hi"),
    ("TRUTH OR CONSEQUENCES", "Truth or Consequences"),
    ("ADJUNTAS ZONA URBANA", "Adjuntas"),                       # suffixes
    ("CABAN COMUNIDAD", "Caban"),
    ("JUNEAU CITY AND", "Juneau"),
    ("OLINDA, CDP", "Olinda"),
    ("MILFORD CITY (BALANCE)", "Milford"),
    ("NASHVILLE-DAVIDSON METROPOLITAN GOVERNMENT (BALANCE)", "Nashville-Davidson"),
    ("LEXINGTON-FAYETTE URBAN COUNTY", "Lexington-Fayette"),
    ("KEARNS METRO TOWNSHIP", "Kearns"),
    ("CAMERON PARK COLONIA", "Cameron Park"),
    ("ESTANCIAS DE FLORIDA COMUNIDAD", "Estancias de Florida"),  # Puerto Rico: joining words lower,
    ("PALMAS DEL MAR", "Palmas del Mar"),
    ("BAYOU LA BATRE", "Bayou La Batre"),                       # articles keep their capital
    ("DEL RIO", "Del Rio"),                                     # and so does a first word
    ("LAKE OF THE WOODS", "Lake of the Woods"),
    ("MANCHESTER-BY-THE-SEA", "Manchester-by-the-Sea"),
    ("O'FALLON", "O'Fallon"),                                   # apostrophes and the ʻokina
    ("D'IBERVILLE", "D'Iberville"),
    ("LAND O' LAKES", "Land O' Lakes"),
    ("‘EWA GENTRY", "‘Ewa Gentry"),
    ("KAPA‘A", "Kapa‘a"),
    ("KO ʻOLINA-HONOKAI HALE", "Ko ʻOlina-Honokai Hale"),
    ("round rock", "Round Rock"),
])
def test_place_name(raw, shown):
    assert place_name(raw) == shown
    assert place_name(shown) == shown                 # any casing in, the same out


def test_title_case_keeps_suffixes_and_labels_add_state_and_zip():
    assert title_case("ADJUNTAS ZONA URBANA") == "Adjuntas Zona Urbana"
    assert place_label("SAN JUAN ZONA URBANA", "PR") == "San Juan, PR"
    assert place_label("AUSTIN", "TX", "78701") == "Austin, TX 78701"


@pytest.mark.parametrize("zip5, label", [                 # the app's MeshWXZipTests table
    ("78701", "Austin, TX 78701"),
    ("00901", "San Juan, PR 00901"),
    ("02134", "Allston, MA 02134"),
    ("00601", "Adjuntas, PR 00601"),
    ("00603", "Caban, PR 00603"),
    ("99801", "Juneau, AK 99801"),
    ("10019", "Hell's Kitchen, NY 10019"),
    ("20010", "Central 14th Street / Spring Road, DC 20010"),
    ("00650", "Estancias de Florida, PR 00650"),
    ("08562", "McGuire AFB, NJ 08562"),
    ("96706", "‘Ewa Gentry, HI 96706"),
    ("06461", "Milford, CT 06461"),
    ("02138", "West Cambridge/Harvard Square, MA 02138"),
    ("01944", "Manchester-by-the-Sea, MA 01944"),
    ("12930", "St. Regis Falls, NY 12930"),
    ("37352", "Lynchburg, Moore County, TN 37352"),
    ("10001", "Times Square, NY 10001"),
    ("99501", "Anchorage, AK 99501"),
])
def test_zip_replies_use_the_label_rule(zip5, label):
    assert resolver.resolve(zip5)["name"] == label


def test_towns_and_nearest_places_use_the_label_rule():
    assert resolver.resolve("Adjuntas PR")["name"] == "Adjuntas, PR"
    assert resolver.resolve("Hell's Kitchen NY")["name"] == "Hell's Kitchen, NY"
    places = json.loads((DATA / "places.json").read_text())["places"]
    kitchen = next(p for p in places if p[0] == "HELL'S KITCHEN")
    assert resolver.resolve_by_coords(kitchen[2], kitchen[3])["name"] == "Hell's Kitchen, NY"


def test_storm_report_towns_and_rain_cities_use_the_rule():
    sr = SimpleNamespace(entries=[{"event": "Hail", "location": "2 N MCKINNEY", "mag": "", "state": "TX"}])
    assert rt.storm_reports("in TX", sr, state="TX").endswith(": Hail McKinney")
    ro = SimpleNamespace(cities=[{"name": "LAKE OF THE WOODS", "rain_text": "RAIN", "temp_f": 61}])
    assert rt.rain("MN", ro) == "Rain MN (1): Lake of the Woods rain 61F"


def test_every_label_matches_the_hashes_the_app_pins():
    places = json.loads((DATA / "places.json").read_text())["places"]
    zips = sorted(json.loads((DATA / "zips.json").read_text())["zips"], key=lambda r: r[0])
    zip_labels = [place_label(places[r[3]][0], places[r[3]][1], r[0]) for r in zips]
    town_labels = [place_label(p[0], p[1]) for p in places]
    assert len(zip_labels) == 33144 and len(town_labels) == 34937
    assert hashlib.sha256("\n".join(zip_labels).encode()).hexdigest() == ZIP_LABELS_SHA256
    assert hashlib.sha256("\n".join(town_labels).encode()).hexdigest() == TOWN_LABELS_SHA256
    # A ZIP reads as its town does, with the ZIP after it.
    assert all(z == f"{place_label(places[r[3]][0], places[r[3]][1])} {r[0]}" for z, r in zip(zip_labels, zips))
