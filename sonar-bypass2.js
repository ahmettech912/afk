#!/usr/bin/env node
'use strict'
// ============================================================
//  sonar-bypass.js
//  Paketler kütüphanenin write()'ı ile gider (sıkıştırma/framing
//  otomatik doğru). Cevap sırasını biz yönetiriz (vanilla taklidi).
//  Ham soket YOK -> sıkıştırma çakışması YOK.
// ============================================================
const path = require('path')
const fs = require('fs')
const mc = require('minecraft-protocol')
const mcData = require('minecraft-data')
const { Codec, varint } = require(path.join(__dirname, 'resources', 'codec.js'))

const BLOCK_DIR = path.join(__dirname, 'resources', 'blockstates')
function readJsonSafe (p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) { return null } }
const BLOCK_HEIGHTS = readJsonSafe(path.join(BLOCK_DIR, 'blockheights.json'))
const VERSION_MAP = readJsonSafe(path.join(BLOCK_DIR, 'versionmap.json'))

function deriveHeights (data) {
  const cs = data.blockCollisionShapes
  const out = {}
  if (!cs || !cs.blocks || !cs.shapes) return out
  for (const b of Object.values(data.blocksArray)) {
    const entry = cs.blocks[b.name]
    if (entry === undefined) continue
    for (let s = b.minStateId; s <= b.maxStateId; s++) {
      const shapeId = Array.isArray(entry) ? entry[s - b.minStateId] : entry
      if (shapeId === undefined) continue
      const boxes = cs.shapes[String(shapeId)] || []
      let h = 0
      for (const box of boxes) h = Math.max(h, box[4])
      if (h > 0) out[s] = h
    }
  }
  return out
}

const PASS_KICK = /successfully passed the verification|now able to play|has been verified successfully|verification successful|dogrulamayi basariyla gectin|doğrulamayı başarıyla geçtin|basariyla gectin|başarıyla geçtin|oyuna girebilirsin|dogrulama basarili|doğrulama başarılı/i
const NEG_KICK = /too fast|try again|wait|already|being verified|queued|failed|blacklist|unsupported|not verified|denied|invalid|cok hizli|çok hızlı|tekrar dene|bekle|basarisiz|başarısız|gecemedin|geçemedin/i
function isPassKick (s) { return PASS_KICK.test(String(s)) && !NEG_KICK.test(String(s)) }
function texts (o) {
  try {
    const s = JSON.stringify(o, (k, v) => typeof v === 'bigint' ? v.toString() : v)
    return [...s.matchAll(/"?(?:text|value|translate)"?\s*:\s*"([^"]*)"/g)].map((m) => m[1]).join(' | ')
  } catch (e) { return String(o) }
}

