# SuperCraft AFK Bot — Birleştirilmiş Sürüm

`index.js` (mineflayer AFK bot) + `bypass-dynamic.js` (Sonar bypass) tek projede birleştirildi.
Eksik bağımlılıklar (`resources/codec.js`, blok tabloları, `keep_alive.js`) tamamlandı.

## Nasıl çalışır?

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Ping: sunucu sürümü otomatik algılanır                    │
│ 2. sonar-bypass.js: ham paketlerle Sonar doğrulaması geçilir │
│    (gravity + protokol tuzakları + boat/minecart kontrolleri)│
│ 3. "verification passed" kick'i → IP doğrulanmış sayılır     │
│ 4. index.js: mineflayer botu bağlanır (/kayit, /giris, AFK)  │
│ 5. Kopma olursa:                                           │
│    - doğrulama kaynaklıysa → 2. adıma dön                    │
│    - normal kopmaysa → 15 sn sonra direkt reconnect          │
└─────────────────────────────────────────────────────────────┘
```

## Kurulum

```bash
npm install
node index.js
```

Gereksinimler: Node.js 18+ (20 önerilir).

## Dosyalar

| Dosya | Görev |
|---|---|
| `index.js` | Ana program: bypass döngüsü + mineflayer AFK bot + konsol sohbeti |
| `sonar-bypass.js` | Sonar bypass modülü (eski `bypass-dynamic.js`; CLI kullanımı da korunur) |
| `resources/codec.js` | Dinamik paket codec'i — tüm ID/layout'lar minecraft-data'dan, sürüm bağımsız |
| `resources/blockstates/` | (Opsiyonel) Orijinal Sonar tabloları buraya konursa öncelikle onlar kullanılır |
| `keep_alive.js` | Uptime ping HTTP sunucusu (Replit/Render vb. için) |
| `config.json` | Tüm ayarlar |
| `test/` | Codec + blok yüksekliği + uçtan uca sahte-Sonar testleri (`npm test`) |

## config.json

```jsonc
{
  "ip": "Supercraft.aternos.me",
  "port": 17598,
  "name": "SuperCraft_Bot",       // "bot"/"afk" içeriyorsa otomatik gerçekçi isim üretilir
  "auth": "offline",
  "password": "afkbot123",        // /kayit ve /giris şifresi
  "ops": ["Ahmet"],               // OP isimleri (logda kırmızı vurgu)
  "renk": "green",                // tellraw sohbet rengi (!renk ile canlı değişir)
  "onek": "[Bot]",
  "version": false,               // false = ping ile otomatik algıla
  "reconnectDelay": 15000,        // normal kopma sonrası bekleme (ms)
  "bypass": {
    "enabled": true,              // Sonar bypass'ı aç/kapat
    "retryDelay": 20000,          // başarısız deneme sonrası bekleme
    "maxRetries": 5,              // bu kadar denemeden sonra uzun bekleme
    "longDelay": 60000,           // uzun bekleme (sunucu kapalıysa vb.)
    "timeoutMs": 75000,           // tek bypass denemesi zaman aşımı
    "brandMode": "sync",          // "sync" veya ms gecikme
    "rawLog": false               // ham paket logları (debug)
  },
  "keepAlive": { "enabled": false, "port": 3000 }
}
```

## Konsol komutları (bot sunucudayken)

- Düz yazı → `tellraw` ile sohbete gönderilir
- `/komut` → sunucuya komut olarak gönderilir
- `!renk red` → sohbet rengini değiştirir

## Sürüm desteği

Codec, paket ID'lerini ve payload layout'larını **minecraft-data'dan dinamik** çözer:
- 1.8.8 → 1.21.11 test edildi (legacy transaction/transaction, configuration state, 1.21.2 teleport sırası, 1.21.4 MovementFlags dahil)
- Bilinmeyen/yeni sürümlerde (ör. 26.x) en yakın bilinen layout ödünç alınır, handshake gerçek protokol numarasıyla yapılır
- Blok yükseklik tablosu yoksa minecraft-data'nın collision shape'lerinden otomatik türetilir (stone=1, slab=0.5, fence=1.5 ...)

## Debug

```bash
# Sadece bypass'ı dene (eski CLI davranışı: exit 42 = geçti)
HOST=Supercraft.aternos.me PORT=17598 USERNAME=Test_01 VERSION=1.20.4 node sonar-bypass.js

# Ham paket logları
RAW_LOG=1 HOST=... node sonar-bypass.js
# veya config.json -> bypass.rawLog: true

# Testler
npm test
```

## Sorun giderme

- **`ECONNREFUSED` / ping hatası:** Aternos sunucusu kapalı olabilir. Önce Aternos panelinden sunucuyu başlat; bot otomatik tekrar dener.
- **Bypass `timeout`:** Sunucuda Sonar yoksa veya farklı bir doğrulama varsa `bypass.enabled: false` yapıp direkt mineflayer + matematik captcha çözücüsünü kullanabilirsin.
- **"sıkıştırma açtı" uyarısı:** Doğrulama sırasında compression açan sunucularda ham mod çalışmaz (Sonar normalde açmaz).
- **Sürüm uyumsuzluğu:** `version` alanına elle sürüm yaz (ör. `"1.20.4"`).

## Not

Bu bot yalnızca **izin alınmış** sunucularda kullanılmalıdır (sunucu sahibi/admin onayı).
Aternos'un hizmet şartları AFK botlarını kısıtlayabilir — sunucu sahibiyle koordineli kullan.
