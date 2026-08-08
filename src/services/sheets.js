const { google } = require('googleapis');
const path = require('path');

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, '../config/barber-bot.json'),
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/calendar'
  ]
});

const SHEET_ID = process.env.GOOGLE_SHEET_ID;

const HOJAS = {
  clientes:       'clientes',
  disponibilidad: 'disponibilidad',
  citas:          'citas',
  pendientes:     'pendientes',
  profesionales:  'profesionales',
  servicios:      'servicios',
  productos:      'productos'
};

async function getSheetsClient() {
  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

function normalizarTelefono(telefono) {
  let num = String(telefono).replace(/[\s\-\(\)\+]/g, '');
  if (num.startsWith('0')) num = '57' + num.slice(1);
  if (num.startsWith('3') && num.length === 10) num = '57' + num;
  return num;
}

// ─── CLIENTES ────────────────────────────────────────────
async function getClientes() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${HOJAS.clientes}!A2:M`
  });

  const rows = res.data.values || [];
  return rows
    .map((row, index) => ({ ...row, _rowIndex: index + 2 }))
    .filter(row => row[2])
    .map(row => ({
      rowIndex:                row._rowIndex,
      marca_temporal:          row[0] || '',
      nombre:                  row[1] || '',
      telefono:                normalizarTelefono(row[2] || ''),
      tipo_corte:              row[3] || '',
      frecuencia:              row[4] || '',
      ultimo_corte:            row[5] || '',
      proximo_recordatorio:    row[6] || '',
      estado:                  row[7] || 'activo',
      veces_cancelo:           row[8] || '0',
      whatsapp_lid:            row[9] || '',
      citas_canceladas_admin:  row[10] || '0',
      profesional_origen:      row[11] || '',
      profesional_preferido:   row[12] || ''
    }));
}

async function getClienteByPhone(telefono) {
  const telefonoNorm = normalizarTelefono(telefono);
  const soloNumeros  = String(telefono).replace(/\D/g, '');
  const clientes     = await getClientes();

  return clientes.find(c => {
    const telSheet     = normalizarTelefono(c.telefono);
    const telSheetBase = String(c.telefono).replace(/\D/g, '');
    const lidEnSheet   = String(c.whatsapp_lid || '').replace('@lid', '').replace('@c.us', '');
    return (
      telSheet     === telefonoNorm ||
      telSheetBase === soloNumeros  ||
      telSheetBase === telefonoNorm ||
      c.whatsapp_lid === telefono   ||
      lidEnSheet    === soloNumeros
    );
  }) || null;
}

async function updateCliente(rowIndex, columna, valor) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${HOJAS.clientes}!${columna}${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[valor]] }
  });
}

async function guardarLid(rowIndex, lid) {
  await updateCliente(rowIndex, 'J', lid);
  console.log(`💾 LID guardado en fila ${rowIndex}: ${lid}`);
}

async function guardarProfesionalOrigen(rowIndex, profesionalId) {
  await updateCliente(rowIndex, 'L', profesionalId);
  console.log(`💾 Profesional origen guardado: ${profesionalId}`);
}

async function guardarProfesionalPreferido(rowIndex, profesionalId) {
  await updateCliente(rowIndex, 'M', profesionalId);
  console.log(`💾 Profesional preferido guardado: ${profesionalId}`);
}

async function actualizarUltimoCorte(rowIndex, frecuencia) {
  const hoy    = new Date();
  const proximo = new Date(hoy);
  const dias   = parseInt(String(frecuencia).replace(/\D/g, '')) || 15;
  proximo.setDate(hoy.getDate() + dias);
  await updateCliente(rowIndex, 'F', hoy.toISOString().split('T')[0]);
  await updateCliente(rowIndex, 'G', proximo.toISOString().split('T')[0]);
  await updateCliente(rowIndex, 'H', 'activo');
  console.log(`✅ Último corte actualizado | próximo: ${proximo.toISOString().split('T')[0]}`);
}

async function resetearCancelaciones(rowIndex) {
  await updateCliente(rowIndex, 'I', '0');
  console.log(`✅ Cancelaciones reseteadas`);
}

async function setProximoRecordatorio8Dias(rowIndex) {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() + 8);
  await updateCliente(rowIndex, 'G', fecha.toISOString().split('T')[0]);
  console.log(`📅 Próximo recordatorio en 8 días`);
}

async function marcarClienteInactivo(rowIndex) {
  await updateCliente(rowIndex, 'H', 'inactivo');
  console.log(`🚫 Cliente marcado como inactivo`);
}

async function borrarCliente(rowIndex) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${HOJAS.clientes}!A${rowIndex}:M${rowIndex}`
  });
  console.log(`🗑️ Cliente borrado de fila ${rowIndex}`);
}

