// Port of MC1Services/Services/Weather/WeatherBot.swift (docs/PORTING.md).

/**
 * A MeshWX weather bot as the app knows it from its advert (docs/MESHWX.md, spec §20): a
 * chat node named `WX-<city>` whose position rides in the advert.
 *
 * There is no discovery channel in v5. Every MeshCore app already collects adverts into
 * contacts, so "the bots I can hear" is a filter over the contact list, and the bot a
 * message came from is the first two bytes of that contact's public key.
 *
 * The value is `{ publicKey: Uint8Array, name, latitude, longitude, lastAdvert }` —
 * `lastAdvert` in milliseconds, or null when the radio has never heard it.
 *
 * Deviation: Swift has both an instance property `bot.botID` and a static
 * `WeatherBot.botID(for:)`. JS has one namespace, so the static is `botIDForKey`.
 */
export const WeatherBot = {
  /** Advert name prefix that marks a weather bot. */
  namePrefix: 'WX-',

  make({ publicKey, name, latitude, longitude, lastAdvert = null }) {
    return { publicKey, name, latitude, longitude, lastAdvert }
  },

  /**
   * A contact is a bot when its advertised name carries the prefix and a city after it.
   * `contact` is a `ContactDTO` of the radio layer, duck-typed on the Swift property names
   * (`publicKey`, `name`, `latitude`, `longitude`, `lastAdvertTimestamp` in whole seconds).
   */
  fromContact(contact) {
    if (!WeatherBot.isBotName(contact.name)) return null
    return WeatherBot.make({
      publicKey: contact.publicKey,
      name: contact.name,
      latitude: contact.latitude,
      longitude: contact.longitude,
      // An advert never heard reports 0.
      lastAdvert: contact.lastAdvertTimestamp === 0 ? null : contact.lastAdvertTimestamp * 1000
    })
  },

  id(bot) { return bot.publicKey },

  /**
   * A bot known only from its own packets: every v5 message carries the first two bytes of the
   * bot's public key (spec §2.2), and a Request datagram names the bot asked by those same two
   * bytes (§11). So a bot that has been heard can be asked without ever having been seen to
   * advertise. It has no name, no position and no full key, which is why the DM fallback, the
   * one path that needs the key, stays closed to it (`isAnnounced`).
   *
   * Found the hard way on 2026-09-21: the owner's web client sat on a radio that was itself
   * named WX-AUS, which can never hear "itself" announce, with every ask blocked.
   */
  heardOnly({ botID }) {
    return WeatherBot.make({
      publicKey: Uint8Array.of(botID & 0xff, (botID >> 8) & 0xff),
      name: '', latitude: 0, longitude: 0, lastAdvert: null
    })
  },

  /** Whether the bot's whole key is known, from an advert or a link: what a DM needs. */
  isAnnounced(bot) { return bot?.publicKey?.length === 32 },

  /**
   * The `bot` field every v5 message carries: the first two bytes of the public key as a
   * little-endian u16 (spec §2.2).
   */
  botID(bot) { return WeatherBot.botIDForKey(bot.publicKey) },

  /** Swift `WeatherBot.botID(for:)`. */
  botIDForKey(publicKey) {
    if (publicKey == null || publicKey.length < 2) return 0
    return publicKey[0] | (publicKey[1] << 8)
  },

  /** The `WX-` prefix stripped: `AUS` for `WX-AUS`. */
  city(bot) { return bot.name.slice(WeatherBot.namePrefix.length) },

  /**
   * An advert with no position reports 0,0; treat that as unknown rather than the Gulf of
   * Guinea.
   */
  hasLocation(bot) { return bot.latitude !== 0 || bot.longitude !== 0 },

  isBotName(name) {
    return typeof name === 'string'
      && name.startsWith(WeatherBot.namePrefix)
      && name.length > WeatherBot.namePrefix.length
  },

  /** Great-circle distance in metres to a point, or null when the bot has no position. */
  distance(bot, { fromLatitude, longitude }) {
    if (!WeatherBot.hasLocation(bot)) return null
    return WeatherBot.haversineMetres({
      lat1: fromLatitude, lon1: longitude, lat2: bot.latitude, lon2: bot.longitude
    })
  },

  /**
   * The bots among `from`, nearest to `near` first (spec §20: "show the nearest; let the user
   * pick"). Bots without a position sort after every located one, alphabetically; with no
   * reference location the whole list is alphabetical so the order is at least stable.
   */
  bots({ from, near = null }) {
    const bots = []
    for (const contact of from) {
      const bot = WeatherBot.fromContact(contact)
      if (bot != null) bots.push(bot)
    }
    const distanceOf = (bot) => near == null
      ? null
      : WeatherBot.distance(bot, { fromLatitude: near.latitude, longitude: near.longitude })
    return bots.sort((lhs, rhs) => {
      const left = distanceOf(lhs)
      const right = distanceOf(rhs)
      if (left != null && right != null && left !== right) return left - right
      if (left != null && right == null) return -1
      if (left == null && right != null) return 1
      return lhs.name.localeCompare(rhs.name, undefined, { sensitivity: 'base' })
    })
  },

  haversineMetres({ lat1, lon1, lat2, lon2 }) {
    const earthRadius = 6_371_000
    const dLat = ((lat2 - lat1) * Math.PI) / 180
    const dLon = ((lon2 - lon1) * Math.PI) / 180
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
      + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180)
        * Math.sin(dLon / 2) * Math.sin(dLon / 2)
    return 2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  }
}