function runBypass (opts) {
  opts = opts || {}
  const HOST = opts.host || '127.0.0.1'
  const PORT = parseInt(opts.port || '25565', 10)
  const UNAME = opts.username || 'dybot'
  const VERSION = opts.version || '1.20.4'
  const RAW_LOG = !!opts.rawLog
  const TIMEOUT_MS = parseInt(opts.timeoutMs || '70000', 10)
  const log = opts.log || console.log

  return new Promise((resolve) => {
    const exact = (() => { try { return mcData(VERSION) } catch (e) { return null } })()
    const tableProto = (mcData.versionsByMinecraftVersion.pc[VERSION] || {}).version
    const REAL_PROTO = tableProto || (exact && exact.version && exact.version.version) || opts.protocol
    if (!REAL_PROTO) { log(`[!] bilinmeyen sürüm ${VERSION}`); return resolve({ status: 'error', detail: 'unknown version' }) }

    const codec = new Codec(VERSION, { protocol: REAL_PROTO })
    const CLIENT_VERSION = codec.exact ? VERSION : codec.data.version.minecraftVersion
    const SONAR_VER = VERSION_MAP ? VERSION_MAP[String(REAL_PROTO)] : null
    const HEIGHTS = (SONAR_VER && BLOCK_HEIGHTS && BLOCK_HEIGHTS[SONAR_VER]) || deriveHeights(codec.data)
    log(`[*] sürüm ${CLIENT_VERSION} (proto ${REAL_PROTO}) | blok state: ${Object.keys(HEIGHTS).length}`)

    const has = (state, dir, name) => codec.id(state, dir, name) !== undefined
    const pick = (state, dir, ...names) => names.find((n) => has(state, dir, n))

    const HELLO = has('configuration', 'toServer', 'finish_configuration') ? 'configuration' : 'play'
    const N = {
      settings: pick(HELLO, 'toServer', 'settings', 'client_information'),
      brand: pick(HELLO, 'toServer', 'custom_payload', 'brand'),
      cfgKa: pick('configuration', 'toServer', 'keep_alive'),
      cfgPong: pick('configuration', 'toServer', 'pong'),
      cfgFin: pick('configuration', 'toServer', 'finish_configuration'),
      known: pick('configuration', 'toServer', 'select_known_packs', 'known_packs'),
      pack: pick('configuration', 'toServer', 'resource_pack'),
      pos: pick('play', 'toServer', 'position_look'),
      look: pick('play', 'toServer', 'look'),
      tele: pick('play', 'toServer', 'teleport_confirm', 'accept_teleportation'),
      ka: pick('play', 'toServer', 'keep_alive'),
      pong: pick('play', 'toServer', 'pong', 'transaction'),
      hold: pick('play', 'toServer', 'held_item_slot', 'set_carried_item'),
      swing: pick('play', 'toServer', 'arm_animation', 'swing_arm'),
      veh: pick('play', 'toServer', 'vehicle_move'),
      boat: pick('play', 'toServer', 'steer_boat', 'paddle_boat'),
      input: pick('play', 'toServer', 'player_input', 'steer_vehicle'),
      tick: pick('play', 'toServer', 'tick_end')
    }
    const PROTO = REAL_PROTO
    const POSROT_BEFORE_CONFIRM = PROTO === 768
    const VEH_INPUT_ON_LOOK = PROTO >= 768
    const BRAND_CHANNEL = PROTO >= 393 ? 'minecraft:brand' : 'MC|Brand'

    const posFields = codec.fields('play', 'toServer', N.pos) || []
    const posNames = posFields.map((f) => f.name)
    const flagsField = posFields.find((f) => f.name === 'flags')
    const flagsAreBits = flagsField ? codec.typeKind('play', 'toServer', flagsField.type) === 'bitflags' : false

    function settingsParams () {
      const v = codec.defaults(HELLO, 'toServer', N.settings) || {}
      Object.assign(v, { locale: 'en_us', viewDistance: 10, chatFlags: 0, chatColors: true, skinParts: 0x7f, mainHand: 1, enableTextFiltering: false, enableServerListing: false })
      return v
    }
    function brandParams () {
      const b = Buffer.from('vanilla', 'utf8')
      return { channel: BRAND_CHANNEL, data: Buffer.concat([varint(b.length), b]) }
    }
    function posParams (y, onGround = false, x = 8, z = 8) {
      const v = { x, y, z, yaw: 0, pitch: 0 }
      if (posNames.includes('onGround')) v.onGround = onGround
      if (flagsField) v.flags = flagsAreBits ? { onGround } : (onGround ? 1 : 0)
      return v
    }
    function fill (state, dir, name, over) {
      const v = codec.defaults(state, dir, name) || {}
      return Object.assign(v, over)
    }

    const timers = []
    function later (fn, ms) { const t = setTimeout(fn, ms); timers.push(t); return t }
    let finished = false
    function finish (status, detail) {
      if (finished) return
      finished = true
      timers.forEach(clearTimeout)
      try { client.end() } catch (e) {}
      try { if (client.socket) client.socket.destroy() } catch (e) {}
      log(`[*] bypass result: ${status}${detail ? ' (' + detail + ')' : ''}`)
      resolve({ status, detail })
    }

    const client = mc.createClient({
      host: HOST, port: PORT, username: UNAME,
      version: CLIENT_VERSION, auth: opts.auth || 'offline',
      brand: 'vanilla', connectTimeout: 60000, hideErrors: true
    })

    // kütüphanenin otomatik cevaplarını kapat - sırayı biz yöneteceğiz
    const origWrite = client.write.bind(client)
    const BLOCKED = new Set([
      'settings', 'client_information', 'custom_payload', 'brand', 'pong', 'transaction',
      'finish_configuration', 'keep_alive', 'teleport_confirm', 'accept_teleportation',
      'position', 'position_look', 'look', 'arm_animation', 'swing_arm',
      'held_item_slot', 'set_carried_item', 'vehicle_move', 'steer_boat', 'paddle_boat',
      'player_input', 'steer_vehicle', 'select_known_packs', 'known_packs',
      'resource_pack', 'tick_end', 'flying', 'chat', 'chat_message'
    ])
    client.write = (name, params) => (BLOCKED.has(name) ? undefined : origWrite(name, params))

    // HER paket kütüphaneden geçer: sıkıştırma + framing otomatik doğru
    function send (name, params) {
      if (!name) return
      if (RAW_LOG) log('[tx] ' + name)
      try { origWrite(name, params) } catch (e) { log('[!] write ' + name + ': ' + e.message) }
    }
    const tickEnd = () => { if (N.tick) send(N.tick, {}) }

    let phase = 'login'
    let cfgSent = false
    let telY1 = null, telY2 = null, spawnY = 0
    let gravityActive = false, gY = 0, gDy = 0
    let lastTx = null, protoDone = false
    let vPhase = 'WAITING', vMotion = 0, vY = 0
    let blockH = 0
    let lastHeld = -1

    function kickCheck (data, tag) {
      const t = texts(data)
      log('[' + tag + '] ' + t.slice(0, 300))
      if (isPassKick(t)) { log('[+] VERIFICATION PASSED'); finish('passed'); return true }
      return false
    }

    // ---------------- LOGIN ----------------
    client.on('success', () => {
      if (HELLO === 'configuration') {
        phase = 'configuration'
        if (!cfgSent) {
          cfgSent = true
          send(N.settings, settingsParams())
          send(N.brand, brandParams())
          log('[+] config: settings + brand gönderildi')
        }
      } else {
        phase = 'play'
        cfgSent = true
        send(N.settings, settingsParams())
        send(N.brand, brandParams())
        log('[+] play (legacy): settings + brand')
      }
    })

    client.on('compress', () => log('[+] sıkıştırma açıldı (kütüphane yönetiyor)'))

    // ---------------- CONFIGURATION ----------------
    client.on('select_known_packs', onKnown)
    client.on('known_packs', onKnown)
    function onKnown () {
      if (phase !== 'configuration' || !N.known) return
      send(N.known, fill('configuration', 'toServer', N.known, { packs: [] }))
      log('[+] known_packs cevaplandı')
    }

    client.on('resource_pack_push', onPack)
    client.on('resource_pack', onPack)
    function onPack () {
      if (phase !== 'configuration' || !N.pack) return
      for (const r of ['accepted', 'successfully_loaded', 3, 0]) {
        try {
          const v = fill('configuration', 'toServer', N.pack, { result: r })
          send(N.pack, v); log('[+] resource_pack: ' + r); break
        } catch (e) {}
      }
    }

    client.on('finish_configuration', () => {
      if (phase !== 'configuration') return
      send(N.cfgFin, {})
      phase = 'play'
      log('[+] finish_config -> PLAY')
    })

    // ---------------- KEEP ALIVE (her iki state) ----------------
    client.on('keep_alive', (data) => {
      if (phase === 'configuration') { send(N.cfgKa, data); log('[+] cfg keepalive'); return }
      if (phase !== 'play') return
      send(N.ka, data)
      log('[+] keepalive vP=' + vPhase)
      if (protoDone) vehicleStep()
    })

    // ---------------- PING ----------------
    client.on('ping', (data) => {
      if (phase === 'configuration') { send(N.cfgPong, data); return }
      if (phase !== 'play') return
      const tid = data.id !== undefined ? Number(data.id) : Number(data.action)
      if (tid === lastTx) return
      lastTx = tid
      send(N.pong, data)
      log('[proto] ping echoed ' + tid)
    })
    client.on('transaction', (data) => {
      if (phase !== 'play') return
      const tid = Number(data.action)
      if (tid === lastTx) return
      lastTx = tid
      send(N.pong, data)
      log('[proto] transaction echoed ' + tid)
    })

    // ---------------- HELD ITEM ----------------
    client.on('held_item_slot', (data) => {
      if (phase !== 'play' || !N.hold) return
      const sl = data.slot !== undefined ? data.slot : data.slotId
      if (sl === undefined || sl < 0 || sl > 8 || sl === lastHeld) return
      lastHeld = sl
      const def = codec.defaults('play', 'toServer', N.hold) || {}
      const key = ('slotId' in def) ? 'slotId' : 'slot'
      send(N.hold, Object.assign({}, def, { [key]: sl }))
      log('[proto] held echoed ' + sl)
    })

    // ---------------- ANIMATION ----------------
    client.on('animation', () => {
      if (phase !== 'play' || !N.swing) return
      const def = codec.defaults('play', 'toServer', N.swing) || {}
      send(N.swing, ('hand' in def) ? { hand: 0 } : {})
      protoDone = true
      log('[proto] swing -> reply')
    })

    // ---------------- MULTI BLOCK CHANGE ----------------
    client.on('multi_block_change', (data) => {
      if (phase !== 'play') return
      try {
        for (const rec of (data.records || [])) {
          let ids
          if (rec !== null && typeof rec === 'object') {
            const p = BigInt(rec.blockId !== undefined ? rec.blockId : (rec.stateId || 0))
            ids = [Number(p >> 4n), Number(p)]
          } else {
            const p = typeof rec === 'bigint' ? rec : BigInt(rec)
            ids = [Number(p >> 12n), Number(p)]
          }
          for (const s of ids) {
            if (HEIGHTS[s] !== undefined) { blockH = HEIGHTS[s]; log('[mbc] h=' + blockH); break }
          }
        }
      } catch (e) {}
    })

    // ---------------- POSITION / TELEPORT ----------------
    client.on('position', (data) => {
      if (phase !== 'play') return
      const y = data.y
      const tid = Number(data.teleportId || 0)
      const conf = () => { if (N.tele) send(N.tele, fill('play', 'toServer', N.tele, { teleportId: tid })) }
      if (telY1 === null) {
        telY1 = y
        log('[tele] 1st y=' + y)
        if (POSROT_BEFORE_CONFIRM) { send(N.pos, posParams(y)); conf(); tickEnd() }
        else { conf(); send(N.pos, posParams(y)); tickEnd() }
      } else if (telY2 === null && y !== telY1) {
        telY2 = y
        spawnY = telY1 + telY2
        log('[tele] 2nd spawnY=' + spawnY.toFixed(2))
        if (!POSROT_BEFORE_CONFIRM) conf()
        later(() => {
          if (POSROT_BEFORE_CONFIRM) { send(N.pos, posParams(spawnY)); conf(); send(N.pos, posParams(spawnY)); tickEnd() }
          else { send(N.pos, posParams(spawnY + 0.0001)); send(N.pos, posParams(spawnY)); tickEnd() }
          later(startGravity, 150)
        }, 60)
      } else conf()
    })

    // ---------------- KICK ----------------
    client.on('kick_disconnect', (d) => kickCheck(d, 'KICK'))
    client.on('disconnect', (d) => {
      const handled = kickCheck(d, 'DISC-' + phase)
      if (!handled && !finished) finish('ended', texts(d).replace(/\s+/g, ' ').slice(0, 120))
    })

    // ---------------- GRAVITY ----------------
    function startGravity () {
      if (gravityActive || finished) return
      gravityActive = true
      gY = spawnY; gDy = 0
      log('[+] GRAVITY start')
      let t = 0
      const tick = () => {
        if (!gravityActive || finished) return
        gDy = (gDy - 0.08) * 0.98
        gY += gDy; t++
        send(N.pos, posParams(gY)); tickEnd()
        if (t >= 8) {
          gravityActive = false
          send(N.pos, posParams(spawnY - 4 + blockH, true)); tickEnd()
          log('[+] land -> Protocol stage')
          return
        }
        later(tick, 50)
      }
      later(tick, 50)
    }

    // ---------------- VEHICLE ----------------
    function vehicleCycle (inBoat) {
      if (finished) return
      if (inBoat) {
        if (N.boat) send(N.boat, fill('play', 'toServer', N.boat, { leftPaddle: true, rightPaddle: true }))
        vMotion -= 0.04; vY += vMotion
        if (N.veh) send(N.veh, fill('play', 'toServer', N.veh, { x: 8, y: vY, z: 8, yaw: 0, pitch: 0, onGround: false }))
      }
      if (N.look) send(N.look, fill('play', 'toServer', N.look, { yaw: 0, pitch: 0, onGround: false }))
      if (!VEH_INPUT_ON_LOOK && N.input) {
        const def = codec.defaults('play', 'toServer', N.input) || {}
        send(N.input, ('inputs' in def) ? Object.assign(def, { inputs: { forward: true } }) : Object.assign(def, { sideways: 0, forward: 0, jump: 0 }))
      }
    }
    function vehicleStep () {
      if (vPhase === 'WAITING') {
        vPhase = 'IN_BOAT'; vMotion = 0; vY = telY1 || 3000
        log('[+] VEHICLE IN_BOAT')
        for (let c = 0; c < 3; c++) later(() => vehicleCycle(true), 100 + c * 130)
      } else if (vPhase === 'IN_BOAT') {
        vPhase = 'AIR_BOAT'
        later(() => send(N.pos, posParams(vY - 0.1, false)), 80)
      } else if (vPhase === 'AIR_BOAT') {
        vPhase = 'IN_MINECART'; vMotion = 0
        log('[+] VEHICLE IN_MINECART')
        for (let c = 0; c < 3; c++) later(() => vehicleCycle(false), 100 + c * 130)
      } else if (vPhase === 'IN_MINECART') {
        vPhase = 'AIR_MINECART'
        later(() => send(N.pos, posParams(vY - 0.1, false)), 80)
      }
    }

    client.on('error', (e) => {
      log('[ERR] ' + (e && e.message))
      const c = e && e.code
      if (!finished && (c === 'ECONNREFUSED' || c === 'ENOTFOUND' || c === 'ECONNRESET' || c === 'ETIMEDOUT' || c === 'EPIPE' || c === 'EAI_AGAIN')) finish('error', c)
    })
    client.on('end', () => { if (!finished) finish('ended') })
    later(() => finish('timeout'), TIMEOUT_MS)
  })
}

module.exports = runBypass
module.exports.isPassKick = isPassKick
module.exports.deriveHeights = deriveHeights
if (require.main === module) {
  runBypass({
    host: process.env.HOST || '127.0.0.1',
    port: parseInt(process.env.PORT || '25565', 10),
    username: process.env.USERNAME || 'dybot',
    version: process.env.VERSION || '1.20.4',
    rawLog: process.env.RAW_LOG === '1'
  }).then((r) => process.exit(r.status === 'passed' ? 42 : 1))
}