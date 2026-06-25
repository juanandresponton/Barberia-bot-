require('dotenv').config();
const { client, sendMessage, getChatIdMap } = require('./services/whatsapp');
const { normalizarTelefono, getClienteByPhone } = require('./services/sheets');
const { manejarBarbero, setBarberoStep } = require('./handlers/barbero');
const { manejarCliente, clienteState }   = require('./handlers/cliente');
const {
  enviarRecordatorioDiaAnterior,
  enviarRecordatorio15Min,
  enviarRecordatorioFrecuencia,
  marcarNoAsistidos,
  enviarBienvenidaNuevosClientes
} = require('./handlers/crons');
const cron = require('node-cron');

const BARBER_PHONE = process.env.BARBER_PHONE;
const BARBER_LID   = process.env.BARBER_LID;

let disponibilidadSemana  = { abre: null, sabado: false, domingo: false };
function setDisponibilidad(val) { disponibilidadSemana = val; }

let semanaActual          = null;
let disponibilidadEnviada = false;

const mensajesProcesados = new Map();
const DEDUP_TTL = 5000;

function getSemana() {
  const hoy    = new Date();
  const inicio = new Date(hoy.getFullYear(), 0, 1);
  const semana = Math.ceil(((hoy - inicio) / 86400000 + inicio.getDay() + 1) / 7);
  return `${hoy.getFullYear()}-S${semana}`;
}

function esBarbero(from) {
  return from === `${BARBER_PHONE}@c.us` || from === BARBER_LID;
}

client.on('message', async (msg) => {
  if (msg.fromMe) return;
  if (msg.from === 'status@broadcast') return;
  if (!msg.body || !msg.body.trim()) { console.log('⏭️ Mensaje vacío ignorado'); return; }
  if (msg.body.length > 300) { console.log('⏭️ Mensaje largo ignorado'); return; }

  const ahora = Date.now();
  const tiempoMensaje = msg.timestamp * 1000;
  if (ahora - tiempoMensaje > 30000) { console.log(`⏭️ Mensaje viejo ignorado`); return; }

  const deduKey = `${msg.body}_${msg.timestamp}`;
  if (mensajesProcesados.has(deduKey)) { console.log('⏭️ Duplicado ignorado'); return; }
  mensajesProcesados.set(deduKey, ahora);
  for (const [k, t] of mensajesProcesados.entries()) {
    if (ahora - t > DEDUP_TTL) mensajesProcesados.delete(k);
  }

  const botNumber = client.info?.wid?._serialized;
  if (botNumber && msg.from === botNumber) return;

  const from = msg.from;
  const body = msg.body.trim();

  let telefono = normalizarTelefono(from.replace('@c.us', '').replace('@lid', ''));

  if (from.includes('@lid')) {
    const map = getChatIdMap();
    const numMapeado = Object.keys(map).find(num => map[num] === from);

    if (numMapeado) {
      const telefonoResuelto = normalizarTelefono(numMapeado);
      const clienteVerif = await getClienteByPhone(telefonoResuelto);
      if (clienteVerif) {
        telefono = telefonoResuelto;
        console.log(`📱 Paso 1 chatIdMap → ${telefono}`);
      }
    }

    if (telefono === normalizarTelefono(from.replace('@lid', ''))) {
      const clientePorLid = await getClienteByPhone(from.replace('@lid', ''));
      if (clientePorLid) {
        telefono = clientePorLid.telefono;
        console.log(`📱 Paso 0 LID directo → ${telefono}`);
      }
    }

    if (telefono === normalizarTelefono(from.replace('@lid', ''))) {
      try {
        const contact = await msg.getContact();
        if (contact.number) {
          const num = normalizarTelefono(contact.number);
          const cliente = await getClienteByPhone(num);
          if (cliente) {
            telefono = num;
            console.log(`📱 Paso 2 getContact → ${telefono}`);
          } else {
            const corto = normalizarTelefono(contact.number.slice(-10));
            const clienteCorto = await getClienteByPhone(corto);
            if (clienteCorto) { telefono = corto; console.log(`📱 Paso 2b → ${telefono}`); }
          }
        }
      } catch (e) { console.log(`⚠️ getContact falló: ${e.message}`); }
    }
  }

  console.log(`📩 Mensaje de ${from} | telefono: ${telefono} | body: ${body}`);

  if (esBarbero(from)) {
    console.log(`✅ Reconocido como barbero`);
    await manejarBarbero(from, body, disponibilidadSemana, setDisponibilidad, clienteState);
    return;
  }

  await manejarCliente(from, telefono, body, disponibilidadSemana, msg);
});

