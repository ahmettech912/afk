'use strict'
// ============================================================
//  SuperCraft AFK Bot
//  - Sonar bypass (gerekirse) -> mineflayer
//  - Auth: /kayit + /register, /giris + /login (hepsi denenir)
//  - Sohbet: bot.chat() (tellraw YOK -> OP gerekmez)
//  - Fizik KAPALI + 'flying' idle paketi
//  Konsol: yazdığın her şey bota söyletilir, / ile komut gider
// ============================================================
const mineflayer = require('mineflayer')
const mc = require('minecraft-protocol')
const fs = require('fs')
const path = require('path')
const readline = require('readline')
const runBypass = require('./sonar-bypass')
const { keep_alive } = require('./keep_alive')

const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json')))
const host = data.ip
const port = Number(data.port) || 25565
const username = data.name || 'SuperCraft'
const auth = data.auth || 'offline'
const password = data.password || 'supercraft'
const passwords = data.passwords || [password, 'afkbot123']
const autoAuth = data.autoLogin !== false
const clientVersion = data.version || '1.20.4'
const ops = (data.ops || []).map((n) => n.toLowerCase())
const greeting = data.selam || 'Merhaba ben afk botu'

const bypassCfg = Object.assign({
  enabled: true, retryDelay: 30000, maxRetries: 4, longDelay: 120000,
  timeoutMs: 45000, rawLog: false
}, data.bypass || {})
const reconnectDelay = Number(data.reconnectDelay) || 15000
const keepAliveCfg = Object.assign({ enabled: false, port: 3000 }, data.keepAlive || {})

const C = { reset: '\x1b[0m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m' }
const isOp = (n) => ops.includes(String(n).toLowerCase())

let bot = null, idleTimer = null, swingTimer = null, timers = []
let inGame = false, spawned = false, lastKick = ''
let bypassBusy = false, bypassTries = 0
let authDone = false, pwIndex = 0, lastCmdAt = 0, cmdCount = 0
let greeted = false, silentMode = false

const later = (fn, ms) => { const t = setTimeout(fn, ms); timers.push(t); return t }
function clearAllTimers () {
  timers.forEach(clearTimeout); timers = []
  clearInterval(idleTimer); idleTimer = null
  clearTimeout(swingTimer); swingTimer = null
}

// ---------- SOHBET (OP gerekmez) ----------
function talk (text) {
  if (!bot || !inGame) { console.log(`${C.red}Bot sunucuda değil.${C.reset}`); return false }
  if (!authDone) console.log(`${C.yellow}[!] Henüz giriş yapılmadı, mesaj gitmeyebilir.${C.reset}`)
  try { bot.chat(text); return true } catch (e) { console.log(`${C.red}chat hata: ${e.message}${C.reset}`); return false }
}

// ---------- AUTH ----------
function curPw () { return passwords[Math.min(pwIndex, passwords.length - 1)] }
function sendCmd (cmd, force) {
  if (!autoAuth || !bot || !inGame || authDone) return
  if (!force && Date.now() - lastCmdAt < 1800) return
  if (cmdCount > 24) return
  cmdCount++
  lastCmdAt = Date.now()
  console.log(`${C.yellow}[AUTH] ${cmd}${C.reset}`)
  try { bot.chat(cmd) } catch (e) {}
}
function tryRegister () {
  const p = curPw()
  sendCmd(`/kayit ${p} ${p}`, true)
  later(() => sendCmd(`/register ${p} ${p}`, true), 1200)
}
function tryLogin () {
  const p = curPw()
  sendCmd(`/giris ${p}`, true)
  later(() => sendCmd(`/login ${p}`, true), 1200)
}

// ---------- IDLE (koordinat yok -> movement kick yok) ----------
function startIdle () {
  if (idleTimer || silentMode) return
  idleTimer = setInterval(() => {
    if (!bot || !bot._client || !inGame) return
    try { bot._client.write('flying', { onGround: true }) } catch (e) {}
  }, 400)
}
function swingLoop () {
  if (!bot || !inGame) return
  if (Math.random() < 0.15) { try { bot.swingArm('right') } catch (e) {} }
  swingTimer = setTimeout(swingLoop, 12000 + Math.random() * 10000)
}

function solveSonar (msg) {
  const m = String(msg).match(/(\d+)\s*([+\-*/xX×÷])\s*(\d+)/)
  if (!m) return null
  const a = parseInt(m[1], 10); let op = m[2]; const b = parseInt(m[3], 10)
  if (op === 'x' || op === 'X' || op === '×') op = '*'
  if (op === '÷') op = '/'
  let r = null
  if (op === '+') r = a + b
  else if (op === '-') r = a - b
  else if (op === '*') r = a * b
  else if (op === '/') r = b === 0 ? null : a / b
  if (r === null || isNaN(r)) return null
  return Number.isInteger(r) ? String(r) : r.toFixed(2)
}

