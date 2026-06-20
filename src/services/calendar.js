const { google } = require('googleapis');
const path = require('path');

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, '../config/barber-bot.json'),
  scopes: ['https://www.googleapis.com/auth/calendar']
});

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

const SLOTS_TODOS = [
  { label: '8:00 AM',  hour: 8,  minute: 0 },
  { label: '9:00 AM',  hour: 9,  minute: 0 },
  { label: '10:00 AM', hour: 10, minute: 0 },
  { label: '11:00 AM', hour: 11, minute: 0 },
  { label: '12:00 PM', hour: 12, minute: 0 },
  { label: '1:00 PM',  hour: 13, minute: 0 },
  { label: '2:00 PM',  hour: 14, minute: 0 },
  { label: '3:00 PM',  hour: 15, minute: 0 },
  { label: '4:00 PM',  hour: 16, minute: 0 }
];

async function getCalendarClient() {
  const authClient = await auth.getClient();
  return google.calendar({ version: 'v3', auth: authClient });
}

function horaEnColombia(dateTime) {
  const fecha  = new Date(dateTime);
  const bogota = new Date(fecha.toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  return { hour: bogota.getHours(), minute: bogota.getMinutes() };
}

async function getSlotsDisponibles(fecha) {
  const calendar = await getCalendarClient();

  const inicio = new Date(`${fecha}T00:00:00-05:00`);
  const fin    = new Date(`${fecha}T23:59:59-05:00`);

  const res = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: inicio.toISOString(),
    timeMax: fin.toISOString(),
    singleEvents: true,
    orderBy: 'startTime'
  });

  const eventos  = res.data.items || [];
  const ocupados = eventos
    .filter(e => e.start.dateTime)
    .map(e => {
      const h = horaEnColombia(e.start.dateTime);
      return `${h.hour}:${h.minute}`;
    });

  console.log(`📅 Slots ocupados el ${fecha}:`, ocupados);

  const ahoraColombia = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const fechaDate     = new Date(fecha + 'T12:00:00-05:00');
  const esHoy         = fechaDate.toDateString() === ahoraColombia.toDateString();
  const horaActual    = ahoraColombia.getHours() + ahoraColombia.getMinutes() / 60;

  const disponibles = SLOTS_TODOS.filter(slot => {
    const key      = `${slot.hour}:${slot.minute}`;
    const horaSlot = slot.hour + slot.minute / 60;
    if (ocupados.includes(key)) return false;
    if (esHoy && horaSlot <= horaActual) return false;
    return true;
  });

  console.log(`✅ Slots disponibles el ${fecha}:`, disponibles.map(s => s.label));
  return disponibles.map(s => s.label);
}

async function crearCita({ nombre, telefono, fecha, hora }) {
  const calendar = await getCalendarClient();

  const [time, period] = hora.split(' ');
  let [h, m] = time.split(':').map(Number);
  if (period === 'PM' && h !== 12) h += 12;
  if (period === 'AM' && h === 12) h = 0;

  const inicio = new Date(`${fecha}T${String(h).padStart(2,'0')}:${String(m || 0).padStart(2,'0')}:00-05:00`);
  const fin    = new Date(inicio.getTime() + 60 * 60 * 1000);

  const evento = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary: `✂️ ${nombre}`,
      description: `Teléfono: ${telefono}`,
      start: { dateTime: inicio.toISOString(), timeZone: 'America/Bogota' },
      end:   { dateTime: fin.toISOString(),    timeZone: 'America/Bogota' }
    }
  });

  console.log(`✅ Cita creada en Calendar: ${nombre} ${fecha} ${hora}`);
  return evento.data.id;
}

async function cancelarCita(eventId) {
  const calendar = await getCalendarClient();
  await calendar.events.delete({
    calendarId: CALENDAR_ID,
    eventId
  });
  console.log(`🗑️ Cita cancelada en Calendar: ${eventId}`);
}

module.exports = { getSlotsDisponibles, crearCita, cancelarCita };