"""CLI tools for testing without hardware.

Usage:
    # Fetch EMWIN data from NOAA and show what we get
    meshcore-weather-cli fetch

    # Query weather from cached/fetched data
    meshcore-weather-cli query "Buffalo NY"

    # Interactive mode - type mesh commands (wx, warn, forecast) in your terminal
    meshcore-weather-cli interactive

    # The `sat` reply: GOES receiver status from the dashboard, no EMWIN load
    meshcore-weather-cli sat

    # Check the configuration before going on air (same as meshcore-weather --check)
    meshcore-weather-cli check [--no-radio]
"""

import asyncio
import logging
import sys

from meshcore_weather.config import settings
from meshcore_weather.emwin.fetcher import create_source
from meshcore_weather.geodata import resolver
from meshcore_weather.main import WeatherBot
from meshcore_weather.nlp import parse_intent
from meshcore_weather.parser.weather import WeatherStore


def cmd_fetch():
    """Fetch EMWIN products and print what we got."""
    async def _run():
        source = create_source()
        print(f"Fetching EMWIN data from: {settings.emwin_source}")
        print(f"URL: {settings.emwin_base_url}")
        print()

        await source.start()
        products = await source.fetch_products()
        await source.stop()

        print(f"Fetched {len(products)} products:\n")
        for p in products[:30]:
            awips = p.get("awips_id", "")
            text_preview = p["raw_text"][:70].replace("\n", " ")
            print(f"  {p['product_id']:10s} {p['station']:6s} {awips:10s} | {text_preview}")

        if len(products) > 30:
            print(f"  ... and {len(products) - 30} more")

        return products

    return asyncio.run(_run())


def cmd_query(location: str):
    """Fetch data then query for a location."""
    async def _run():
        resolver.load()
        source = create_source()
        store = WeatherStore()

        print("Fetching EMWIN data...")
        await source.start()
        products = await source.fetch_products()
        await source.stop()

        if not products:
            print("No products available. Run 'fetch' first to check connectivity.")
            return

        store.ingest(products)
        print(f"Loaded {len(products)} products\n")

        print(f"--- Weather for: {location} ---")
        bot = WeatherBot()
        bot.store = store
        print(bot._process_command("wx", location))

    asyncio.run(_run())


def cmd_interactive():
    """Simulate mesh radio interaction from your terminal."""
    async def _run():
        resolver.load()
        source = create_source()
        store = WeatherStore()
        bot = WeatherBot()

        print("Fetching EMWIN data...")
        await source.start()
        products = await source.fetch_products()
        await source.stop()
        bot.emwin = source          # its newest file, for `sat`

        if products:
            store.ingest(products)
            bot.store = store
            print(f"Loaded {len(products)} products")
        else:
            print("Warning: No products fetched. Responses will show 'no data'.")

        print()
        print("=== Interactive Mesh Simulator ===")
        print("Type anything naturally or use commands. Examples:")
        print("  is it raining in austin")
        print("  any storms near miami florida")
        print("  forecast denver")
        print("  wx KAUS")
        print("  sat (satellite receiver)")
        print("  more (next page)")
        print("  help")
        print("Type 'quit' to exit.")
        print()

        while True:
            try:
                text = input("mesh> ").strip()
            except (EOFError, KeyboardInterrupt):
                print()
                break

            if not text or text.lower() == "quit":
                break

            command, location = await bot._parse(text)
            print(f"  [NLP: cmd={command} loc='{location}']")
            if command == "sat":
                await _sample_receiver(bot)
            # Same paging as a DM: "more" continues the last long reply.
            chunk, has_more = bot.reply_chunk(command, location, "cli")
            if chunk:
                print(f"\n{chunk}\n" + ("  (send 'more' for the next page)\n" if has_more else ""))
            else:
                print("\n(no response)\n")

    asyncio.run(_run())


async def _sample_receiver(bot: WeatherBot) -> None:
    """No monitor loop runs here: one dashboard read, so `sat` is current."""
    if settings.emwin_source != "sdr":
        return
    import httpx
    from meshcore_weather.sdr_monitor import SdrMonitor
    bot._sdr_monitor = bot._sdr_monitor or SdrMonitor()
    async with httpx.AsyncClient(timeout=5.0) as client:
        await bot._sdr_monitor.poll(client)