async function preguntarDisponibilidad() {
  const semana = getSemana();
  if (disponibilidadEnviada && semanaActual === semana) { console.log('⏭️ Ya se envió esta semana'); return; }

  console.log('📤 Preguntando disponibilidad al barbero...');
  semanaActual          = semana;
  disponibilidadEnviada = true;

  setBarberoStep('abre');
  const destino = BARBER_LID || `${BARBER_PHONE}@c.us`;
  
  await sendMessage(destino,
  `✂️ ¡Hola! ¿Vas a abrir *Saviac Estilo* este *fin de semana*?\n\n1) Sí, voy a abrir\n2) No, este fin descanso\n\n_Responde con el número de tu opción_`
);
}

function resetDisponibilidad() {
  disponibilidadSemana  = { abre: null, sabado: false, domingo: false };
  disponibilidadEnviada = false;
  semanaActual          = null;
  console.log('🔄 Disponibilidad reseteada');
}

let whatsappListo = false;
client.on('ready', () => { whatsappListo = true; console.log('✅ WhatsApp listo'); });

// Disponibilidad — PROD: jueves 6PM
cron.schedule('0 10 * * 4', async () => {
  if (!whatsappListo) return;
  console.log('⏰ Cron disponibilidad...');
  await preguntarDisponibilidad();
}, { timezone: 'America/Bogota', runOnInit: false });

// Bienvenida nuevos clientes — PROD: cada 30 min
cron.schedule('*/30 * * * *', async () => {
  if (!whatsappListo) return;
  await enviarBienvenidaNuevosClientes();
}, { timezone: 'America/Bogota', runOnInit: false });

// Recordatorio día anterior — PROD: 8PM todos los días
cron.schedule('0 20 * * *', async () => {
  if (!whatsappListo) return;
  console.log('⏰ Cron recordatorio día anterior...');
  await enviarRecordatorioDiaAnterior(clienteState);
}, { timezone: 'America/Bogota', runOnInit: false });

// Recordatorio 15 min — PROD: cada minuto
cron.schedule('* * * * *', async () => {
  if (!whatsappListo) return;
  await enviarRecordatorio15Min(clienteState);
}, { timezone: 'America/Bogota', runOnInit: false });

// Recordatorio frecuencia — PROD: viernes 10AM
cron.schedule('0 10 * * 5', async () => {
  if (!whatsappListo) return;
  console.log('⏰ Cron recordatorio frecuencia...');
  await enviarRecordatorioFrecuencia(disponibilidadSemana, clienteState);
}, { timezone: 'America/Bogota', runOnInit: false });

// Marcar no asistidos — PROD: medianoche todos los días
cron.schedule('0 0 * * *', async () => {
  if (!whatsappListo) return;
  console.log('⏰ Cron marcar no asistidos...');
  await marcarNoAsistidos();
}, { timezone: 'America/Bogota', runOnInit: false });

// Reset disponibilidad — PROD: lunes medianoche
cron.schedule('0 0 * * 1', async () => {
  if (!whatsappListo) return;
  resetDisponibilidad();
}, { timezone: 'America/Bogota', runOnInit: false });

client.initialize();
console.log('🚀 Saviac Estilo Bot iniciado...');