function pingInfo () {
  return new Promise((resolve) => {
    mc.ping({ host, port, version: clientVersion }, (err, res) => {
      if (err) { console.log(`${C.yellow}[i] Ping yok: ${err.message}${C.reset}`); return resolve(null) }
      console.log(`${C.cyan}[i] Sunucu: ${res.version && res.version.name} | bizim: ${clientVersion}${C.reset}`)
      resolve(res.version || null)
    })
  })
}

async function doBypass () {
  if (bypassBusy || !bypassCfg.enabled) return later(createBot, 3000)
  bypassBusy = true
  console.log(`${C.cyan}[>] Sonar bypass${C.reset}`)
  let r
  try {
    r = await runBypass({
      host, port, username, version: clientVersion, auth,
      rawLog: bypassCfg.rawLog, timeoutMs: bypassCfg.timeoutMs,
      log: (m) => console.log(`${C.gray}${m}${C.reset}`)
    })
  } catch (e) { r = { status: 'error', detail: e.message } }
  bypassBusy = false
  if (r.status === 'passed') {
    bypassTries = 0
    console.log(`${C.green}[+] Doğrulama OK - 2 sn sonra bağlanıyor.${C.reset}`)
    return later(createBot, 2000)
  }
  bypassTries++
  const d = bypassTries >= bypassCfg.maxRetries ? bypassCfg.longDelay : bypassCfg.retryDelay
  console.log(`${C.yellow}[!] Bypass: ${r.status} - ${d / 1000}s sonra tekrar.${C.reset}`)
  if (bypassTries >= bypassCfg.maxRetries) bypassTries = 0
  later(doBypass, d)
}