def cmd_sat():
    """Print the `sat` reply without loading EMWIN products."""
    async def _run():
        bot = WeatherBot()
        await _sample_receiver(bot)
        print(bot._process_command("sat", ""))

    asyncio.run(_run())


def cmd_contacts():
    """List all contacts on the radio device."""
    async def _run():
        from meshcore_weather.meshcore.radio import MeshcoreRadio
        radio = MeshcoreRadio()
        await radio.start()

        await radio._mc.ensure_contacts(follow=True)
        contacts = radio._mc._contacts or []
        if not contacts:
            print("No contacts on device.")
        else:
            print(f"{len(contacts)} contact(s):\n")
            for i, c in enumerate(contacts):
                name = c.get("adv_name", "?")
                key = c.get("public_key", "")[:12]
                last = c.get("last_advert", 0)
                print(f"  {i+1:3d}. {name:20s}  key={key}  last_advert={last}")
        await radio.stop()

    asyncio.run(_run())


def cmd_remove_contact(name: str):
    """Remove a contact from the radio device by name."""
    async def _run():
        from meshcore_weather.meshcore.radio import MeshcoreRadio
        radio = MeshcoreRadio()
        await radio.start()

        await radio._mc.ensure_contacts(follow=True)
        contact = radio._mc.get_contact_by_name(name)
        if not contact:
            print(f"Contact '{name}' not found.")
            await radio.stop()
            return

        key = contact.get("public_key", "")
        print(f"Removing: {contact.get('adv_name', '?')} (key={key[:12]})")
        result = await radio._mc.commands.remove_contact(key)
        print(f"Result: {result.type}")
        await radio.stop()

    asyncio.run(_run())


def cmd_clear_contacts():
    """Remove ALL contacts from the radio device."""
    async def _run():
        from meshcore_weather.meshcore.radio import MeshcoreRadio
        radio = MeshcoreRadio()
        await radio.start()

        await radio._mc.ensure_contacts(follow=True)
        contacts = radio._mc._contacts or []
        if not contacts:
            print("No contacts to remove.")
            await radio.stop()
            return

        print(f"Removing {len(contacts)} contact(s)...")
        for c in contacts:
            name = c.get("adv_name", "?")
            key = c.get("public_key", "")
            try:
                await radio._mc.commands.remove_contact(key)
                print(f"  Removed: {name}")
            except Exception as e:
                print(f"  Failed to remove {name}: {e}")
        await radio.stop()
        print("Done.")

    asyncio.run(_run())


def main():
    if sys.argv[1:2] == ["check"]:
        from meshcore_weather.cli_check import main as check_main
        sys.exit(check_main(sys.argv[2:]))
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper()),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    if len(sys.argv) < 2:
        print("Usage: meshcore-weather-cli <command> [args]")
        print()
        print("Commands:")
        print("  fetch                Fetch EMWIN products and show results")
        print("  query <location>     Fetch data and query for a location")
        print("  interactive          Simulate mesh commands from terminal")
        print("  sat                  GOES receiver status, as the sat command replies")
        print("  check [--no-radio]   Check the configuration (never transmits); exit 1 on errors")
        print()
        print("Radio admin:")
        print("  contacts             List contacts on the radio device")
        print("  remove <name>        Remove a contact by name")
        print("  clear-contacts       Remove ALL contacts")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "fetch":
        cmd_fetch()
    elif cmd == "query":
        if len(sys.argv) < 3:
            print("Usage: meshcore-weather-cli query <location>")
            sys.exit(1)
        cmd_query(" ".join(sys.argv[2:]))
    elif cmd == "interactive":
        cmd_interactive()
    elif cmd == "sat":
        cmd_sat()
    elif cmd == "contacts":
        cmd_contacts()
    elif cmd == "remove":
        if len(sys.argv) < 3:
            print("Usage: meshcore-weather-cli remove <contact name>")
            sys.exit(1)
        cmd_remove_contact(" ".join(sys.argv[2:]))
    elif cmd == "clear-contacts":
        cmd_clear_contacts()
    else:
        print(f"Unknown command: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
