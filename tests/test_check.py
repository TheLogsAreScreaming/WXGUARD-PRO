"""`meshcore-weather --check` (phase 1, item 8): the report a new operator
runs before going on air. Exit 1 on any error; never transmits."""

import io
import sys
from unittest.mock import AsyncMock, MagicMock

import pytest

from meshcore_weather import cli_check, config
from meshcore_weather.config import settings
from meshcore_weather.geodata import resolver
from meshcore_weather.protocol import coverage as cov_mod


@pytest.fixture(autouse=True)
def _wx_aus(tmp_path, monkeypatch):
    """WX-AUS's own settings, as its .env has them, with the radio on a TCP
    bridge so the serial check does not depend on this machine's ports."""
    monkeypatch.chdir(tmp_path)
    for key, val in {"home_cities": "Austin TX", "home_radius_km": 120, "home_states": "", "home_wfos": "",
                     "coverage": "", "reply_mode": "channel", "portal_enabled": True, "portal_host": "127.0.0.1",
                     "portal_port": 8081, "tx_enabled": True, "status_channel": "#meshwx-status",
                     "meshcore_channel": "#meshwx", "meshwx_channel": "#meshwx", "emwin_source": "internet",
                     "serial_port": "tcp://127.0.0.1:4403", "admin_key": "0123456789ab", "radio_region": "US",
                     "timezone": "America/Chicago", "mqtt_enabled": False, "mqtt_iata": "",
                     "bridge_token": "", "radar_dir": ""}.items():
        monkeypatch.setattr(settings, key, val)
    # A private attribute is kept in __pydantic_private__, not __dict__, and
    # pytest 9.2's setattr undo deletes it instead of putting it back, which
    # leaves `settings.rejected` broken for every test after this file.
    monkeypatch.setitem(settings.__pydantic_private__, "_rejected", [])
    monkeypatch.setattr(config, "_tz_from_home", False)
    resolver.load()
    monkeypatch.setattr(resolver, "_home", resolver._home)
    cov_mod.forget_config_build()
    yield
    cov_mod.forget_config_build()


def _run(monkeypatch, argv=("--no-radio",), node=None):
    if node is not None:
        monkeypatch.setattr(cli_check, "read_node", AsyncMock(return_value=node))
    out = io.StringIO()
    code = cli_check.run(list(argv), out=out)
    return code, out.getvalue()


def test_wx_aus_passes(monkeypatch):
    code, text = _run(monkeypatch)
    assert code == 0, text
    assert "OK     Coverage      36 zones" in text and "Austin, TX (30.2672, -97.7431)" in text
    assert "WARN   Reply mode" in text                      # channel mode is a warning, not an error
    assert "0 error(s)" in text and settings.tx_enabled     # the setting is restored after the check


def test_a_bad_home_city_fails_with_exit_1(monkeypatch):
    monkeypatch.setattr(settings, "home_cities", "Austn TX")
    code, text = _run(monkeypatch)
    assert code == 1 and "ERROR  Coverage      home city 'Austn TX'" in text
    assert "MCW_TX_ENABLED is true, so the bot would go on air with them" in text


def test_no_coverage_and_no_timezone_are_errors(monkeypatch):
    monkeypatch.setattr(settings, "home_cities", "")
    monkeypatch.setattr(settings, "timezone", "")
    code, text = _run(monkeypatch)
    assert code == 1 and "MCW_COVERAGE=national" in text and "ERROR  Time zone" in text


def test_the_timezone_is_taken_from_the_home_city(monkeypatch):
    monkeypatch.setattr(settings, "home_cities", "Denver CO")
    monkeypatch.setattr(settings, "timezone", "")
    code, text = _run(monkeypatch)
    assert code == 0 and "OK     Time zone     America/Denver, from the home city's state (CO)" in text
    monkeypatch.setattr(settings, "timezone", "America/Chicgo")
    assert "is not an IANA zone" in _run(monkeypatch)[1]


