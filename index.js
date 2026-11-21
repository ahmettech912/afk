
'use strict'

// ============================================================
// SuperCraft AFK Bot - Düzeltilmiş v2.0.1
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
const ops = (data.ops || []).map(n => n.toLowerCase())
const greeting = data.selam || 'Merhaba ben AFK botu'

const bypassCfg = Object.assign({
  enabled: true,
  retryDelay: 30000,
  maxRetries: 4,
  longDelay: 120000,
  timeoutMs: 45000,
  rawLog: false
}, data.bypass || {})

const reconnectDelay = Number(data.reconnectDelay) || 15000
const keepAliveCfg = Object.assign(
  { enabled: false, port: 3000 },
  data.keepAlive || {}
)

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
}

const isOp = n => ops.includes(String(n).toLowerCase())

let bot = null
let idleTimer = null
let swingTimer = null
let timers = []

let inGame = false
let spawned = false
let lastKick = ''

let bypassBusy = false
let bypassTries = 0

let authDone = false
let pwIndex = 0
let lastCmdAt = 0
let cmdCount = 0

let greeted = false
let silentMode = false

const later = (fn, ms) => {
  const t = setTimeout(fn, ms)
  timers.push(t)
  return t
}

function clearAllTimers() {
  timers.forEach(clearTimeout)
  timers = []

  clearInterval(idleTimer)
  idleTimer = null

  clearTimeout(swingTimer)
  swingTimer = null
}

// ============================================================
// SOHBET
// ============================================================

function talk(text) {
  if (!bot || !inGame) {
    console.log(`${C.red}Bot sunucuda değil.${C.reset}`)
    return false
  }

  if (!authDone) {
    console.log(`${C.yellow}[!] Henüz giriş yapılmadı.${C.reset}`)
  }

  try {
    bot.chat(text)
    return true
  } catch (e) {
    console.log(`${C.red}Chat hatası: ${e.message}${C.reset}`)
    return false
  }
}

// ============================================================
// GİRİŞ VE KAYIT
// ============================================================

function curPw() {
  return passwords[Math.min(pwIndex, passwords.length - 1)]
}

function sendCmd(cmd, force) {
  if (!autoAuth || !bot || !inGame || authDone) return
  if (!force && Date.now() - lastCmdAt < 1800) return
  if (cmdCount > 24) return

  cmdCount++
  lastCmdAt = Date.now()

  console.log(`${C.yellow}[AUTH] ${cmd}${C.reset}`)

  try {
    bot.chat(cmd)
  } catch (e) {
    console.log(e.message)
  }
}

function tryRegister() {
  const p = curPw()

  sendCmd(`/kayit ${p} ${p}`, true)

  later(() => {
    sendCmd(`/register ${p} ${p}`, true)
  }, 1200)
}

function tryLogin() {
  const p = curPw()

  sendCmd(`/giris ${p}`, true)

  later(() => {
    sendCmd(`/login ${p}`, true)
  }, 1200)
}

// ============================================================
// AFK
// ============================================================

function startIdle() {
  if (idleTimer || silentMode) return

  idleTimer = setInterval(() => {
    if (!bot || !bot._client || !inGame) return

    try {
      bot._client.write('flying', { onGround: true })
    } catch (e) {}
  }, 400)
}

function swingLoop() {
  if (!bot || !inGame) return

  if (Math.random() < 0.15) {
    try {
      bot.swingArm('right')
    } catch (e) {}
  }

  swingTimer = setTimeout(
    swingLoop,
    12000 + Math.random() * 10000
  )
}

// ============================================================
// SONAR MATEMATİK
// ============================================================

