'use strict'
// ============================================================
//  resources/codec.js
//  Dynamic packet codec for sonar-bypass.
//
//  API (same as the original extracted codec):
//    new Codec(versionString, { protocol: protocolNumber })
//    codec.id(state, direction, name)        -> packet id | undefined
//    codec.encode(state, direction, name, v) -> payload Buffer (no id)
//    codec.decode(state, direction, name, b) -> parsed object
//    codec.defaults(state, direction, name)  -> default values object
//    codec.fields(state, direction, name)    -> [{name, type}, ...]
//    codec.exact                             -> version known to minecraft-data?
//    codec.data                              -> minecraft-data instance
//
//  Everything is resolved from minecraft-data's protocol.json, so no
//  packet id or payload layout is hardcoded for any version.
//  If the exact version is unknown (brand-new release), the nearest
//  known protocol layout is borrowed; the handshake still uses the
//  real protocol number (handled by the caller).
// ============================================================

const mcData = require('minecraft-data')
const { ProtoDef } = require('protodef')
// same extra natives minecraft-protocol's serializer registers (restBuffer, varlong, UUID, ...)
const mcNatives = require('minecraft-protocol/src/datatypes/minecraft')
const nbt = require('prismarine-nbt')

function tryData (v) {
  try { return mcData(v) || null } catch (e) { return null }
}

function resolveData (version, protocolHint) {
  const table = mcData.versionsByMinecraftVersion.pc
  const authoritative = (table[version] && table[version].version) || protocolHint || null
  const exact = tryData(version)
  if (exact && exact.protocol) {
    if (!authoritative || exact.version.version === authoritative) return { data: exact, exact: true }
    // minecraft-data sometimes ships a stale protocol copy under a newer name
    // (e.g. '1.21.2' internally holds 1.21/767 data). Find a sibling release
    // whose data actually matches the authoritative protocol number.
    const siblings = Object.keys(table).filter((v) => table[v].version === authoritative && v.indexOf('-') === -1)
    for (const s of siblings) {
      const d = tryData(s)
      if (d && d.protocol && d.version.version === authoritative) return { data: d, exact: false }
    }
    // no exact layout exists anywhere -> borrow nearest below
  }

  // Fallback: borrow the nearest known release layout <= the real protocol.
  // Some listed releases (e.g. brand-new 26.x) have no loadable data yet - skip them.
  const hint = authoritative || protocolHint
  const releases = mcData.versions.pc
    .filter((v) => v.releaseType === 'release')
    .sort((a, b) => b.version - a.version)
  if (!releases.length) throw new Error('minecraft-data has no known versions')

  const candidates = hint ? releases.filter((v) => v.version <= hint) : releases
  for (const v of candidates) {
    const data = tryData(v.minecraftVersion)
    if (data && data.protocol) return { data, exact: false }
  }
  for (const v of releases) {
    const data = tryData(v.minecraftVersion)
    if (data && data.protocol) return { data, exact: false }
  }
  throw new Error('no loadable minecraft-data fallback found')
}

// ---- default value synthesis (so encode() never misses a required field) ----
function defaultFor (type, types) {
  if (typeof type === 'string') {
    switch (type) {
      case 'varint': case 'varlong': case 'optvarint':
      case 'u8': case 'u16': case 'u32': case 'u64':
      case 'i8': case 'i16': case 'i32': case 'i64':
      case 'f32': case 'f64': case 'li8': case 'li16': case 'li32':
      case 'lu8': case 'lu16': case 'lu32':
        return 0
      case 'bool': return false
      case 'string': case 'pstring': return ''
      case 'UUID': return '00000000-0000-0000-0000-000000000000'
      case 'buffer': case 'restBuffer': case 'ByteArray': return Buffer.alloc(0)
      case 'position': return { x: 0, y: 0, z: 0 }
      case 'void': return undefined
      case 'slot': return null
      default:
        if (types && types[type] !== undefined) return defaultFor(types[type], types)
        return undefined
    }
  }
  if (Array.isArray(type)) {
    const kind = type[0]
    const args = type[1]
    switch (kind) {
      case 'container': {
        const out = {}
        for (const f of args || []) out[f.name] = defaultFor(f.type, types)
        return out
      }
      case 'array': return []
      case 'buffer': return Buffer.alloc(0)
      case 'mapper': {
        // protodef mapper write expects the mapped NAME, not the number
        const m = (args && args.mappings) || {}
        const first = Object.keys(m)[0]
        return first !== undefined ? m[first] : 0
      }
      case 'bitfield': {
        const out = {}
        for (const f of args || []) out[f.name] = 0
        return out
      }
      case 'bitflags': {
        const out = {}
        const flags = (args && args.flags) || []
        for (const f of flags) out[typeof f === 'string' ? f : f.name] = false
        return out
      }
      case 'option': return undefined
      case 'switch': return undefined // needs compareTo context; caller must supply
      case 'pstring': return ''
      default: return undefined
    }
  }
  return undefined
}