async function sumarCancelacion(rowIndex, vecesCancelo) {
  const nuevo = parseInt(vecesCancelo || 0) + 1;
  await updateCliente(rowIndex, 'I', String(nuevo));
  return nuevo;
}

async function sumarCitasCanceladasAdmin(rowIndex, vecesActual) {
  const nuevo = parseInt(vecesActual || 0) + 1;
  await updateCliente(rowIndex, 'K', String(nuevo));
  console.log(`📊 Citas canceladas por admin: ${nuevo}`);
}

async function sumarNoAsistio(rowIndex) {
  console.log(`⚠️ sumarNoAsistio: no hay columna disponible`);
}

// ─── PROFESIONALES ───────────────────────────────────────
async function getProfesionales() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${HOJAS.profesionales}!A2:E`
  });
  const rows = res.data.values || [];
  return rows
    .map((row, index) => ({ ...row, _rowIndex: index + 2 }))
    .filter(row => row[0])
    .map(row => ({
      rowIndex:    row._rowIndex,
      id:          row[0] || '',
      nombre:      row[1] || '',
      tipo:        row[2] || '',
      estado:      row[3] || 'activo',
      calendar_id: row[4] || ''
    }));
}

async function getProfesionalById(id) {
  const profesionales = await getProfesionales();
  return profesionales.find(p => p.id === id) || null;
}

async function getProfesionalesByTipo(tipo) {
  const profesionales = await getProfesionales();
  return profesionales.filter(p => p.tipo === tipo && p.estado === 'activo');
}

// ─── SERVICIOS ───────────────────────────────────────────
async function getServicios() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${HOJAS.servicios}!A2:G`
  });
  const rows = res.data.values || [];
  return rows
    .map((row, index) => ({ ...row, _rowIndex: index + 2 }))
    .filter(row => row[0])
    .map(row => ({
      rowIndex:      row._rowIndex,
      id:            row[0] || '',
      nombre:        row[1] || '',
      categoria:     row[2] || '',
      duracion_min:  parseInt(row[3] || '45'),
      precio:        parseInt(row[4] || '0'),
      profesionales: row[5] || '',
      activo:        row[6] !== 'FALSE'
    }));
}

async function getServicioById(id) {
  const servicios = await getServicios();
  return servicios.find(s => s.id === id) || null;
}

async function getServiciosByCategoria(categoria) {
  const servicios = await getServicios();
  return servicios.filter(s => s.categoria === categoria && s.activo);
}

// ─── PRODUCTOS ───────────────────────────────────────────
async function getProductos() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${HOJAS.productos}!A2:F`
  });
  const rows = res.data.values || [];
  return rows
    .map((row, index) => ({ ...row, _rowIndex: index + 2 }))
    .filter(row => row[0])
    .map(row => ({
      rowIndex:    row._rowIndex,
      id:          row[0] || '',
      nombre:      row[1] || '',
      categoria:   row[2] || '',
      precio:      parseInt(row[3] || '0'),
      descripcion: row[4] || '',
      activo:      row[5] !== 'FALSE'
    }));
}

async function getProductosByCategoria(categoria) {
  const productos = await getProductos();
  return productos.filter(p => p.categoria === categoria && p.activo);
}

// ─── DISPONIBILIDAD ──────────────────────────────────────
async function getDisponibilidad() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${HOJAS.disponibilidad}!A2:E`
  });
  const rows = res.data.values || [];
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1];
  return {
    fecha:       last[0] || '',
    viernes:     last[1] === 'TRUE',
    sabado:      last[2] === 'TRUE',
    domingo:     last[3] === 'TRUE',
    actualizado: last[4] || ''
  };
}