function createBot () {
  inGame = false; spawned = false; lastKick = ''
  authDone = false; pwIndex = 0; lastCmdAt = 0; cmdCount = 0; greeted = false
  clearAllTimers()
  console.log(`${C.cyan}[>] Bağlanılıyor (${username} @ ${clientVersion}) şifre: ${curPw()}${C.reset}`)
  bot = mineflayer.createBot({ host, port, username, auth, version: clientVersion })
  bot.physicsEnabled = false

  bot.on('login', () => {
    bot.physicsEnabled = false
    console.log(`${C.green}Logged In as ${username}${C.reset}`)
  })

  bot.on('spawn', () => {
    bot.physicsEnabled = false
    console.log(`${C.green}Sunucuya girdi${C.reset}`)
    inGame = true; spawned = true; bypassTries = 0
    startIdle()
    later(tryRegister, 1500)
    later(tryLogin, 5000)
    later(() => { if (!authDone) tryLogin() }, 11000)
    later(() => { if (!authDone) tryLogin() }, 18000)
    later(() => { if (!authDone) tryLogin() }, 26000)
    later(swingLoop, 15000)
  })

  bot.on('messagestr', (msg, position) => {
    if (!msg || !msg.trim()) return
    // TÜM sunucu mesajlarını göster (teşhis için)
    console.log(`${C.gray}[SUNUCU/${position}] ${msg}${C.reset}`)
    const L = msg.toLowerCase()

    // --- giriş başarılı ---
    const ok = ['giriş başarılı', 'giris basarili', 'başarıyla giriş', 'basariyla giris',
      'successfully logged', 'you are now logged', 'zaten giriş', 'zaten giris',
      'kayıt başarılı', 'kayit basarili', 'successfully registered', 'başarıyla kayıt',
      'hoşgeldin', 'hosgeldin', 'welcome']
    if (!authDone && ok.some((k) => L.includes(k))) {
      authDone = true
      console.log(`${C.green}[+] GİRİŞ TAMAM! Artık konuşabilir.${C.reset}`)
      if (!greeted) { greeted = true; later(() => talk(greeting), 2000) }
    }

    // --- şifre yanlış -> sıradaki şifreyi dene ---
    if (/hatalı şifre|yanlış şifre|wrong password|incorrect password|sifre hatali|şifre yanlış/i.test(L)) {
      if (pwIndex < passwords.length - 1) {
        pwIndex++
        console.log(`${C.yellow}[i] Şifre yanlış, sıradaki deneniyor: ${curPw()}${C.reset}`)
        later(tryLogin, 1500)
      } else {
        console.log(`${C.red}[!] Tüm şifreler yanlış. config.json "password" düzelt.${C.reset}`)
      }
    }

    // --- kayıt istiyor ---
    if (!authDone && (/kayıt ol|kayit ol|register|\/kayit|\/register/i.test(L))) {
      later(tryRegister, 900)
    }
    // --- giriş istiyor ---
    if (!authDone && (/giriş yap|giris yap|login|\/giris|\/login/i.test(L))) {
      later(tryLogin, 900)
    }
    // --- bilinmeyen komut ---
    if (/bilinmeyen komut|unknown command|komut bulunamadı/i.test(L)) {
      console.log(`${C.yellow}[i] Bu komut yok, diğer varyant denenecek.${C.reset}`)
    }

    // --- Sonar captcha ---
    const keys = ['sonar', 'doğrula', 'captcha', 'çöz', 'verify', 'hareket etmeyin']
    const ans = solveSonar(msg)
    if (ans && (keys.some((k) => L.includes(k)) || /\d+\s*[+\-*/]\s*\d+/.test(msg))) {
      console.log(`${C.cyan}[SONAR] ${msg} -> ${ans}${C.reset}`)
      later(() => talk(ans), 1500 + Math.random() * 1500)
    }
  })

  bot.on('chat', (u, m) => {
    if (u === bot.username) return
    console.log(isOp(u) ? `${C.bold}${C.red}[OP] ${u}: ${m}${C.reset}` : `${C.cyan}${u}${C.reset}: ${m}`)
  })
  bot.on('playerJoined', (p) => { if (p.username !== bot.username) console.log(`${C.green}[+] ${p.username}${C.reset}`) })
  bot.on('playerLeft', (p) => { if (p.username !== bot.username) console.log(`${C.red}[-] ${p.username}${C.reset}`) })
  bot.on('error', (e) => console.log(`${C.red}HATA: ${e.message}${C.reset}`))
  bot.on('kicked', (r) => { lastKick = typeof r === 'string' ? r : JSON.stringify(r); console.log(`${C.red}ATILDI: ${lastKick}${C.reset}`) })
  bot.on('forcedMove', () => { bot.physicsEnabled = false })

  bot.on('end', () => {
    inGame = false
    clearAllTimers()
    const k = String(lastKick || '')
    if (/invalid_player_movement|moved wrongly|moved too quickly|flying is not/i.test(k)) {
      silentMode = !silentMode
      console.log(`${C.yellow}[i] Hareket kick - sessiz mod: ${silentMode ? 'AÇIK' : 'KAPALI'}${C.reset}`)
      return later(createBot, 4000)
    }
    if (/sure doldu|süre doldu|giriş veya kayıt|kayit olmak/i.test(k)) {
      console.log(`${C.yellow}[i] Auth timeout - 3 sn sonra tekrar.${C.reset}`)
      return later(createBot, 3000)
    }
    if (runBypass.isPassKick(k)) return later(createBot, 3000)
    if (/sonar|verif|doğrul|dogrul|captcha|bot kontrol|verification/i.test(k) || !spawned) {
      console.log(`${C.yellow}[i] Sonar engeli - bypass.${C.reset}`)
      return later(doBypass, 3000)
    }
    console.log(`${C.yellow}Koptu - ${reconnectDelay / 1000}s sonra tekrar.${C.reset}`)
    later(createBot, reconnectDelay)
  })
}

// ---------- KONSOL: yazdığın her şeyi bot söyler ----------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
rl.on('line', (line) => {
  const text = line.trim()
  if (!text) return
  if (text === '!durum') {
    console.log(`${C.cyan}inGame=${inGame} authDone=${authDone} şifre=${curPw()} sessiz=${silentMode}${C.reset}`)
    return
  }
  if (text === '!giris') { tryLogin(); return }
  if (text === '!kayit') { tryRegister(); return }
  if (text.startsWith('/')) {
    if (!bot || !inGame) { console.log(`${C.red}Bot sunucuda değil.${C.reset}`); return }
    bot.chat(text); console.log(`${C.yellow}KOMUT: ${text}${C.reset}`); return
  }
  if (talk(text)) console.log(`${C.green}[BOT SÖYLEDİ] ${text}${C.reset}`)
})

console.log(`${C.bold}${C.green}=== SuperCraft AFK Bot ===${C.reset}`)
console.log(`${C.cyan}${host}:${port} | ${username} | Şifreler: ${passwords.join(', ')}${C.reset}`)
console.log(`${C.cyan}Konsol: yaz -> bot söyler | /komut | !giris | !kayit | !durum${C.reset}`)
if (keepAliveCfg.enabled) keep_alive(keepAliveCfg.port, () => ({ inGame, authDone, username, target: `${host}:${port}`, uptime: process.uptime() }))
process.on('SIGINT', () => { console.log(`${C.yellow}Kapatılıyor...${C.reset}`); try { if (bot) bot.quit() } catch (e) {}; process.exit(0) })

;(async () => { await pingInfo(); createBot() })()