// bot.js – forward trigger ke owner WhatsApp + grup Telegram dengan voice note
const twilio = require('twilio')
const fs = require('fs')
const path = require('path')
const makeWASocket = require('@whiskeysockets/baileys').default
const { useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const qrcode = require('qrcode-terminal')
const axios = require('axios')
const googleTTS = require('google-tts-api')
const { execFile } = require('child_process')
const FormData = require('form-data')

// load env dari bot.env dulu kalau ada, lalu fallback ke .env
if (fs.existsSync('bot.env')) {
  require('dotenv').config({ path: 'bot.env' })
} else {
  require('dotenv').config()
}

// ==== Konfigurasi ====
const nomorTujuanAwal = '6287780010053@s.whatsapp.net' // sumber pesan/trigger
const nomorForwardKe = process.env.WHATSAPP_OWNER // owner WhatsApp
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER
const NOMOR_PENERIMA_PANGGILAN = process.env.WHATSAPP_OWNER.replace('@s.whatsapp.net', '')

// Debug konfigurasi
console.log('=== konfigurasi ===')
console.log('WHATSAPP_OWNER =', nomorForwardKe)
console.log('TELEGRAM_BOT_TOKEN =', TELEGRAM_BOT_TOKEN ? '[TERSEDIA]' : '[TIDAK ADA]')
console.log('TELEGRAM_CHAT_ID =', TELEGRAM_CHAT_ID)
console.log('===================')
console.log('TWILIO_PHONE_NUMBER =', TWILIO_PHONE_NUMBER)

// Validasi
if (!nomorForwardKe) {
  console.error('❌ WHATSAPP_OWNER tidak diset di bot.env/.env')
  process.exit(1)
}
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID tidak diset di bot.env/.env')
  process.exit(1)
}
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
  console.error('❌ Kredensial TWILIO tidak diset di bot.env/.env')
  // Anda bisa memilih untuk tidak exit(1) jika panggilan hanya fitur opsional
}

// ==== Persist last trigger (optional) ====
const TRIGGER_STORE = path.resolve('./last_trigger.txt')
let lastTriggerText = ''
try {
  if (fs.existsSync(TRIGGER_STORE)) {
    lastTriggerText = fs.readFileSync(TRIGGER_STORE, 'utf-8').trim()
  }
} catch (e) {
  console.warn('[warn] gagal baca last trigger dari disk:', e)
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args)
}
function saveLastTrigger(text) {
  lastTriggerText = text
  try {
    fs.writeFileSync(TRIGGER_STORE, text, 'utf-8')
  } catch (e) {
    console.warn('[warn] gagal simpan last trigger ke disk:', e)
  }
}

// ==== Batas 2x per trigger untuk Telegram dengan reset ====
const triggerCountMap = new Map() // key: triggerText, value: { count, lastSeen }
const RESET_MS = 5 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const [text, info] of triggerCountMap.entries()) {
    if (now - info.lastSeen > RESET_MS) {
      triggerCountMap.delete(text)
    }
  }
}, 60_000)

// ==== Logika Panggilan Telepon dengan Cooldown ====
const MAX_ALARM_CALLS = 3
const CALL_COOLDOWN_MS = 5 * 60 * 1000 // 5 menit
let alarmCallState = {
  count: 0,
  lastCalled: 0,
  isTriggered: false,
}

// Fungsi yang terus berjalan untuk mengecek status alarm
setInterval(async () => {
  if (alarmCallState.isTriggered) {
    const now = Date.now()
    // Cek apakah belum melebihi batas panggilan
    // DAN apakah sudah melewati waktu cooldown
    if (alarmCallState.count < MAX_ALARM_CALLS && (now - alarmCallState.lastCalled) > CALL_COOLDOWN_MS) {
      try {
        const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
        await twilioClient.calls.create({
          twiml: '<Response><Say voice="male">Alarm. Ada pesan tidak terduga.</Say><Hangup/></Response>',
          to: NOMOR_PENERIMA_PANGGILAN,
          from: TWILIO_PHONE_NUMBER,
        })
        log(`📞 Panggilan alarm ke ${NOMOR_PENERIMA_PANGGILAN} berhasil. Panggilan ke-${alarmCallState.count + 1}.`)
        alarmCallState.count += 1
        alarmCallState.lastCalled = now
      } catch (callError) {
        log('❌ Gagal membuat panggilan alarm:', callError.message || callError)
      }
    } else if (alarmCallState.count >= MAX_ALARM_CALLS) {
      // Hentikan alarm jika sudah mencapai batas
      alarmCallState.isTriggered = false
      log('⚠️ Sudah 3x panggilan alarm untuk trigger ini, alarm dimatikan.')
    }
  }
}, 10_000) // Cek setiap 10 detik

