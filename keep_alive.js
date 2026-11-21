'use strict'
// keep_alive.js - uptime ping'leri için basit HTTP sunucusu (Replit/Render vb.)
// config.json -> "keepAlive": { "enabled": true, "port": 3000 }
const http = require('http')

function keep_alive (port, statusFn) {
  const p = Number(port) || 3000
  const server = http.createServer((req, res) => {
    let status = { ok: true }
    try { if (statusFn) status = Object.assign(status, statusFn()) } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(Object.assign({ service: 'supercraft-afk-bot', time: new Date().toISOString() }, status)))
  })
  server.on('error', (e) => console.log(`[keep_alive] port ${p} açılamadı: ${e.message}`))
  server.listen(p, '0.0.0.0', () => console.log(`[keep_alive] http://0.0.0.0:${p} hazır (uptime ping)`))
  return server
}

module.exports = { keep_alive }