def test_settings_a_new_operator_gets_wrong(monkeypatch, tmp_path):
    monkeypatch.setitem(settings.__pydantic_private__, "_rejected",
                        ["MCW_ADMIN_KEY ignored: 3 hex characters is too short"])
    monkeypatch.setattr(settings, "admin_key", "")
    monkeypatch.setattr(settings, "status_channel", "#meshwx")
    monkeypatch.setattr(settings, "radio_region", "ZZ")
    monkeypatch.setattr(settings, "emwin_source", "sdr")
    monkeypatch.setattr(settings, "sdr_emwin_dir", str(tmp_path / "nowhere"))
    monkeypatch.setattr(settings, "serial_port", str(tmp_path / "ttyUSB9"))
    monkeypatch.setattr(settings, "portal_host", "0.0.0.0")
    code, text = _run(monkeypatch)
    assert code == 1
    for needle in ("ERROR  Admin key", "ERROR  Channels      MCW_STATUS_CHANNEL", "ERROR  Region",
                   "ERROR  EMWIN", "ERROR  Serial port", "WARN   Portal        listens on every interface"):
        assert needle in text, needle


def test_the_node_is_checked_when_it_can_be_read(monkeypatch):
    code, text = _run(monkeypatch, argv=(), node=({"name": "WX-AUS", "radio_freq": 910.525, "radio_bw": 62.5,
                                                   "radio_sf": 7, "radio_cr": 5}, "from the running bot's portal"))
    assert code == 0 and "OK     Node name     WX-AUS" in text and "910.525 MHz" in text
    code, text = _run(monkeypatch, argv=(), node=({"name": "Bob's node", "radio_freq": 869.525, "radio_bw": 62.5},
                                                  "read from /dev/ttyUSB0"))
    assert code == 1 and "WARN   Node name" in text and "ERROR  Node radio    869.525 MHz is outside the US band" in text


def test_mqtt_needs_a_region_code(monkeypatch):
    monkeypatch.setattr(settings, "mqtt_enabled", True)
    code, text = _run(monkeypatch, argv=(), node=({"name": "Bob", "radio_freq": 910.525, "radio_bw": 62.5}, "x"))
    assert code == 1 and "ERROR  MQTT" in text
    code, text = _run(monkeypatch, argv=(), node=({"name": "WX-DEN", "radio_freq": 910.525, "radio_bw": 62.5}, "x"))
    assert code == 0 and "topic region DEN" in text


@pytest.mark.asyncio
async def test_a_port_another_process_holds_is_never_opened(monkeypatch, tmp_path):
    port = tmp_path / "ttyUSB0"
    port.write_text("")
    monkeypatch.setattr(settings, "serial_port", str(port))
    monkeypatch.setattr(settings, "portal_enabled", False)
    monkeypatch.setattr(cli_check, "_port_holders", lambda p: ["4242"])
    import meshcore_weather.meshcore.radio as radio_mod
    monkeypatch.setattr(radio_mod, "_open_serial", AsyncMock(side_effect=AssertionError("opened a held port")))
    info, how = await cli_check.read_node()
    assert info is None and "in use by PID 4242" in how


@pytest.mark.asyncio
async def test_a_free_port_is_read_without_transmitting(monkeypatch, tmp_path):
    port = tmp_path / "ttyUSB0"
    port.write_text("")
    monkeypatch.setattr(settings, "serial_port", str(port))
    monkeypatch.setattr(settings, "portal_enabled", False)
    monkeypatch.setattr(cli_check, "_port_holders", lambda p: [])
    mc = MagicMock()
    mc.self_info = {"name": "WX-AUS", "radio_freq": 910.525}
    mc.disconnect = AsyncMock()
    import meshcore_weather.meshcore.radio as radio_mod
    monkeypatch.setattr(radio_mod, "_open_serial", AsyncMock(return_value=mc))
    info, how = await cli_check.read_node()
    assert info["name"] == "WX-AUS" and "nothing sent on air" in how
    mc.disconnect.assert_awaited()
    assert not mc.commands.send_advert.called and not mc.commands.send_chan_msg.called


def test_the_entry_points(monkeypatch):
    calls = []
    monkeypatch.setattr(cli_check, "run", lambda argv, out=None: calls.append(argv) or 1)
    from meshcore_weather import cli, main
    monkeypatch.setattr(sys, "argv", ["meshcore-weather", "--check", "--no-radio"])
    assert main.main() == 1
    monkeypatch.setattr(sys, "argv", ["meshcore-weather-cli", "check", "--no-radio"])
    with pytest.raises(SystemExit) as e:
        cli.main()
    assert e.value.code == 1 and calls == [["--no-radio"], ["--no-radio"]]