// ==== Helper WhatsApp ====
async function forwardToWhatsAppOwner(sock, messageText) {
  try {
    await sock.sendMessage(nomorForwardKe, { text: messageText })
    log(`➡️ Forward ke WhatsApp owner ${nomorForwardKe}:`, messageText.split('\n')[0])
  } catch (e) {
    log('❌ Gagal forward ke WhatsApp owner:', e?.message || e)
  }
}

// ekstrak teks dari berbagai tipe pesan
function extractTextFromMessage(msg) {
  if (!msg.message) return ''
  if (msg.message.conversation) return msg.message.conversation
  if (msg.message.extendedTextMessage?.text) return msg.message.extendedTextMessage.text
  if (msg.message?.imageMessage?.caption) return msg.message.imageMessage.caption
  if (msg.message?.videoMessage?.caption) return msg.message.videoMessage.caption
  if (msg.message?.buttonsResponseMessage?.selectedButtonId) return msg.message.buttonsResponseMessage.selectedButtonId
  if (msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId) return msg.message.listResponseMessage.singleSelectReply.selectedRowId
  return ''
}

// ==== Helper Telegram teks ====
async function sendToTelegram(text) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: Number(TELEGRAM_CHAT_ID),
      text,
      parse_mode: 'Markdown'
    })
    log(`➡️ Forward ke Telegram ${TELEGRAM_CHAT_ID}:`, text.split('\n')[0])
  } catch (e) {
    log(`❌ Gagal forward ke Telegram ${TELEGRAM_CHAT_ID}:`, e?.response?.data || e.message || e)
  }
}

