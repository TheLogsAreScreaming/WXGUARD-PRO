# Swapping the radio

How to replace the MeshCore node on the Pi, with the same board or a
different one, without the mesh noticing.

## What makes the radio "the bot"

A MeshCore node is its Ed25519 key pair, stored in the radio's flash.
Every phone that saved `WX-AUS` saved that key, and the v5 bot id in
every datagram is its first two bytes. A fresh radio has a fresh key: to
phones and to the app it is a different bot until it carries the old key.
The v5 sequence number is not in the radio: the bot keeps it on the Pi
(`data/warning_state.json`), so apps see the numbers continue after a swap.

The bot therefore keeps a **node profile** in `data/node_profile.json`
(mode 0600, git-ignored) and refreshes it after every successful connect:

| Field | From | Restored how |
|-------|------|--------------|
| private key (64 bytes) | companion `export_private_key` | `import_private_key` |
| name, position | self info | `set_name`, `set_coords` |
| frequency, bandwidth, SF, CR | self info | `set_radio` |
| TX power | self info | `set_tx_power`, capped at the new board's maximum |
| path hash size (1, 2 or 3 bytes) | device info, version 10 on | `set_path_hash_mode`; a board whose firmware lacks it stays at 1 byte and says so |
| contacts (people only, newest 200) | contact table | `add_contact` each |

Channels are not in the profile: the bot creates `#meshwx` on any node
that lacks it (and the status channel, `MCW_STATUS_CHANNEL`, when one is
set), and MeshCore derives a hashtag channel's key from its name,
so the new radio gets the identical key on its own.

When a radio answers on the port with a key that is not the profile's,
nothing is written to it. The bot connects, holds its adverts (so phones
do not learn a stranger's key under the bot's name) and shows the radio
under Radio › Hardware and swap as "Different radio" with two choices:

- **Adopt**: write the profile onto it (key, name, position, LoRa
  settings, TX power, path hash size, contacts), reboot it, reconnect and check that the
  node now reports the profile's key. The result goes into the profile's
  history and shows on the card.
- **Forget the old node, start a new profile**: keep the radio's own
  identity and save it as the profile. People re-add the bot from its
  next advert.

`MCW_RADIO_ADOPT` (Settings › Radio link, "Replacement radio"):

- `manual` (default): ask first, as above.
- `auto`: adopt on the first connect without asking. Two failed attempts
  on the same radio stop the automation; the portal then offers the button.
- `off`: never adopt. The profile is still refreshed.

## The swap, step by step

1. **Check the profile exists** under Radio › Hardware: it must say
   "identity key saved". If it says the firmware refused the export, the
   old node's identity cannot be moved; the replacement starts as a new
   bot (see "Starting over" below).
2. **Flash the new board** with MeshCore **Companion Radio (USB)**
   firmware, 1.15 or newer, from https://config.meshcore.io (the web
   flasher). Do not configure anything in the flasher: name, position and
   radio settings come from the profile.
3. **Power off the old radio.** Two nodes with one key would both answer
   and both repeat; the mesh dedupes by hash, but ACKs and paths get
   confused. Never run both.
4. **Plug the new board into the Pi** and restart the bot:

   ```bash
   sudo systemctl restart meshcore-weather
   ```

   Or just unplug the old radio and plug in the new one: the bot notices
   the lost link and reconnects on its own within about a minute. Either
   way it opens the configured port, or scans every USB serial port when
   that one is missing or silent (a different USB chip gets a different
   device name), finds the companion and sees the foreign key.
5. **Adopt** under Radio › Hardware: the card says "Different radio" and
   names both nodes. Click **Adopt: make this radio the bot**. The bot
   writes the profile, reboots the node and reconnects; about 20 seconds.
6. **Confirm** on the same card: the board model, "Last adoption: ok",
   and the public key under Identity matching the profile. Then
   Radio › Health › **Test transmit**: an echo within a few seconds means
   the new radio is getting out.
7. If the port name changed, set `MCW_SERIAL_PORT` under System ›
   Settings to what Hardware shows as "on", or install the udev rule below
   and use `/dev/meshcore`.

Phones keep their saved contact; the app keeps its bot id; nobody has to
do anything.

## A different board model

