'use strict'
// Uçtan uca test: sahte Sonar sunucusu (1.20.4) + runBypass
// Sonar'ın doğrulama sırasını taklit eder: config -> teleport x2 -> gravity ->
// protocol (ping/held/anim) -> vehicle (boat/minecart) -> pass kick.
// node test/integration.test.js
const mc = require('minecraft-protocol')
const nbt = require('prismarine-nbt')
const runBypass = require('../sonar-bypass')

const PORT = 25599
const seen = []
let failures = 0
const check = (cond, msg) => { if (!cond) { failures++; console.error('FAIL:', msg) } else console.log('OK:', msg) }

const server = mc.createServer({
  'online-mode': false,
  version: '1.20.4',
  host: '127.0.0.1',
  port: PORT,
  // Sonar doğrulama sunucusu sıkıştırma açmaz - sahte sunucuyu da öyle davranmaya zorla
  beforeLogin: (client) => {
    const origWrite = client.write.bind(client)
    client.write = (name, p) => (name === 'compress' ? undefined : origWrite(name, p))
    Object.defineProperty(client, 'compressionThreshold', { get: () => -2, set: () => {}, configurable: true })
  }
})

const timer = setTimeout(() => { console.error('FAIL: global timeout'); process.exit(1) }, 25000)

server.on('login', (client) => {
  const track = (name) => client.on(name, (p) => { seen.push(name); })
  ;['settings', 'custom_payload', 'finish_configuration', 'teleport_confirm', 'position_look',
    'keep_alive', 'pong', 'held_item_slot', 'arm_animation', 'steer_boat', 'vehicle_move',
    'look', 'steer_vehicle'].forEach(track)

  client.once('login_acknowledged', () => {
    setTimeout(() => {
      client.write('finish_configuration', {})
    }, 100)
  })

  client.once('finish_configuration', () => {
    client.state = mc.states.PLAY
    drive(client)
  })
})

function drive (client) {
  const W = (n, p) => { try { client.write(n, p) } catch (e) { console.error('write fail', n, e.message) } }
  // teleport 1
  W('position', { x: 8, y: 3000, z: 8, yaw: 0, pitch: 0, flags: 0, teleportId: 1 })
  setTimeout(() => {
    // teleport 2 (farklı y) + platform bloğu (stone, stateId 1)
    W('position', { x: 8, y: -64, z: 8, yaw: 0, pitch: 0, flags: 0, teleportId: 2 })
    setTimeout(() => W('multi_block_change', { chunkCoordinates: { x: 0, z: 0, y: 0 }, records: [1 << 12] }), 100)
  }, 300)

  setTimeout(() => {
    // protocol aşaması
    W('animation', { entityId: 0, animation: 0 })
    W('ping', { id: 42 })
    W('held_item_slot', { slot: 3 })
    W('held_item_slot', { slot: 3 }) // duplicate slot trap - cevap GELMEMELİ
  }, 1400)

  // vehicle aşaması: keepalive saatleri
  setTimeout(() => W('keep_alive', { keepAliveId: 1n }), 1800) // WAITING -> IN_BOAT
  setTimeout(() => W('keep_alive', { keepAliveId: 2n }), 2500) // IN_BOAT -> AIR_BOAT
  setTimeout(() => W('keep_alive', { keepAliveId: 3n }), 2900) // AIR_BOAT -> IN_MINECART
  setTimeout(() => W('keep_alive', { keepAliveId: 4n }), 3600) // IN_MINECART -> AIR_MINECART

  setTimeout(() => {
    W('kick_disconnect', { reason: nbt.comp({ text: nbt.string('You have successfully passed the verification. You are now able to play on the server when you reconnect.') }) })
  }, 4100)
}

runBypass({
  host: '127.0.0.1', port: PORT, username: 'TestBot_01', version: '1.20.4',
  timeoutMs: 20000,
  log: (m) => console.log('  [bypass]', m)
}).then((r) => {
  clearTimeout(timer)
  check(r.status === 'passed', 'bypass sonucu passed (gerçek: ' + r.status + ')')
  const count = (n) => seen.filter((x) => x === n).length
  check(count('settings') >= 1, 'config settings gönderildi')
  check(count('custom_payload') >= 1, 'config brand gönderildi')
  check(count('finish_configuration') === 1, 'finish_configuration tam 1 kez')
  check(count('teleport_confirm') >= 2, 'teleport confirm x2+')
  check(count('position_look') >= 10, 'gravity + landing pozisyonları (' + count('position_look') + ')')
  check(count('pong') === 1, 'ping echo tam 1')
  check(count('held_item_slot') === 1, 'duplicate slot tuzağı: held echo tam 1')
  check(count('arm_animation') >= 1, 'swing cevabı')
  check(count('steer_boat') >= 3, 'boat paddle döngüleri (' + count('steer_boat') + ')')
  check(count('vehicle_move') >= 3, 'vehicle_move döngüleri')
  check(count('look') >= 6, 'boat + minecart look döngüleri (' + count('look') + ')')
  check(count('keep_alive') >= 4, 'keepalive echo')
  server.close()
  if (failures) { console.error(failures + ' FAILURES'); process.exit(1) }
  console.log('ALL INTEGRATION TESTS OK')
  process.exit(0)
})
