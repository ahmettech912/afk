'use strict'
// Codec doğrulama testi: node test/codec.test.js
const { Codec, varint } = require('../resources/codec.js')
const mcData = require('minecraft-data')

const versions = ['1.8.8', '1.12.2', '1.16.5', '1.19.4', '1.20.4', '1.21.1', '1.21.2', '1.21.4', '1.21.11']
let failures = 0

for (const v of versions) {
  try {
    const c = new Codec(v)
    const cb = (s, n) => c.id(s, 'toClient', n)
    const sb = (s, n) => c.id(s, 'toServer', n)
    const pos = cb('play', 'position')
    const ka = cb('play', 'keep_alive')
    const ping = cb('play', 'ping') ?? cb('play', 'transaction')
    const pl = sb('play', 'position_look')
    if (ka === undefined || pl === undefined || ping === undefined) throw new Error('critical id missing')
    const anim = c.defaults('play', 'toServer', 'arm_animation')
    const fields = c.fields('play', 'toServer', 'position_look')
    const vals = { x: 8, y: 64, z: 8, yaw: 0, pitch: 0 }
    if (fields.some((f) => f.name === 'onGround')) vals.onGround = false
    const flagsField = fields.find((f) => f.name === 'flags')
    if (flagsField) {
      vals.flags = c.typeKind('play', 'toServer', flagsField.type) === 'bitflags' ? { onGround: false } : 0
    }
    const dec = c.decode('play', 'toServer', 'position_look', c.encode('play', 'toServer', 'position_look', vals))
    if (dec.y !== 64) throw new Error('position_look roundtrip fail')
    const st = c.defaults('play', 'toServer', 'settings')
    Object.assign(st, { locale: 'en_us', viewDistance: 10, chatFlags: 0, chatColors: true, skinParts: 0x7f, mainHand: 1, enableTextFiltering: false, enableServerListing: false })
    const stEnc = c.encode('play', 'toServer', 'settings', st)
    const brand = Buffer.from('vanilla')
    const ch = c.data.version.version >= 393 ? 'minecraft:brand' : 'MC|Brand'
    const bp = c.encode('play', 'toServer', 'custom_payload', { channel: ch, data: Buffer.concat([varint(brand.length), brand]) })
    const pongName = sb('play', 'pong') !== undefined ? 'pong' : 'transaction'
    const pongVals = pongName === 'pong' ? { id: 42 } : { windowId: 0, action: 42, accepted: true }
    c.decode('play', 'toServer', pongName, c.encode('play', 'toServer', pongName, pongVals))
    // configuration state (>=1.20.2)
    if (c.data.protocol.configuration) {
      const cst = c.defaults('configuration', 'toServer', 'settings')
      Object.assign(cst, { locale: 'en_us', viewDistance: 10, chatFlags: 0, chatColors: true, skinParts: 0x7f, mainHand: 1, enableTextFiltering: false, enableServerListing: false })
      c.encode('configuration', 'toServer', 'settings', cst)
      c.encode('configuration', 'toServer', 'custom_payload', { channel: 'minecraft:brand', data: Buffer.concat([varint(brand.length), brand]) })
      if (sb('configuration', 'finish_configuration') === undefined) throw new Error('cfg finish id missing')
    }
    // multi_block_change decode (modern packed records)
    if (c.data.version.version >= 735) {
      const mbc = c.encode('play', 'toClient', 'multi_block_change', { chunkCoordinates: { x: 0, z: 0, y: 0 }, records: [1 << 12] })
      const md = c.decode('play', 'toClient', 'multi_block_change', mbc)
      if (!md.records || md.records.length !== 1) throw new Error('mbc roundtrip fail')
    }
    const authoritative = (mcData.versionsByMinecraftVersion.pc[v] || {}).version
    console.log(v.padEnd(8), 'exact=' + c.exact, 'layout=' + c.data.version.minecraftVersion, 'proto=' + c.data.version.version, '(authoritative ' + authoritative + ')', 'pos=0x' + (pos ?? 0).toString(16), 'ping=' + ping, 'animHand=' + ('hand' in anim), 'settings=' + stEnc.length + 'B', 'OK')
    if (authoritative && c.data.version.version !== authoritative) throw new Error('layout protocol mismatch vs authoritative table')
  } catch (e) {
    failures++
    console.error(v, 'FAIL:', e.message)
  }
}

// bilinmeyen sürüm + protokol ipucu -> en yakın bilinen düzeni ödünç al
try {
  const f = new Codec('1.21.99', { protocol: 999 })
  if (f.exact) throw new Error('should not be exact')
  console.log('fallback borrow ->', f.data.version.minecraftVersion, 'OK')
} catch (e) { failures++; console.error('fallback FAIL:', e.message) }

// 1.21.2+ ek paketleri
try {
  const n = new Codec('1.21.4')
  if (n.id('play', 'toServer', 'tick_end') === undefined) throw new Error('tick_end missing')
  if (n.id('play', 'toServer', 'player_input') === undefined) throw new Error('player_input missing')
  const pi = n.encode('play', 'toServer', 'player_input', { inputs: { forward: true } })
  if (!pi.length) throw new Error('player_input empty')
  console.log('1.21.4 tick_end/player_input OK')
} catch (e) { failures++; console.error('1.21.4 extras FAIL:', e.message) }

if (failures) { console.error(failures + ' FAILURES'); process.exit(1) }
console.log('ALL CODEC TESTS OK')