Anything running the Companion Radio USB firmware works: Heltec V3 / V3.2,
LilyGo T3S3 / T-Beam, RAK4631 WisBlock, Seeed XIAO nRF52840 with the
Wio-SX1262, Heltec T114 and so on. What changes between boards:

- **USB chip and device name.** CP210x boards appear as `/dev/ttyUSB0`,
  CH9102 and native-USB ESP32-S3 boards as `/dev/ttyACM0`, nRF52 boards as
  `/dev/ttyACM0`. The port scan handles it; `deploy/99-meshcore-radio.rules`
  gives every one of them the stable name `/dev/meshcore`:

  ```bash
  sudo cp deploy/99-meshcore-radio.rules /etc/udev/rules.d/ && sudo udevadm control --reload-rules && sudo udevadm trigger && ls -l /dev/meshcore
  ```

- **Maximum TX power.** The profile's power is applied up to the new
  board's ceiling (the firmware reports it). A lower ceiling is noted in
  the adoption steps.
- **Path hash size.** How many bytes each repeater adds to the path of
  a packet the node originates (Radio › LoRa and transmit). It rides in
  the profile because a replacement radio comes up at 1 byte, and CoreScope
  would quietly lose the repeater detail the larger size was set for. A
  board whose firmware has no such setting refuses it and stays at 1 byte;
  the adoption steps say so.
- **Reset on port open.** ESP32 boards reboot when the port is opened
  (DTR/RTS); the bot waits for that. nRF52 boards do not, and answer at
  once.
- **Contact capacity.** The firmware reports it (350 on a Heltec V3, less
  on some nRF52 builds); housekeeping uses the reported figure.
- **Battery reading.** Only meaningful on boards with a battery sensor;
  the Health card ignores it.
- **BLE-only builds** never answer on serial. It must be the USB variant.

## Reading the Health card

| Verdict | Meaning | Do |
|---------|---------|----|
| OK | the last send was echoed | nothing |
| idle | no sends yet; hearing traffic | nothing |
| TX off | transmit is switched off | nothing, or enable it |
| **TX suspect** | 3+ sends in a row got no echo while other nodes' repeats were heard | run Test transmit twice; if both fail, swap the radio |
| **hearing nothing** | no packet from anyone for the configured time (default 30 min) | check the antenna, then Test transmit; a deaf radio is a dead radio |
| unclear | sends unheard, and either no repeater was heard or this bot's own event loop was stalling | check the Loop lag tile first, then CoreScope |

The node's own counters sit under the verdict: a noise floor far above
the usual −110 to −120 dBm on a quiet channel (the tile turns amber above
−95 dBm) means interference or a failing front end; airtime totals reset
on reboot.

**Loop lag** is the tile to read before blaming the radio. The bot runs the
EMWIN parser, the portal and the schedulers on one thread, so a long
synchronous stretch delays the handler that matches a repeater's echo. A
packet the mesh repeated then looks unrepeated, and the whole message goes
out a second time for nothing. Two things keep that from happening: the
store never re-parses a product it already holds, and the echo window is
extended by however long the loop actually spent blocked. When lag passes
2% of wall-clock time the verdict says so instead of accusing the
transmitter. Anything above zero for more than a moment is worth a look.

The echo window itself defaults to 8 seconds. Measured echoes on the Austin
mesh arrive inside about 4 seconds on an unloaded loop, so the old 5-second
window left no margin and roughly a third of replies were flooded twice.

The 24-hour delivery window survives restarts (`data/delivery_outcomes.json`).

## Starting over on purpose

To give the bot a new identity (a compromised key, or a profile without
one): plug the new radio in, open Radio › Hardware and click "Forget the
old node, start a new profile". The bot saves the new radio as the profile
and adverts; people re-add the bot from the new advert.

## Troubleshooting

- **"Different radio" and no Adopt button**: the profile has no identity
  key (the old node's firmware refused the export). Start a new profile.
- **"Different radio" stays after adoption**: open Hardware, read the last
  adoption note. "node refused the identity key" means the firmware build
  has key import disabled; use a stock Companion Radio USB build.
- **Adopted, but phones still cannot DM the bot**: the node adverts a few
  seconds after connecting; give it a minute, or press Send advert.
- **Radio not found at all**: the log shows every port tried. Check `ls
  /dev/serial/by-id/`; a board in bootloader mode (double-tapped reset)
  shows up as a different device, press reset once.
