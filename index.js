/**
 * WhatsApp Auto-Reply Bot - Railway Optimized (with web QR code)
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const OpenAI = require('openai');
const QRCode = require('qrcode');
const http = require('http');
const url = require('url');
const config = require('./config');

// ------------------------------------------------------------------
// Setup
// ------------------------------------------------------------------

const openai = new OpenAI({
  apiKey: config.openaiApiKey,
});

const isRailway = process.env.RAILWAY_ENVIRONMENT === 'production' || !!process.env.RAILWAY_SERVICE_NAME;
const PORT = process.env.PORT || 3000;

// Store the latest QR code data
let latestQR = null;
let botReady = false;

const puppeteerOptions = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--disable-gpu',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-site-isolation-trials',
  ],
};

if (isRailway || process.env.PUPPETEER_EXECUTABLE_PATH) {
  puppeteerOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
  console.log('[INFO] Using system Chromium at:', puppeteerOptions.executablePath);
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
  puppeteer: puppeteerOptions,
});

// ------------------------------------------------------------------
// In-memory state
// ------------------------------------------------------------------

const contexts = new Map();
const humanHandled = new Set();
const knownChats = new Set();

function getContext(chatId) {
  if (!contexts.has(chatId)) {
    contexts.set(chatId, [
      {
        role: 'system',
        content:
          `You are a friendly, helpful AI assistant acting on behalf of ${config.userName}. ` +
          `Your job is to reply to WhatsApp messages when ${config.userName} is busy. ` +
          `Always start your very first reply in a new conversation with a message like: ` +
          `"Hi, this is ${config.userName}'s AI assistant. ${config.userName} is currently busy but will reply personally when they have free time. How can I help you in the meantime?" ` +
          `After the first message, continue the conversation naturally without repeating that introduction. ` +
          `Be concise, polite, and professional. If you do not know something, say so honestly. ` +
          `Do not make up facts about ${config.userName}'s personal life. ` +
          `If the sender asks for something urgent or sensitive, suggest they call or wait for a personal reply.`,
      },
    ]);
  }
  return contexts.get(chatId);
}

function addToContext(chatId, role, content) {
  const ctx = getContext(chatId);
  ctx.push({ role, content });
  const maxTotal = config.maxContextMessages + 1;
  if (ctx.length > maxTotal) {
    ctx.splice(1, ctx.length - maxTotal);
  }
}

async function isUnknownContact(msg) {
  if (msg.fromMe) return false;
  if (msg.from.endsWith('@g.us')) return false;

  try {
    const contact = await msg.getContact();
    if (!contact.isMyContact) return true;
  } catch (err) {
    console.warn('Could not fetch contact info, treating as unknown:', err.message);
    return true;
  }

  if (!knownChats.has(msg.from)) return true;
  return false;
}

async function generateReply(chatId, incomingText) {
  addToContext(chatId, 'user', incomingText);

  const response = await openai.chat.completions.create({
    model: config.openaiModel,
    messages: getContext(chatId),
    max_tokens: config.maxTokens,
    temperature: config.temperature,
  });

  const replyText = response.choices[0].message.content.trim();
  addToContext(chatId, 'assistant', replyText);
  return replyText;
}

// ------------------------------------------------------------------
// WhatsApp event handlers
// ------------------------------------------------------------------

client.on('qr', async (qr) => {
  latestQR = qr;
  console.log('\n========================================');
  console.log('  QR CODE READY');
  console.log('========================================');
  
  if (isRailway) {
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
    console.log('\n  Open this URL in your browser to scan the QR code:');
    console.log(`  ${qrUrl}`);
    console.log('\n  Or visit your Railway domain to see it.');
  } else {
    const qrcodeTerminal = require('qrcode-terminal');
    qrcodeTerminal.generate(qr, { small: true });
  }
  console.log('========================================\n');
});

client.on('authenticated', () => {
  latestQR = null;
  console.log('Authenticated successfully. Session will be persisted.');
});

client.on('auth_failure', (msg) => {
  console.error('Authentication failed:', msg);
  console.error('Try deleting the ./.wwebjs_auth folder and restarting.');
});

client.on('ready', () => {
  botReady = true;
  latestQR = null;
  console.log('\n========================================');
  console.log('  Bot is ready and listening!');
  console.log('========================================');
  console.log(`  Model:     ${config.openaiModel}`);
  console.log(`  User Name: ${config.userName}`);
  console.log(`  Reply to:  ${config.replyToAll ? 'ALL contacts' : 'Unknown contacts only'}`);
  console.log('========================================\n');
});

client.on('message_create', async (msg) => {
  try {
    if (msg.from === 'status@broadcast') return;
    if (!msg.body || msg.body.trim().length === 0) return;

    const text = msg.body.trim();

    if (msg.fromMe) {
      const lower = text.toLowerCase();

      if (lower === '!human') {
        humanHandled.add(msg.to);
        contexts.delete(msg.to);
        console.log(`[CMD] Marked ${msg.to} as human-handled. AI will no longer reply.`);
        return;
      }

      if (lower === '!ai') {
        humanHandled.delete(msg.to);
        console.log(`[CMD] Re-enabled AI for ${msg.to}.`);
        return;
      }

      if (lower === '!reset') {
        contexts.delete(msg.to);
        console.log(`[CMD] Reset conversation context for ${msg.to}.`);
        return;
      }

      if (lower === '!status') {
        console.log('\n--- Bot Status ---');
        console.log(`Active AI contexts: ${contexts.size}`);
        console.log(`Human-handled chats: ${humanHandled.size}`);
        console.log(`Known chats: ${knownChats.size}`);
        console.log('------------------\n');
        return;
      }

      if (!lower.startsWith('!') && contexts.has(msg.to)) {
        humanHandled.add(msg.to);
        contexts.delete(msg.to);
        console.log(`[AUTO] Owner replied in ${msg.to}. Marked as human-handled.`);
      }

      return;
    }

    knownChats.add(msg.from);

    if (humanHandled.has(msg.from)) {
      return;
    }

    const isUnknown = await isUnknownContact(msg);
    if (!isUnknown && !config.replyToAll) {
      return;
    }

    const chat = await msg.getChat();
    await chat.sendStateTyping();

    const replyText = await generateReply(msg.from, text);
    await msg.reply(replyText);

    await chat.clearState();

    console.log(`[REPLY] ${msg.from}: "${text.substring(0, 40)}${text.length > 40 ? '...' : ''}" -> AI replied.`);
  } catch (err) {
    console.error('[ERROR] Failed to handle message:', err.message);
    if (err.response) {
      console.error('[ERROR] OpenAI details:', err.response.status, err.response.statusText);
    }
  }
});

client.on('disconnected', (reason) => {
  botReady = false;
  console.warn('\n[DISCONNECTED]', reason);
  console.log('Will attempt to reconnect in 5 seconds...\n');

  setTimeout(() => {
    console.log('[RECONNECT] Re-initialising client...');
    client.initialize().catch((err) => {
      console.error('[RECONNECT] Re-initialisation failed:', err.message);
    });
  }, 5000);
});

process.on('SIGINT', async () => {
  console.log('\n\nReceived SIGINT. Shutting down gracefully...');
  try {
    await client.destroy();
    console.log('Client destroyed. Goodbye!');
  } catch (err) {
    console.error('Error during shutdown:', err.message);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nReceived SIGTERM. Shutting down gracefully...');
  try {
    await client.destroy();
  } catch (err) {
    // ignore
  }
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

// ------------------------------------------------------------------
// Web server - serves QR code and status page
// ------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);

  if (parsedUrl.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  if (parsedUrl.pathname === '/qr') {
    if (!latestQR) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>WhatsApp Bot</title></head>
        <body style="font-family:sans-serif;text-align:center;padding:40px;">
          <h2>${botReady ? '✅ Bot is connected!' : '⏳ Waiting for QR code...'}</h2>
          ${botReady ? '<p>The bot is ready and listening for messages.</p>' : '<p>Refresh this page in a few seconds.</p>'}
        </body>
        </html>
      `);
      return;
    }

    try {
      const qrDataUrl = await QRCode.toDataURL(latestQR, { width: 300, margin: 2 });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Scan QR Code - WhatsApp Bot</title>
          <style>
            body { font-family: sans-serif; text-align: center; padding: 20px; background: #f5f5f5; }
            .box { background: white; padding: 30px; border-radius: 12px; max-width: 400px; margin: 0 auto; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            h2 { color: #333; }
            img { max-width: 100%; border-radius: 8px; }
            p { color: #666; font-size: 14px; }
            .steps { text-align: left; background: #f9f9f9; padding: 15px; border-radius: 8px; margin-top: 20px; }
            .steps li { margin-bottom: 8px; }
          </style>
        </head>
        <body>
          <div class="box">
            <h2>📱 Scan this QR Code with WhatsApp</h2>
            <img src="${qrDataUrl}" alt="WhatsApp QR Code">
            <div class="steps">
              <ol>
                <li>Open WhatsApp on your phone</li>
                <li>Go to Settings → Linked Devices</li>
                <li>Tap "Link a Device"</li>
                <li>Point camera at the code above</li>
              </ol>
            </div>
            <p><strong>Once scanned, the bot will start automatically.</strong></p>
          </div>
        </body>
        </html>
      `);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error generating QR code: ' + err.message);
    }
    return;
  }

  // Root path - redirect to /qr
  res.writeHead(302, { 'Location': '/qr' });
  res.end();
});

server.listen(PORT, () => {
  console.log(`[INFO] Web server running on port ${PORT}`);
  if (isRailway) {
    console.log(`[INFO] Visit your Railway domain + /qr to see the QR code`);
  }
});

// ------------------------------------------------------------------
// Start
// ------------------------------------------------------------------

console.log('Starting WhatsApp Auto-Reply Bot...');
console.log(`[INFO] Environment: ${isRailway ? 'Railway' : 'Local'}`);
client.initialize().catch((err) => {
  console.error('Failed to initialise client:', err.message);
  process.exit(1);
});