// ==== Helper Telegram voice ====
async function sendVoiceToTelegram(filePath, caption = '') {
  try {
    const form = new FormData()
    form.append('chat_id', Number(TELEGRAM_CHAT_ID))
    form.append('voice', fs.createReadStream(filePath))
    if (caption) form.append('caption', caption)

    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVoice`, form, {
      headers: form.getHeaders()
    })
    log(`🎙️ Voice note dikirim ke Telegram ${TELEGRAM_CHAT_ID}:`, caption.split('\n')[0])
  } catch (e) {
    log('❌ Gagal kirim voice note ke Telegram:', e?.response?.data || e.message || e)
  }
}

// ==== TTS + konversi ke OGG/Opus ====
async function downloadToFile(url, filePath) {
  const writer = fs.createWriteStream(filePath)
  const res = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
  })
  return new Promise((resolve, reject) => {
    res.data.pipe(writer)
    writer.on('finish', resolve)
    writer.on('error', reject)
  })
}

async function createVoiceNoteOgg(text, outPath) {
  try {
    const url = await googleTTS.getAudioUrl(text, {
      lang: 'id',
      slow: false,
      host: 'https://translate.google.com',
    })
    const tmpMp3 = outPath + '.mp3'
    await downloadToFile(url, tmpMp3)
    await new Promise((resolve, reject) => {
      execFile('ffmpeg', [
        '-y',
        '-i', tmpMp3,
        '-c:a', 'libopus',
        '-b:a', '32k',
        outPath
      ], (err) => {
        try { fs.unlinkSync(tmpMp3) } catch {}
        if (err) return reject(err)
        resolve()
      })
    })
  } catch (e) {
    throw new Error('Gagal buat voice note: ' + e.message)
  }
}

// ==== Trigger pattern ====
// Pemicu sekarang mencari pesan yang TIDAK termasuk dalam 3 pesan standar ini
const part1 = /Selamat datang di akun Whatsapp Resmi HYDROPLUS/i
const part2 = /Yuk coba lagi dengan kode unik yang lain di dalam tutup botol HYDROPLUS untuk dapatkan hadiahnya/i
const part3 = /Terima kasih telah berpartisipasi dalam program HYDROPLUS Nonstop Miliaran🤗[\s\S]*Ketik "Hi" untuk memulai chatting kembali/i

// ==== Hi loop controller ====
let hiLoopController = { running: false }
let sockInstance = null

async function hiLoop(sock) {
  if (hiLoopController.running) return
  hiLoopController.running = true
  log('✅ Mulai loop kirim "hi" setiap ~1 menit (adaptive)')
  while (sock && sock.user) {
    const start = Date.now()
    try {
      await sock.sendMessage(nomorTujuanAwal, { text: 'hi' })
      log(`✅ Pesan "hi" dikirim ke ${nomorTujuanAwal}`)
    } catch (err) {
      log('❌ Gagal kirim "hi":', err?.message || err)
      await delay(10_000)
    }
    const elapsed = Date.now() - start
    const waitTime = Math.max(60_000 - elapsed, 0)
    await delay(waitTime)
  }
  hiLoopController.running = false
}

// ==== Start bot ====
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false
  })
  sockInstance = sock

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) qrcode.generate(qr, { small: true })

    if (connection === 'open') {
      log('🆔 Nomor login (bot):', sock.user?.id || 'unknown')
      log('✅ Bot tersambung!')
      hiLoop(sock).catch(e => log('❌ hiLoop error:', e))
    } else if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        && lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
      log('❌ Koneksi tertutup. Reconnect:', shouldReconnect)
      if (shouldReconnect) {
        await delay(5_000)
        startBot().catch(e => log('❌ Gagal restart bot:', e))
      } else {
        log('⚠️ Tidak reconnect karena logout permanen.')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    const msg = messages[0]
    if (!msg || !msg.message) return
    const sender = msg.key.remoteJid
    const text = extractTextFromMessage(msg).trim()

    if (sender === nomorTujuanAwal && text.length > 0) {
      // forward umum ke WhatsApp owner
      await forwardToWhatsAppOwner(sock, `📩 Diteruskan dari ${nomorTujuanAwal}:\n${text}`)

      // deteksi trigger
      const hasPart1 = part1.test(text)
      const hasPart2 = part2.test(text)
      const hasPart3 = part3.test(text)
      if (!hasPart1 && !hasPart2 && !hasPart3) {
        saveLastTrigger(text)
        
        // Aktifkan alarm jika ada pesan tak terduga
        alarmCallState.isTriggered = true

        try {
          // === WhatsApp owner ===
          // voice note "BOT SUDAH ON!" terlebih dulu
          try {
            const tmpOggWA = './bot_sudah_on_whatsapp.ogg'
            await createVoiceNoteOgg('Bot sudah on!', tmpOggWA)
            await sock.sendMessage(nomorForwardKe, {
              audio: fs.readFileSync(tmpOggWA),
              ptt: true
            })
            log('🎙️ Voice note "BOT SUDAH ON!" dikirim ke owner WhatsApp')
            fs.unlinkSync(tmpOggWA)
          } catch (err) {
            log('⚠️ Gagal voice note WhatsApp, fallback teks:', err.message || err)
            await forwardToWhatsAppOwner(sock, 'BOT SUDAH ON!')
          }
          // detail trigger ke WA owner
          await forwardToWhatsAppOwner(sock, `📣 [TRIGGER] ${text}`)

          // === Telegram (maksimal 2x per teks) ===
          const now = Date.now()
          const entry = triggerCountMap.get(text) || { count: 0, lastSeen: now }
          entry.lastSeen = now

          if (entry.count < 2) {
            // Kirim teks ke Telegram
            await sendToTelegram('BOT SUDAH ON!')
            await sendToTelegram(`📣 [TRIGGER] ${text}`)

            // Kirim voice note ke Telegram
            try {
              const tmpVoiceTG = './bot_sudah_on_telegram.ogg'
              await createVoiceNoteOgg('Bot sudah on!', tmpVoiceTG)
              await sendVoiceToTelegram(tmpVoiceTG, 'BOT SUDAH ON!')
              fs.unlinkSync(tmpVoiceTG)
            } catch (e) {
              log('⚠️ Gagal buat/kirim voice note ke Telegram:', e?.message || e)
            }

            entry.count += 1
            triggerCountMap.set(text, entry)
          } else {
            log('⚠️ Sudah forward 2x untuk trigger ini ke Telegram, melewatkan.')
          }
        } catch (err) {
          log('❌ Error saat handle trigger multi-forward dengan voice note:', err?.message || err)
        }
      }
    }
  })

  process.on('unhandledRejection', (reason) => {
    log('🔥 Unhandled Rejection:', reason)
  })
  process.on('uncaughtException', (err) => {
    log('🔥 Uncaught Exception:', err)
  })
}

// ==== Graceful shutdown ====
function setupExitHandlers() {
  const clean = () => {
    log('🛑 Sinyal shutdown diterima, keluar...')
    process.exit(0)
  }
  process.on('SIGINT', clean)
  process.on('SIGTERM', clean)
}

setupExitHandlers()
startBot().catch(e => log('❌ Fatal error saat mulai bot:', e))
