"""Saint / Fort / Mount, written either way.

The places table spells "ST. LOUIS", "SAINT PAUL", "FORT WORTH", "MOUNT
PLEASANT"; people type "st louis", "ft worth", "mt pleasant". Before,
"st louis mo" resolved to nothing and "saint louis mo" to Lake Saint Louis
(a suburb, matched as a substring); "st petersburg fl", "st paul mn",
"ft lauderdale fl", "ft myers fl" and "mt pleasant sc" to nothing.
"""

import pytest

from meshcore_weather.core.render_text import place_label
from meshcore_weather.geodata import _normalize, resolver
from tests.test_core import AUSTIN


@pytest.fixture(autouse=True)
def _home():
    resolver.load()
    resolver.set_home(*AUSTIN)
    yield
    resolver._home = None


def test_both_spellings_read_alike():
    assert _normalize("St. Louis") == _normalize("st louis") == _normalize("Saint Louis") == "SAINT LOUIS"
    assert _normalize("Ste. Genevieve") == _normalize("sainte genevieve") == "SAINTE GENEVIEVE"
    assert _normalize("Ft Worth") == _normalize("FORT WORTH") == "FORT WORTH"
    assert _normalize("Mt. Pleasant") == _normalize("mount pleasant") == "MOUNT PLEASANT"
    assert _normalize("Mountain View") == "MOUNTAIN VIEW" and _normalize("Stanton") == "STANTON"


@pytest.mark.parametrize("query,name,zone", [
    ("st louis mo", "St. Louis, MO", "MOZ064"),
    ("saint louis mo", "St. Louis, MO", "MOZ064"),
    ("st. louis mo", "St. Louis, MO", "MOZ064"),
    ("st petersburg fl", "St. Petersburg, FL", "FLZ050"),
    ("st paul mn", "Saint Paul, MN", "MNZ062"),
    ("ft lauderdale fl", "Fort Lauderdale, FL", "FLZ172"),
    ("ft myers fl", "Fort Myers, FL", "FLZ265"),
    ("mt pleasant sc", "Mount Pleasant, SC", "SCZ045"),
    ("fort worth tx", "Fort Worth, TX", "TXZ118"),
    ("ft worth tx", "Fort Worth, TX", "TXZ118"),
    ("ft stockton tx", "Fort Stockton, TX", "TXZ075"),
    ("ste genevieve mo", "Sainte Genevieve, MO", "MOZ075"),
    ("lake st louis mo", "Lake Saint Louis, MO", "MOZ061"),
])
def test_abbreviated_and_full_names_resolve(query, name, zone):
    r = resolver.resolve(query)
    assert r is not None and r["name"] == name and r["zones"][0] == zone


def test_whole_words_before_substrings():
    # "saint louis mo" used to be Lake Saint Louis; a name inside a longer
    # one is still found when nothing has the name itself.
    assert resolver.resolve("st louis park mn")["name"] == "Saint Louis Park, MN"
    assert resolver.resolve("round rock")["name"] == "Round Rock, TX"
    assert resolver.resolve("san marc")["name"] == "San Marcos, TX"      # prefix, as before
    assert resolver.resolve("st") is None and resolver.resolve("mt") is None


def test_ambiguity_is_still_reported():
    r = resolver.resolve("st louis")
    assert r["name"] == "St. Louis, MO" and "MI" in r["ambiguous"]
    assert "add state" in place_label(r)
