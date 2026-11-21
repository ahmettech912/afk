#!/usr/bin/env node
'use strict'
// Sonar bypass - paketler kütüphanenin write'ı ile gider.
// Gerçek sunucuya girilirse (IP doğrulanmış) HEMEN 'passed' döner.
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
    const e = cs.blocks[b.name]
    if (e === undefined) continue
    for (let s = b.minStateId; s <= b.maxStateId; s++) {
      const sid = Array.isArray(e) ? e[s - b.minStateId] : e
      if (sid === undefined) continue
      let h = 0
      for (const box of (cs.shapes[String(sid)] || [])) h = Math.max(h, box[4])
      if (h > 0) out[s] = h
    }
  }
  return out
}

const PASS_KICK = /successfully passed the verification|now able to play|verified successfully|verification successful|dogrulamayi basariyla gectin|doğrulamayı başarıyla geçtin|basariyla gectin|başarıyla geçtin|oyuna girebilirsin|dogrulama basarili/i
const NEG_KICK = /too fast|try again|wait|already|queued|failed|blacklist|unsupported|not verified|denied|invalid|cok hizli|tekrar dene|bekle|basarisiz|başarısız|gecemedin|geçemedin/i
const REAL_SRV = /kayit|kayıt|giris|giriş|login|register|sifre|şifre|hosgeldin|hoşgeldin|sure doldu|süre doldu/i
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
  const UNAME = opts.username || 'bot'
  const VERSION = opts.version || '1.20.4'
  const RAW_LOG = !!opts.rawLog
  const TIMEOUT_MS = parseInt(opts.timeoutMs || '45000', 10)
  const log = opts.log || console.log

  return new Promise((resolve) => {
    const exact = (() => { try { return mcData(VERSION) } catch (e) { return null } })()
    const REAL_PROTO = (mcData.versionsByMinecraftVersion.pc[VERSION] || {}).version ||
      (exact && exact.version && exact.version.version) || opts.protocol
    if (!REAL_PROTO) return resolve({ status: 'error', detail: 'unknown version' })

    const codec = new Codec(VERSION, { protocol: REAL_PROTO })
    const CLIENT_VERSION = codec.exact ? VERSION : codec.data.version.minecraftVersion
    const SONAR_VER = VERSION_MAP ? VERSION_MAP[String(REAL_PROTO)] : null
    const HEIGHTS = (SONAR_VER && BLOCK_HEIGHTS && BLOCK_HEIGHTS[SONAR_VER]) || deriveHeights(codec.data)
    log(`[*] sürüm ${CLIENT_VERSION} (proto ${REAL_PROTO})`)

    const has = (s, d, n) => codec.id(s, d, n) !== undefined
    const pick = (s, d, ...n) => n.find((x) => has(s, d, x))
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
    const POSROT_FIRST = PROTO === 768
    const VEH_ON_LOOK = PROTO >= 768
    const BRAND_CH = PROTO >= 393 ? 'minecraft:brand' : 'MC|Brand'
    const pf = codec.fields('play', 'toServer', N.pos) || []
    const pfNames = pf.map((f) => f.name)
    const ff = pf.find((f) => f.name === 'flags')
    const ffBits = ff ? codec.typeKind('play', 'toServer', ff.type) === 'bitflags' : false

    const fill = (s, d, n, o) => Object.assign(codec.defaults(s, d, n) || {}, o)
    function settingsP () {
      return fill(HELLO, 'toServer', N.settings, {
        locale: 'en_us', viewDistance: 10, chatFlags: 0, chatColors: true,
        skinParts: 0x7f, mainHand: 1, enableTextFiltering: false, enableServerListing: false
      })
    }
    function brandP () {
      const b = Buffer.from('vanilla', 'utf8')
      return { channel: BRAND_CH, data: Buffer.concat([varint(b.length), b]) }
    }
    function posP (y, og = false, x = 8, z = 8) {
      const v = { x, y, z, yaw: 0, pitch: 0 }
      if (pfNames.includes('onGround')) v.onGround = og
      if (ff) v.flags = ffBits ? { onGround: og } : (og ? 1 : 0)
      return v
    }

    const timers = []
    const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t }
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
      host: HOST, port: PORT, username: UNAME, version: CLIENT_VERSION,
      auth: opts.auth || 'offline', brand: 'vanilla', connectTimeout: 30000, hideErrors: true
    })
    const origWrite = client.write.bind(client)
    const BLOCKED = new Set(['settings', 'client_information', 'custom_payload', 'brand', 'pong',
      'transaction', 'finish_configuration', 'keep_alive', 'teleport_confirm', 'accept_teleportation',
      'position', 'position_look', 'look', 'flying', 'arm_animation', 'swing_arm', 'held_item_slot',
      'set_carried_item', 'vehicle_move', 'steer_boat', 'paddle_boat', 'player_input', 'steer_vehicle',
      'select_known_packs', 'known_packs', 'resource_pack', 'tick_end', 'chat', 'chat_message'])
    client.write = (n, p) => (BLOCKED.has(n) ? undefined : origWrite(n, p))
    function send (n, p) {
      if (!n) return
      if (RAW_LOG) log('[tx] ' + n)
      try { origWrite(n, p) } catch (e) {}
    }
    const tickEnd = () => { if (N.tick) send(N.tick, {}) }

    let phase = 'login', cfgSent = false, sonarSeen = false
    let telY1 = null, telY2 = null, spawnY = 0
    let gravOn = false, gY = 0, gDy = 0
    let lastTx = null, protoDone = false
    let vPhase = 'WAITING', vMotion = 0, vY = 0
    let blockH = 0, lastHeld = -1

    function realSrv (why) {
      if (finished) return
      log('[+] Gerçek sunucu (' + why + ') - IP doğrulanmış, çıkılıyor')
      finish('passed')
    }
    function chatWatch (d) {
      if (phase !== 'play' || finished) return
      if (REAL_SRV.test(texts(d))) realSrv('auth mesajı')
    }
    client.on('system_chat', chatWatch)
    client.on('chat', chatWatch)
    client.on('action_bar', chatWatch)
    client.on('set_title_text', chatWatch)

    client.on('success', () => {
      if (HELLO === 'configuration') {
        phase = 'configuration'
        if (!cfgSent) { cfgSent = true; send(N.settings, settingsP()); send(N.brand, brandP()); log('[+] config gönderildi') }
      } else {
        phase = 'play'; cfgSent = true
        send(N.settings, settingsP()); send(N.brand, brandP())
      }
    })
    client.on('compress', () => log('[+] sıkıştırma (kütüphane)'))

    const onKnown = () => {
      if (phase !== 'configuration' || !N.known) return
      send(N.known, fill('configuration', 'toServer', N.known, { packs: [] }))
      log('[+] known_packs cevaplandı')
    }
    client.on('select_known_packs', onKnown)
    client.on('known_packs', onKnown)

    const onPack = () => {
      if (phase !== 'configuration' || !N.pack) return
      for (const r of ['accepted', 'successfully_loaded', 3, 0]) {
        try { send(N.pack, fill('configuration', 'toServer', N.pack, { result: r })); break } catch (e) {}
      }
    }
    client.on('resource_pack_push', onPack)
    client.on('resource_pack', onPack)

    client.on('finish_configuration', () => {
      if (phase !== 'configuration') return
      send(N.cfgFin, {})
      phase = 'play'
      log('[+] finish_config -> PLAY')
      later(() => { if (!finished && !sonarSeen) realSrv('Sonar kontrolü yok') }, 5000)
    })

    client.on('keep_alive', (d) => {
      if (phase === 'configuration') { send(N.cfgKa, d); return }
      if (phase !== 'play') return
      send(N.ka, d)
      if (protoDone) vehicleStep()
    })
    client.on('ping', (d) => {
      if (phase === 'configuration') { send(N.cfgPong, d); return }
      if (phase !== 'play') return
      const t = d.id !== undefined ? Number(d.id) : Number(d.action)
      if (t === lastTx) return
      lastTx = t; send(N.pong, d); log('[proto] ping ' + t)
    })
    client.on('transaction', (d) => {
      if (phase !== 'play') return
      const t = Number(d.action)
      if (t === lastTx) return
      lastTx = t; send(N.pong, d)
    })
    client.on('held_item_slot', (d) => {
      if (phase !== 'play' || !N.hold) return
      const sl = d.slot !== undefined ? d.slot : d.slotId
      if (sl === undefined || sl < 0 || sl > 8 || sl === lastHeld) return
      lastHeld = sl
      const def = codec.defaults('play', 'toServer', N.hold) || {}
      send(N.hold, Object.assign({}, def, { [('slotId' in def) ? 'slotId' : 'slot']: sl }))
      log('[proto] held ' + sl)
    })
    client.on('animation', () => {
      if (phase !== 'play' || !N.swing) return
      const def = codec.defaults('play', 'toServer', N.swing) || {}
      send(N.swing, ('hand' in def) ? { hand: 0 } : {})
      protoDone = true; log('[proto] swing')
    })
    client.on('multi_block_change', (d) => {
      if (phase !== 'play') return
      sonarSeen = true
      try {
        for (const rec of (d.records || [])) {
          let ids
          if (rec !== null && typeof rec === 'object') {
            const p = BigInt(rec.blockId !== undefined ? rec.blockId : (rec.stateId || 0))
            ids = [Number(p >> 4n), Number(p)]
          } else {
            const p = typeof rec === 'bigint' ? rec : BigInt(rec)
            ids = [Number(p >> 12n), Number(p)]
          }
          for (const s of ids) if (HEIGHTS[s] !== undefined) { blockH = HEIGHTS[s]; break }
        }
      } catch (e) {}
    })
    client.on('position', (d) => {
      if (phase !== 'play') return
      const y = d.y, tid = Number(d.teleportId || 0)
      if (Math.abs(y) > 1000) sonarSeen = true
      const conf = () => { if (N.tele) send(N.tele, fill('play', 'toServer', N.tele, { teleportId: tid })) }
      if (telY1 === null) {
        telY1 = y; log('[tele] 1st y=' + y)
        if (POSROT_FIRST) { send(N.pos, posP(y)); conf(); tickEnd() } else { conf(); send(N.pos, posP(y)); tickEnd() }
        if (Math.abs(y) < 1000) later(() => { if (!finished && !sonarSeen) realSrv('normal spawn Y') }, 3000)
      } else if (telY2 === null && y !== telY1) {
        telY2 = y; spawnY = telY1 + telY2; sonarSeen = true
        log('[tele] 2nd spawnY=' + spawnY.toFixed(2))
        if (!POSROT_FIRST) conf()
        later(() => {
          if (POSROT_FIRST) { send(N.pos, posP(spawnY)); conf(); send(N.pos, posP(spawnY)); tickEnd() }
          else { send(N.pos, posP(spawnY + 0.0001)); send(N.pos, posP(spawnY)); tickEnd() }
          later(startGravity, 150)
        }, 60)
      } else conf()
    })

    function kickCheck (d, tag) {
      const t = texts(d)
      log('[' + tag + '] ' + t.slice(0, 250))
      if (isPassKick(t)) { log('[+] VERIFICATION PASSED'); finish('passed'); return true }
      if (/sure doldu|süre doldu|giriş veya kayıt|kayit olmak/i.test(t)) { realSrv('auth timeout'); return true }
      return false
    }
    client.on('kick_disconnect', (d) => kickCheck(d, 'KICK'))
    client.on('disconnect', (d) => { if (!kickCheck(d, 'DISC') && !finished) finish('ended', texts(d).slice(0, 100)) })

    function startGravity () {
      if (gravOn || finished) return
      gravOn = true; gY = spawnY; gDy = 0
      log('[+] GRAVITY')
      let t = 0
      const tick = () => {
        if (!gravOn || finished) return
        gDy = (gDy - 0.08) * 0.98; gY += gDy; t++
        send(N.pos, posP(gY)); tickEnd()
        if (t >= 8) {
          gravOn = false
          send(N.pos, posP(spawnY - 4 + blockH, true)); tickEnd()
          log('[+] land -> Protocol')
          return
        }
        later(tick, 50)
      }
      later(tick, 50)
    }
    function vehCycle (boat) {
      if (finished) return
      if (boat) {
        if (N.boat) send(N.boat, fill('play', 'toServer', N.boat, { leftPaddle: true, rightPaddle: true }))
        vMotion -= 0.04; vY += vMotion
        if (N.veh) send(N.veh, fill('play', 'toServer', N.veh, { x: 8, y: vY, z: 8, yaw: 0, pitch: 0, onGround: false }))
      }
      if (N.look) send(N.look, fill('play', 'toServer', N.look, { yaw: 0, pitch: 0, onGround: false }))
      if (!VEH_ON_LOOK && N.input) {
        const def = codec.defaults('play', 'toServer', N.input) || {}
        send(N.input, ('inputs' in def) ? Object.assign(def, { inputs: { forward: true } }) : Object.assign(def, { sideways: 0, forward: 0, jump: 0 }))
      }
    }
    function vehicleStep () {
      if (vPhase === 'WAITING') {
        vPhase = 'IN_BOAT'; vMotion = 0; vY = telY1 || 3000
        log('[+] VEHICLE boat')
        for (let c = 0; c < 3; c++) later(() => vehCycle(true), 100 + c * 130)
      } else if (vPhase === 'IN_BOAT') { vPhase = 'AIR_BOAT'; later(() => send(N.pos, posP(vY - 0.1, false)), 80) }
      else if (vPhase === 'AIR_BOAT') {
        vPhase = 'IN_MINECART'; vMotion = 0
        log('[+] VEHICLE minecart')
        for (let c = 0; c < 3; c++) later(() => vehCycle(false), 100 + c * 130)
      } else if (vPhase === 'IN_MINECART') { vPhase = 'AIR_MINECART'; later(() => send(N.pos, posP(vY - 0.1, false)), 80) }
    }

    client.on('error', (e) => {
      const c = e && e.code
      if (!finished && c) finish('error', c)
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
    username: process.env.USERNAME || 'bot',
    version: process.env.VERSION || '1.20.4',
    rawLog: process.env.RAW_LOG === '1'
  }).then((r) => process.exit(r.status === 'passed' ? 42 : 1))
}