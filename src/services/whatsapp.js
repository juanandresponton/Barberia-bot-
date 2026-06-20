const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

let clientReady = false;
const chatIdMap = {};

client.on('qr', (qr) => {
  console.log('📱 Escanea este QR con WhatsApp:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  clientReady = true;
  console.log('✅ WhatsApp conectado y listo');
});

client.on('disconnected', (reason) => {
  clientReady = false;
  console.warn('⚠️ WhatsApp desconectado:', reason);
});

const sendMessage = async (to, message) => {
  let chatId;
  let cleaned;

  if (to.includes('@')) {
    chatId = to;
    cleaned = to.replace('@c.us', '').replace('@lid', '').replace(/\D/g, '');
  } else {
    cleaned = to.replace(/\D/g, '');
    chatId = `${cleaned}@c.us`;
  }

  if (!clientReady) {
    console.warn('⚠️ Cliente no listo, mensaje no enviado a:', to);
    return;
  }

  try {
    const sentMsg = await client.sendMessage(chatId, message);

    // Log para debug
    console.log(`📌 sentMsg.to: ${sentMsg?.to} | chatId: ${chatId}`);

    if (sentMsg?.to) {
      chatIdMap[cleaned] = sentMsg.to;
      console.log(`📌 ChatIdMap: ${cleaned} → ${sentMsg.to}`);
    }

    console.log(`📤 Mensaje enviado a ${to}`);
  } catch (err) {
    console.error('Error enviando mensaje:', err.message);
  }
};

const getChatIdMap = () => chatIdMap;
const getClientReady = () => clientReady;

module.exports = { client, sendMessage, getChatIdMap, getClientReady };