async function guardarDisponibilidad({ viernes = false, sabado, domingo }) {
  const sheets = await getSheetsClient();
  const fecha  = new Date().toISOString().split('T')[0];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${HOJAS.disponibilidad}!A:E`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        fecha,
        viernes ? 'TRUE' : 'FALSE',
        sabado  ? 'TRUE' : 'FALSE',
        domingo ? 'TRUE' : 'FALSE',
        new Date().toISOString()
      ]]
    }
  });
  console.log(`✅ Disponibilidad guardada: viernes=${viernes} sábado=${sabado} domingo=${domingo}`);
}

// ─── CITAS ───────────────────────────────────────────────
async function getCitas() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${HOJAS.citas}!A2:L`
  });
  const rows = res.data.values || [];
  return rows
    .map((row, index) => ({ ...row, _rowIndex: index + 2 }))
    .filter(row => row[0])
    .map(row => ({
      rowIndex:              row._rowIndex,
      id:                    row[0] || '',
      telefono:              row[1] || '',
      nombre:                row[2] || '',
      fecha:                 row[3] || '',
      hora:                  row[4] || '',
      estado:                row[5] || '',
      creado:                row[6] || '',
      event_id:              row[7] || '',
      recordatorio_enviado:  row[8] || '',
      cancelada_por_admin:   row[9] || '',
      profesional_id:        row[10] || '',
      servicio_id:           row[11] || ''
    }));
}

async function agregarCita({ telefono, nombre, fecha, hora, eventId, profesionalId = '', servicioId = '' }) {
  const sheets  = await getSheetsClient();
  const citas   = await getCitas();
  const nuevoId = String(citas.length + 1).padStart(3, '0');
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${HOJAS.citas}!A:L`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[
        nuevoId, telefono, nombre, fecha, hora,
        'confirmada', new Date().toISOString(), eventId || '',
        '', '', profesionalId, servicioId
      ]]
    }
  });
  console.log(`✅ Cita agregada: ${nombre} | ${fecha} | ${hora} | profesional: ${profesionalId}`);
  return nuevoId;
}

async function updateEstadoCita(rowIndex, estado) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${HOJAS.citas}!F${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[estado]] }
  });
}

async function marcarRecordatorioCitaEnviado(rowIndex) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${HOJAS.citas}!I${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['TRUE']] }
  });
  console.log(`✅ Recordatorio marcado enviado en fila ${rowIndex}`);
}

async function marcarCitaCanceladaAdmin(rowIndex) {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${HOJAS.citas}!J${rowIndex}`,
    valueInputOption: 'RAW',
    requestBody: { values: [['TRUE']] }
  });
  console.log(`✅ Cita marcada como cancelada por admin en fila ${rowIndex}`);
}

// ─── PENDIENTES ──────────────────────────────────────────
async function getPendientes() {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${HOJAS.pendientes}!A2:D`
  });
  const rows = res.data.values || [];
  return rows
    .map((row, index) => ({ ...row, _rowIndex: index + 2 }))
    .filter(row => row[0])
    .map(row => ({
      rowIndex: row._rowIndex,
      telefono: row[0] || '',
      nombre:   row[1] || '',
      from:     row[2] || '',
      fecha:    row[3] || ''
    }));
}

async function agregarPendienteSheet({ telefono, nombre, from }) {
  const pendientes = await getPendientes();
  const yaExiste   = pendientes.find(p => p.telefono === telefono);
  if (yaExiste) { console.log(`⏭️ Pendiente ya existe: ${nombre} (${telefono})`); return; }
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${HOJAS.pendientes}!A:D`,
    valueInputOption: 'RAW',
    requestBody: { values: [[telefono, nombre, from, new Date().toISOString()]] }
  });
  console.log(`📋 Pendiente guardado: ${nombre} (${telefono})`);
}

async function limpiarPendientes() {
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${HOJAS.pendientes}!A2:D`
  });
  console.log('🧹 Pendientes limpiados en Sheets');
}

module.exports = {
  // clientes
  getClientes,
  getClienteByPhone,
  updateCliente,
  guardarLid,
  guardarProfesionalOrigen,
  guardarProfesionalPreferido,
  actualizarUltimoCorte,
  resetearCancelaciones,
  setProximoRecordatorio8Dias,
  marcarClienteInactivo,
  borrarCliente,
  sumarCancelacion,
  sumarCitasCanceladasAdmin,
  sumarNoAsistio,
  // profesionales
  getProfesionales,
  getProfesionalById,
  getProfesionalesByTipo,
  // servicios
  getServicios,
  getServicioById,
  getServiciosByCategoria,
  // productos
  getProductos,
  getProductosByCategoria,
  // disponibilidad
  getDisponibilidad,
  guardarDisponibilidad,
  // citas
  agregarCita,
  getCitas,
  updateEstadoCita,
  marcarRecordatorioCitaEnviado,
  marcarCitaCanceladaAdmin,
  // pendientes
  getPendientes,
  agregarPendienteSheet,
  limpiarPendientes,
  // utils
  normalizarTelefono
};