class Codec {
  constructor (version, opts) {
    opts = opts || {}
    const r = resolveData(version, opts.protocol)
    this.data = r.data
    this.exact = r.exact
    this._protos = {}
    this._ids = {}
    this._defaults = {}
  }

  _stateTypes (state, direction) {
    const st = this.data.protocol[state]
    if (!st || !st[direction]) return null
    return st[direction].types
  }

  _proto (state, direction) {
    const key = state + '.' + direction
    if (this._protos[key]) return this._protos[key]
    const types = this._stateTypes(state, direction)
    if (!types) return null
    const p = new ProtoDef(false)
    p.addTypes(mcNatives)
    const addNbt = nbt.addTypesToInterpreter || nbt.addTypesToInterperter
    if (addNbt) addNbt('big', p)
    p.addProtocol(this.data.protocol, [state, direction])
    this._protos[key] = p
    return p
  }

  _typeDef (state, direction, key) {
    const types = this._stateTypes(state, direction)
    if (types && types[key] !== undefined) return types[key]
    const common = this.data.protocol.types
    if (common && common[key] !== undefined) return common[key]
    return undefined
  }

  _payloadKey (state, direction, name) {
    const types = this._stateTypes(state, direction)
    if (!types) return null
    // authoritative: the packet mapper's switch tells us the exact type key
    // (not always 'packet_' + name, e.g. settings -> packet_common_settings,
    //  which may live in the shared/common types instead of the state types)
    if (types.packet && types.packet[1] && types.packet[1][1]) {
      const sw = types.packet[1][1]
      const fields = sw.type && sw.type[1] && sw.type[1].fields
      if (fields && typeof fields[name] === 'string' && this._typeDef(state, direction, fields[name]) !== undefined) {
        return fields[name]
      }
    }
    if (this._typeDef(state, direction, 'packet_' + name) !== undefined) return 'packet_' + name
    if (this._typeDef(state, direction, name) !== undefined) return name
    return null
  }

  // follow named-type aliases ("MovementFlags" -> ["bitflags", {...}])
  resolveType (state, direction, type) {
    let t = type
    const seen = new Set()
    while (typeof t === 'string' && !seen.has(t)) {
      seen.add(t)
      const def = this._typeDef(state, direction, t)
      if (def === undefined) break
      t = def
    }
    return t
  }

  typeKind (state, direction, type) {
    const t = this.resolveType(state, direction, type)
    if (Array.isArray(t)) return t[0]
    return typeof t === 'string' ? t : null
  }

  id (state, direction, name) {
    const key = state + '.' + direction
    if (!this._ids[key]) {
      const types = this._stateTypes(state, direction)
      const map = {}
      if (types && types.packet) {
        // packet = ["container", [{name:"name", type:["mapper",{mappings:{...}}]}, ...]]
        const nameField = types.packet[1][0]
        const mappings = nameField.type[1].mappings
        for (const [hex, n] of Object.entries(mappings)) map[n] = parseInt(hex, 16)
      }
      this._ids[key] = map
    }
    return this._ids[key][name]
  }

  fields (state, direction, name) {
    const key = this._payloadKey(state, direction, name)
    if (!key) return []
    const t = this._typeDef(state, direction, key)
    if (Array.isArray(t) && t[0] === 'container') return t[1]
    return []
  }

  defaults (state, direction, name) {
    const ck = state + '.' + direction + '.' + name
    if (this._defaults[ck] !== undefined) return JSON.parse(JSON.stringify(this._defaults[ck]))
    const key = this._payloadKey(state, direction, name)
    let out = {}
    if (key) {
      const merged = Object.assign({}, this.data.protocol.types, this._stateTypes(state, direction))
      const d = defaultFor(this._typeDef(state, direction, key), merged)
      if (d && typeof d === 'object' && !Buffer.isBuffer(d)) out = d
    }
    // strip undefined (option fields) so Object.assign overrides stay clean
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
    this._defaults[ck] = out
    return JSON.parse(JSON.stringify(out))
  }

  encode (state, direction, name, values) {
    const proto = this._proto(state, direction)
    const key = this._payloadKey(state, direction, name)
    if (!proto || !key) throw new Error('unknown packet ' + state + '/' + direction + '/' + name)
    const vals = Object.assign(this.defaults(state, direction, name), values || {})
    return proto.createPacketBuffer(key, vals)
  }

  decode (state, direction, name, buf) {
    const proto = this._proto(state, direction)
    const key = this._payloadKey(state, direction, name)
    if (!proto || !key) throw new Error('unknown packet ' + state + '/' + direction + '/' + name)
    return proto.parsePacketBuffer(key, buf).data
  }
}

// ---- varint helper (same as original) ----
function varint (value) {
  const bytes = []
  let v = value >>> 0
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v !== 0) b |= 0x80
    bytes.push(b)
  } while (v !== 0)
  return Buffer.from(bytes)
}

module.exports = { Codec, varint }