function solveSonar(msg) {
  const m = String(msg).match(/(\d+)\s*([+\-*/xX×÷])\s*(\d+)/)

  if (!m) return null

  const a = parseInt(m[1], 10)
  let op = m[2]
  const b = parseInt(m[3], 10)

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

// ============================================================
// SUNUCU PING
// ============================================================

function pingInfo() {
  return new Promise(resolve => {
    mc.ping({ host, port, version: clientVersion }, (err, res) => {
      if (err) {
        console.log(`${C.yellow}[i] Ping yok: ${err.message}${C.reset}`)
        return resolve(null)
      }

      console.log(
        `${C.cyan}[i] Sunucu: ${res.version && res.version.name} | Bizim: ${clientVersion}${C.reset}`
      )

      resolve(res.version || null)
    })
  })
}

// ============================================================
// BAĞLANTI
// ============================================================

async function doBypass() {
  if (bypassBusy || !bypassCfg.enabled) {
    return later(createBot, 3000)
  }

  bypassBusy = true

  console.log(`${C.cyan}[>] Sonar doğrulama kontrolü${C.reset}`)

  let r

  try {
    r = await runBypass({
      host,
      port,
      username,
      version: clientVersion,
      auth,
      rawLog: bypassCfg.rawLog,
      timeoutMs: bypassCfg.timeoutMs,
      log: m => console.log(`${C.gray}${m}${C.reset}`)
    })
  } catch (e) {
    r = { status: 'error', detail: e.message }
  }

  bypassBusy = false

  if (r.status === 'passed') {
    bypassTries = 0

    console.log(`${C.green}[+] Doğrulama tamamlandı.${C.reset}`)

    return later(createBot, 2000)
  }

  bypassTries++

  const d = bypassTries >= bypassCfg.maxRetries
    ? bypassCfg.longDelay
    : bypassCfg.retryDelay

  console.log(
    `${C.yellow}[!] Doğrulama durumu: ${r.status}${C.reset}`
  )

  if (bypassTries >= bypassCfg.maxRetries) {
    bypassTries = 0
  }

  later(doBypass, d)
}

// ============================================================
// BOT OLUŞTUR
// ============================================================

function createBot() {
  inGame = false
  spawned = false
  lastKick = ''

  authDone = false
  pwIndex = 0
  lastCmdAt = 0
  cmdCount = 0
  greeted = false

  clearAllTimers()

  console.log(
    `${C.cyan}[>] Bağlanılıyor (${username} @ ${clientVersion})${C.reset}`
  )

  bot = mineflayer.createBot({
    host,
    port,
    username,
    auth,
    version: clientVersion
  })

  bot.physicsEnabled = false

  bot.on('login', () => {
    bot.physicsEnabled = false

    console.log(`${C.green}Logged In as ${username}${C.reset}`)
  })

  bot.on('spawn', () => {
    bot.physicsEnabled = false

    console.log(`${C.green}Sunucuya girdi${C.reset}`)

    inGame = true
    spawned = true
    bypassTries = 0

    startIdle()

    // Önce kayıtlı hesapla giriş dene.
    later(tryLogin, 1500)
    later(tryLogin, 5000)
    later(() => {
      if (!authDone) tryLogin()
    }, 11000)

    later(() => {
      if (!authDone) tryLogin()
    }, 18000)

    later(() => {
      if (!authDone) tryLogin()
    }, 26000)

    later(swingLoop, 15000)
  })

  // ==========================================================
  // SUNUCU MESAJLARI
  // ==========================================================

  bot.on('messagestr', (msg, position) => {
    if (!msg || !msg.trim()) return

    console.log(`${C.gray}[SUNUCU/${position}] ${msg}${C.reset}`)

    const L = msg.toLowerCase()

    // SADECE GERÇEK GİRİŞ BAŞARI MESAJLARI
    // Welcome / Hoşgeldin artık giriş sayılmaz.

    const ok = [
      'giriş başarılı',
      'giris basarili',
      'başarıyla giriş yaptın',
      'basariyla giris yaptin',
      'başarıyla giriş yaptınız',
      'basariyla giris yaptiniz',
      'giriş yaptın',
      'giris yaptin',
      'giriş yaptınız',
      'giris yaptiniz',
      'successfully logged in',
      'you are now logged in',
      'successfully registered',
      'kayıt başarılı',
      'kayit basarili'
    ]

    if (!authDone && ok.some(k => L.includes(k))) {
      authDone = true

      console.log(
        `${C.green}[+] GİRİŞ TAMAM! Artık konuşabilir.${C.reset}`
      )

      if (!greeted) {
        greeted = true
        later(() => talk(greeting), 2000)
      }
    }

    // ŞİFRE YANLIŞ
    if (
      /hatalı şifre|yanlış şifre|wrong password|incorrect password|sifre hatali|şifre yanlış/i.test(L)
    ) {
      if (pwIndex < passwords.length - 1) {
        pwIndex++

        console.log(
          `${C.yellow}[i] Sıradaki şifre deneniyor.${C.reset}`
        )

        later(tryLogin, 1500)
      } else {
        console.log(
          `${C.red}[!] Şifreleri config.json dosyasından kontrol et.${C.reset}`
        )
      }
    }

    // KAYIT GEREKİYORSA
    if (
      !authDone &&
      (/kayıt ol|kayit ol|register|\/kayit|\/register/i.test(L))
    ) {
      console.log(`${C.yellow}[i] Kayıt isteniyor.${C.reset}`)
      later(tryRegister, 900)
    }

    // GİRİŞ GEREKİYORSA
    if (
      !authDone &&
      (/giriş yap|giris yap|login|\/giris|\/login/i.test(L))
    ) {
      later(tryLogin, 900)
    }

    // SONAR
    const keys = [
      'sonar',
      'doğrula',
      'captcha',
      'çöz',
      'verify',
      'hareket etmeyin'
    ]

    const ans = solveSonar(msg)

    if (
      ans &&
      (keys.some(k => L.includes(k)) ||
      /\d+\s*[+\-*/]\s*\d+/.test(msg))
    ) {
      console.log(`${C.cyan}[SONAR] ${msg}${C.reset}`)
      later(() => talk(ans), 1500 + Math.random() * 1500)
    }
  })

  // ==========================================================
  // DİĞER OYUNCULAR
  // ==========================================================

  bot.on('chat', (u, m) => {
    if (u === bot.username) return

    console.log(
      isOp(u)
        ? `${C.bold}${C.red}[OP] ${u}: ${m}${C.reset}`
        : `${C.cyan}${u}${C.reset}: ${m}`
    )
  })

  bot.on('playerJoined', p => {
    if (p.username !== bot.username) {
      console.log(`${C.green}[+] ${p.username}${C.reset}`)
    }
  })

  bot.on('playerLeft', p => {
    if (p.username !== bot.username) {
      console.log(`${C.red}[-] ${p.username}${C.reset}`)
    }
  })

  bot.on('error', e => {
    console.log(`${C.red}HATA: ${e.message}${C.reset}`)
  })

  bot.on('kicked', r => {
    lastKick = typeof r === 'string' ? r : JSON.stringify(r)

    console.log(`${C.red}ATILDI: ${lastKick}${C.reset}`)
  })

  bot.on('forcedMove', () => {
    bot.physicsEnabled = false
  })

  // ==========================================================
  // BAĞLANTI KESİLİRSE
  // ==========================================================

  bot.on('end', () => {
    inGame = false

    clearAllTimers()

    const k = String(lastKick || '')

    if (
      /invalid_player_movement|moved wrongly|moved too quickly|flying is not/i.test(k)
    ) {
      silentMode = !silentMode

      console.log(
        `${C.yellow}[i] Hareket durumu değişti.${C.reset}`
      )

      return later(createBot, 4000)
    }

    if (
      /sure doldu|süre doldu|giriş veya kayıt|kayit olmak/i.test(k)
    ) {
      console.log(`${C.yellow}[i] Giriş süresi doldu.${C.reset}`)
      return later(createBot, 3000)
    }

    if (runBypass.isPassKick(k)) {
      return later(createBot, 3000)
    }

    if (
      /sonar|verif|doğrul|dogrul|captcha|bot kontrol|verification/i.test(k) ||
      !spawned
    ) {
      console.log(`${C.yellow}[i] Doğrulama bağlantısı kesildi.${C.reset}`)
      return later(doBypass, 3000)
    }

    console.log(
      `${C.yellow}Koptu - ${reconnectDelay / 1000}s sonra tekrar.${C.reset}`
    )

    later(createBot, reconnectDelay)
  })
}

// ============================================================
// KONSOL
// ============================================================

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

rl.on('line', line => {
  const text = line.trim()

  if (!text) return

  if (text === '!durum') {
    console.log(
      `${C.cyan}inGame=${inGame} authDone=${authDone} sessiz=${silentMode}${C.reset}`
    )
    return
  }

  if (text === '!giris') {
    tryLogin()
    return
  }

  if (text === '!kayit') {
    tryRegister()
    return
  }

  if (text.startsWith('/')) {
    if (!bot || !inGame) {
      console.log(`${C.red}Bot sunucuda değil.${C.reset}`)
      return
    }

    bot.chat(text)

    console.log(`${C.yellow}KOMUT: ${text}${C.reset}`)
    return
  }

  if (talk(text)) {
    console.log(`${C.green}[BOT SÖYLEDİ] ${text}${C.reset}`)
  }
})

// ============================================================
// BAŞLAT
// ============================================================

console.log(`${C.bold}${C.green}=== SuperCraft AFK Bot ===${C.reset}`)

console.log(
  `${C.cyan}${host}:${port} | ${username}${C.reset}`
)

console.log(
  `${C.cyan}Konsol: yaz -> bot söyler | /komut | !giris | !kayit | !durum${C.reset}`
)

if (keepAliveCfg.enabled) {
  keep_alive(
    keepAliveCfg.port,
    () => ({
      inGame,
      authDone,
      username,
      target: `${host}:${port}`,
      uptime: process.uptime()
    })
  )
}

process.on('SIGINT', () => {
  console.log(`${C.yellow}Kapatılıyor...${C.reset}`)

  try {
    if (bot) bot.quit()
  } catch (e) {}

  process.exit(0)
})

;(async () => {
  await pingInfo()
  createBot()
})()
