/**
 * ══════════════════════════════════════════════════════════════════════
 *  AXONTECH · Base de datos en GOOGLE SHEETS  ·  Code.gs
 * ══════════════════════════════════════════════════════════════════════
 *
 *  Los datos de la app viven en TU hoja de cálculo de Google (gratis, sin
 *  límites de egress) y este script hace de API. La app habla el mismo
 *  dialecto REST de siempre — solo cambia el destinatario — así que no hace
 *  falta tocar nada de la lógica.
 *
 *  ESTRUCTURA DE LA HOJA (se crea sola con setup()):
 *    · gestores, mensajeros, productos, categorias, vales
 *        → columnas: id | data (JSON) | updated_at
 *    · meta, backups  (documentos sueltos: config, notifs, tasa…)
 *        → columnas: name | data (JSON) | updated_at
 *    · stock_ops   → registro de órdenes de stock (idempotencia)
 *    · vale_contador → contador de números de vale (nunca se repiten)
 *    · _cambios    → hora del último cambio por tabla (sondeo barato)
 *
 *  ── CÓMO INSTALARLO (3 minutos) ─────────────────────────────────────
 *   1. script.google.com → Nuevo proyecto → pega TODO este archivo.
 *   2. Guarda (Ctrl+S) y ejecuta la función `setup` una vez (le da a
 *      Google permiso sobre tu Drive y crea la hoja con sus pestañas).
 *   3. Implementar → Nueva implementación → tipo "Aplicación web":
 *        · Ejecutar como: Yo
 *        · Quién tiene acceso: Cualquier persona
 *      → Implementar → copia la URL (…/exec).
 *   4. Pega la URL en la constante GS_DB_URL de app.js (o ábrela una vez
 *      con ?gs=LA_URL). Guía completa: INSTALAR-GOOGLE-SHEETS.md
 *
 *  ── ¿CÓMO CARGO MIS DATOS? ─────────────────────────────────────────
 *   La forma normal: usa la propia app (panel admin) y ella llena la
 *   hoja. Para importar a mano, pega filas en las pestañas (id | data
 *   JSON | updated_at) y ejecuta `sembrarContadorVales` una vez para
 *   dejar el contador de vales por encima del número más alto.
 *
 *  ── NOTAS ───────────────────────────────────────────────────────────
 *   · Las escrituras van bajo LockService: dos teléfonos a la vez no se
 *     pisan (equivale al FOR UPDATE de una base SQL).
 *   · Ediciones A MANO en la hoja: las filas NUEVAS se detectan solas en
 *     el siguiente sondeo; cambiar una fila vieja puede tardar hasta el
 *     barrido periódico en llegar a los teléfonos (en la app hay editores
 *     para todo, así que lo normal será editar desde la app).
 *   · Cada celda de `data` es JSON: máximo ~45.000 caracteres por fila
 *     (límite de Google Sheets ≈ 50.000). Un vale ronda 1,5 KB.
 *   · Si pones API_TOKEN, la app debe mandar el mismo token (opcional).
 * ══════════════════════════════════════════════════════════════════════
 */

// ── CONFIGURACIÓN ─────────────────────────────────────────────────────
// Déjalo vacío y ejecuta setup(): creará la hoja y guardará su ID aquí
// mismo (en las propiedades del script). Si prefieres usar una hoja que
// ya tienes, pega aquí su ID (el de entre /d/ y /edit en su URL).
var SPREADSHEET_ID = '';

// Opcional: si lo rellenas, la API solo acepta peticiones que manden
// t = ese token. La app lo manda si GS_DB_TOKEN (app.js) coincide.
var API_TOKEN = '';

// ── ESTRUCTURA (no tocar) ─────────────────────────────────────────────
var TABLAS_FILA  = ['gestores', 'mensajeros', 'productos', 'categorias', 'vales'];
var TABLAS_CLAVE = ['meta', 'backups'];
var HOJA_CAMBIOS = '_cambios';
var CAMPOS_ADMIN_VALE = [
  'status', 'mensajeroId', 'assignedTs', 'confirmedTs', 'adminNotes',
  'seenByAdmin', 'seenTs', 'commissionStatus', 'commissionPaid',
  'stockDecremented', 'hiddenFromHistory', 'hiddenTs', 'deliveredTs',
  'cancelledTs', 'revertedTs'
];

// ══════════════════════════════════════════════════════════════════════
//  PUNTOS DE ENTRADA
// ══════════════════════════════════════════════════════════════════════

// GET desde el navegador = prueba de que la implementación vive.
function doGet() {
  var info = {
    ok: true,
    servicio: 'AXONTECH · Base de datos en Google Sheets',
    tablas: TABLAS_FILA.concat(TABLAS_CLAVE),
    hoja: '(sin comprobar)'
  };
  try { info.hoja = _ss().getName(); } catch (err) {
    info.ok = false;
    info.error = String(err && err.message || err);
  }
  return _salida(info);
}

// TODO el tráfico de la app llega aquí dentro de un sobre JSON:
//   { m: 'GET'|'POST'|'PATCH'|'DELETE', p: '/vales', q: 'select=…', b: cuerpo, t: token }
// Se manda con Content-Type text/plain a propósito: evita la preflight
// CORS y Apps Script lo entrega igual en e.postData.contents.
function doPost(e) {
  var req = null;
  try {
    if (e && e.postData && e.postData.contents) req = JSON.parse(e.postData.contents);
  } catch (err) { req = null; }
  if (!req || typeof req !== 'object') {
    return _salida({ __error: 'Cuerpo no válido: se espera JSON {m, p, q, b}' });
  }
  try {
    return _salida(handle(req));
  } catch (err) {
    return _salida({ __error: String(err && err.message || err) });
  }
}

// Router central. Devuelve SIEMPRE una forma que el cliente entiende;
// los errores van como {__error: '…'} y el shim de app.js los convierte
// en un 500 de verdad para que la cola de reintentos los trate igual que
// cualquier fallo de red.
function handle(req) {
  var m = String(req.m || 'GET').toUpperCase();
  var p = String(req.p || '/');
  var q = String(req.q || '');
  var body = (req.b === undefined) ? null : req.b;

  if (API_TOKEN && req.t !== API_TOKEN) {
    return { __error: 'Token inválido' };
  }

  // Cinturón de seguridad: si el cuerpo viniera como texto JSON, parsearlo.
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (err) { body = null; }
  }

  if (p.indexOf('/rpc/') === 0) {
    var fn = p.slice(5);
    return _rpc(fn, body);
  }

  var t = _decodificar(p.replace(/^\/+/, ''));
  if (!_esTablaValida(t)) {
    return { __error: 'Tabla desconocida: ' + t };
  }
  if (m === 'GET')    return _hacerGet(t, q);
  if (m === 'POST')   return _hacerUpsert(t, Array.isArray(body) ? body : [body]);
  if (m === 'PATCH')  return _hacerPatch(t, q, body);
  if (m === 'DELETE') return _hacerDelete(t, q);
  return { __error: 'Método no soportado: ' + m };
}

// ══════════════════════════════════════════════════════════════════════
//  LECTURAS  (GET /tabla?select=…&id=eq.1&updated_at=gt.2026-…&limit=1)
// ══════════════════════════════════════════════════════════════════════

function _hacerGet(t, q) {
  var Q = _parsearQuery(q);
  var filas = _leerFilas(t);
  filas = _aplicarFiltros(filas, Q.filtros);
  if (Q.orden) filas = _ordenar(filas, Q.orden);
  if (Q.limite !== null && Q.limite !== undefined) filas = filas.slice(0, Q.limite);
  var sel = Q.select || _selectPorDefecto(t);
  var fuera = [];
  for (var i = 0; i < filas.length; i++) fuera.push(_forma(filas[i], sel));
  return fuera;
}

function _parsearQuery(q) {
  var out = { select: '', filtros: [], orden: null, limite: null };
  if (!q) return out;
  var partes = q.split('&');
  for (var i = 0; i < partes.length; i++) {
    var kv = partes[i];
    var eq = kv.indexOf('=');
    if (eq === -1) continue;
    var k = _decodificar(kv.slice(0, eq));
    var v = _decodificar(kv.slice(eq + 1));
    if (k === 'select') { out.select = v; continue; }
    if (k === 'order') {
      var mo = /^([A-Za-z_]+)\.(asc|desc)/.exec(v);
      if (mo) out.orden = { col: mo[1], dir: mo[2] };
      continue;
    }
    if (k === 'limit') {
      var n = parseInt(v, 10);
      if (!isNaN(n) && n >= 0) out.limite = n;
      continue;
    }
    if (k === 'offset') continue;   // aceptado y sin efecto (no se usa)
    // ── filtros: col=op.valor ──
    var op = null, val = null;
    if (v === 'not.is.null') { op = 'not.is.null'; }
    else if (v === 'is.null') { op = 'is.null'; }
    else {
      var punto = v.indexOf('.');
      var cand = (punto === -1) ? '' : v.slice(0, punto);
      if (cand === 'eq' || cand === 'gt' || cand === 'gte' || cand === 'lt' || cand === 'lte') {
        op = cand; val = v.slice(punto + 1);
      } else if (cand === 'in') {
        op = 'in'; val = v.slice(punto + 1);
      }
    }
    if (op === 'in') {
      var set = {};
      var inner = /^\((.*)\)$/.exec(val || '');
      if (inner && inner[1]) {
        var items = inner[1].split(',');
        for (var j = 0; j < items.length; j++) set[_decodificar(items[j])] = true;
      }
      out.filtros.push({ col: k, op: 'in', set: set });
    } else if (op) {
      out.filtros.push({ col: k, op: op, val: val });
    }
  }
  return out;
}

function _aplicarFiltros(filas, filtros) {
  if (!filtros || !filtros.length) return filas;
  var fuera = [];
  for (var i = 0; i < filas.length; i++) {
    var pasa = true;
    for (var j = 0; j < filtros.length; j++) {
      if (!_cumple(filas[i], filtros[j])) { pasa = false; break; }
    }
    if (pasa) fuera.push(filas[i]);
  }
  return fuera;
}

function _cumple(fila, f) {
  var v = _valorDeCol(fila, f.col);
  if (v === undefined) return false;          // columna que no conocemos
  switch (f.op) {
    case 'eq':   return _igual(v, f.val);
    case 'gt':   return _comparar(v, f.val) > 0;
    case 'gte':  return _comparar(v, f.val) >= 0;
    case 'lt':   return _comparar(v, f.val) < 0;
    case 'lte':  return _comparar(v, f.val) <= 0;
    case 'in':   return v !== null && v !== '' && !!f.set[String(v)];
    case 'not.is.null': return v !== null && v !== '';
    case 'is.null':     return v === null || v === '';
  }
  return false;
}

// 'id' y 'name' son la clave (según la tabla); 'updated_at' la hora;
// 'data->>campo' mira dentro del JSON (así filtra la app por gestorId).
function _valorDeCol(fila, col) {
  if (col === 'id' || col === 'name') return fila.pk;
  if (col === 'updated_at') return fila.ts;
  if (col.indexOf('data->>') === 0) {
    var campo = col.slice(7);
    var d = fila.data;
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      var v = d[campo];
      if (v === undefined || v === null) return null;
      return String(v);
    }
    return null;
  }
  return undefined;
}

function _igual(a, b) {
  if (a === null || a === undefined || a === '') return false;
  if (a === b) return true;
  var na = Number(a), nb = Number(b);
  if (!isNaN(na) && !isNaN(nb) && String(na) === String(nb)) return true;
  return String(a) === String(b);
}

// Compara números como números y horas como horas; si no, como texto.
function _comparar(a, b) {
  if (a === null || a === undefined || a === '') return -1;
  if (b === null || b === undefined || b === '') return 1;
  var na = Number(a), nb = Number(b);
  if (!isNaN(na) && !isNaN(nb)) return (na < nb) ? -1 : (na > nb ? 1 : 0);
  var ta = Date.parse(String(a)), tb = Date.parse(String(b));
  if (!isNaN(ta) && !isNaN(tb)) return (ta < tb) ? -1 : (ta > tb ? 1 : 0);
  var sa = String(a), sb = String(b);
  return (sa < sb) ? -1 : (sa > sb ? 1 : 0);
}

function _ordenar(filas, orden) {
  var col = orden.col, dir = (orden.dir === 'desc') ? -1 : 1;
  var copia = filas.slice();
  copia.sort(function (a, b) {
    var va, vb;
    if (col === 'id' || col === 'name') { va = a.pk; vb = b.pk; }
    else if (col === 'updated_at') { va = a.ts; vb = b.ts; }
    else { va = _valorDeCol(a, col); vb = _valorDeCol(b, col); }
    return dir * _comparar(va, vb);
  });
  return copia;
}

// Da a cada fila la forma que pidió `select` (data / id / name / updated_at).
function _forma(fila, select) {
  var partes = String(select || 'data').split(',');
  var o = {};
  for (var i = 0; i < partes.length; i++) {
    var p = partes[i].replace(/^\s+|\s+$/g, '');
    if (p === 'id' || p === 'name') { o[p] = fila.pk; }
    else if (p === 'data') { o.data = (fila.data === undefined) ? null : fila.data; }
    else if (p === 'updated_at') { o.updated_at = fila.ts || ''; }
  }
  return o;
}

function _aForma(filas, select) {
  var fuera = [];
  for (var i = 0; i < filas.length; i++) fuera.push(_forma(filas[i], select));
  return fuera;
}

// ══════════════════════════════════════════════════════════════════════
//  ESCRITURAS  (POST = upsert por clave · PATCH = reemplazar data ·
//               DELETE = borrar las que cumplan el filtro)
// ══════════════════════════════════════════════════════════════════════

// POST /tabla  cuerpo: [{id, data}, …]  o  [{name, data}, …]
// Equivale al POST de PostgREST con Prefer: resolution=merge-duplicates,
// que es lo único que manda la app.
function _hacerUpsert(t, items) {
  if (!items || !items.length) return [];
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var sh = _hoja(t, _cabecera(t));
    var pk = _pkDe(t);
    var existentes = _leerFilas(t);
    var idx = {};
    for (var i = 0; i < existentes.length; i++) idx[String(existentes[i].pk)] = existentes[i];

    var ahora = _ahoraIso();
    var updates = [];   // {fila, dataStr, ts}
    var appends = [];   // [pk, dataStr, ts]
    var pendientes = {}; // clave → posición en appends (duplicados del mismo lote)
    var tocadas = [];   // para _cambios y para la respuesta

    for (var j = 0; j < items.length; j++) {
      var it = items[j];
      if (!it || typeof it !== 'object') continue;
      var pkVal = it[pk];
      if (pkVal === undefined || pkVal === null || pkVal === '') continue;
      var clave = String(pkVal);
      var pkNorm = _normalizarPk(pkVal, t);
      var data = (it.data === undefined || it.data === null) ? {} : it.data;
      var dataStr = JSON.stringify(data);
      if (dataStr.length > 48000) {
        throw new Error('Fila demasiado grande para Sheets (' + dataStr.length + ' caracteres): ' + clave);
      }
      var existente = idx[clave];
      if (existente && existente.fila !== -1) {
        updates.push({ fila: existente.fila, dataStr: dataStr, ts: ahora });
        existente.data = data; existente.ts = ahora;
        tocadas.push(existente);
      } else if (existente) {
        // Ya apareció antes en ESTE lote: el último valor gana.
        appends[pendientes[clave]] = [pkNorm, dataStr, ahora];
        existente.data = data; existente.ts = ahora;
      } else {
        appends.push([pkNorm, dataStr, ahora]);
        pendientes[clave] = appends.length - 1;
        var nueva = { fila: -1, pk: pkNorm, data: data, ts: ahora };
        idx[clave] = nueva;
        tocadas.push(nueva);
      }
    }

    _escribirUpdates(sh, updates);
    if (appends.length) {
      var start = sh.getLastRow() + 1;
      sh.getRange(start, 1, appends.length, 3).setValues(appends);
    }
    _bumpCambios(t, tocadas);
    return _aForma(tocadas, _selectPorDefecto(t));
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

// PATCH /tabla?filtro   cuerpo: {data: {…}}  → reemplaza la columna data.
// (La app lo usa en _deltaStockPorLectura y ajustes puntuales.)
function _hacerPatch(t, q, body) {
  var Q = _parsearQuery(q);
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var filas = _aplicarFiltros(_leerFilas(t), Q.filtros);
    if (!filas.length) return [];
    var data = (body && typeof body === 'object' && body.data !== undefined) ? body.data : body;
    if (data === undefined || data === null) data = {};
    var dataStr = JSON.stringify(data);
    var ahora = _ahoraIso();
    var sh = _hoja(t, _cabecera(t));
    for (var i = 0; i < filas.length; i++) {
      sh.getRange(filas[i].fila, 2).setValue(dataStr);
      sh.getRange(filas[i].fila, 3).setValue(ahora);
      filas[i].data = data; filas[i].ts = ahora;
    }
    _bumpCambios(t, filas);
    return _aForma(filas, _selectPorDefecto(t));
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

// DELETE /tabla?filtro → borra las filas que cumplan y las devuelve
// (return=representation: _sbRestDeleteValeCore mira si venía algo).
function _hacerDelete(t, q) {
  var Q = _parsearQuery(q);
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var filas = _aplicarFiltros(_leerFilas(t), Q.filtros);
    if (!filas.length) return [];
    filas.sort(function (a, b) { return b.fila - a.fila; });   // de abajo hacia arriba
    var sh = _hoja(t, _cabecera(t));
    var i = 0;
    while (i < filas.length) {
      var j = i;
      while (j + 1 < filas.length && filas[j + 1].fila === filas[j].fila - 1) j++;
      sh.deleteRows(filas[j].fila, j - i + 1);
      i = j + 1;
    }
    _bumpCambios(t, filas);
    return _aForma(filas, _selectPorDefecto(t));
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

// Escribe updates agrupados en tramos de filas contiguas (1 llamada por
// tramo en vez de 2 setValue por fila: la diferencia se nota con lotes).
function _escribirUpdates(sh, updates) {
  if (!updates.length) return;
  updates.sort(function (a, b) { return a.fila - b.fila; });
  var i = 0;
  while (i < updates.length) {
    var j = i;
    while (j + 1 < updates.length && updates[j + 1].fila === updates[j].fila + 1) j++;
    var bloque = [];
    for (var k = i; k <= j; k++) bloque.push([updates[k].dataStr, updates[k].ts]);
    sh.getRange(updates[i].fila, 2, bloque.length, 2).setValues(bloque);
    i = j + 1;
  }
}

// ══════════════════════════════════════════════════════════════════════
//  RPC — las cinco funciones que la app conoce (heredadas de la base
//  anterior, ahora aquí)
// ══════════════════════════════════════════════════════════════════════

function _rpc(fn, body) {
  var b = (body && typeof body === 'object') ? body : {};
  if (fn === 'ultimos_cambios')          return _rpcUltimosCambios(b.p_gestor);
  if (fn === 'upsert_vale_from_gestor')  return _rpcUpsertValeGestor(b.p_id, b.p_data);
  if (fn === 'aplicar_delta_stock')      return _rpcDeltaStock(b.p_id, b.p_delta, b.p_op);
  if (fn === 'meta_fusionar')            return _rpcMetaFusionar(b.p_name, b.p_patch);
  if (fn === 'reservar_vale_num')        return _rpcReservarValeNum(b.p_minimo);
  // v209: respaldos de seguridad (copia de la hoja a un archivo aparte)
  if (fn === 'backup_info')              return _backupEstado();
  if (fn === 'backup_now')               return _backupAhora();
  if (fn === 'backup_trigger')           return (b.p_on === true || b.p_on === 'true') ? _backupTriggerActivar() : _backupTriggerDesactivar();
  return { __error: 'RPC desconocido: ' + fn };
}

// v137: UNA pregunta por vuelta. Responde la hora del último cambio de
// cada tabla y de cada documento de meta, leyendo SOLO la hoja _cambios
// (pequeña). Red de seguridad: si la última fila de una tabla es más
// nueva que lo apuntado (filas pegadas a mano en la hoja), manda esa.
function _rpcUltimosCambios(pGestor) {
  var cambios = _leerCambios();
  for (var i = 0; i < TABLAS_FILA.length; i++) {
    var t = TABLAS_FILA[i];
    var sh = _hoja(t, _cabecera(t));
    var lr = sh.getLastRow();
    if (lr > 1) {
      var ts = _celdaATs(sh.getRange(lr, 3).getValue());
      if (ts && (!cambios[t] || ts > cambios[t])) cambios[t] = ts;
    }
  }
  var meta = {};
  for (var k in cambios) {
    if (k.indexOf('meta/') === 0) meta[k.slice(5)] = cambios[k];
  }
  var hayGestor = (pGestor !== null && pGestor !== undefined && pGestor !== '');
  return {
    vales: cambios['vales'] || null,
    vales_gestor: hayGestor
      ? (cambios['vales_gestor/' + String(pGestor)] || cambios['vales'] || null)
      : null,
    gestores: cambios['gestores'] || null,
    mensajeros: cambios['mensajeros'] || null,
    productos: cambios['productos'] || null,
    categorias: cambios['categorias'] || null,
    meta: meta
  };
}

// v54: el gestor manda su versión del vale y AQUÍ se junta con lo que
// haya, preservando los campos del admin (status, mensajeroId…). Un
// teléfono con la copia vieja ya no puede borrar una confirmación.
function _rpcUpsertValeGestor(pId, pData) {
  if (Number(pId) === 0) return { ok: true };   // sonda de disponibilidad: no escribir nada
  var idNum = Number(pId);
  if (isNaN(idNum)) return { __error: 'upsert_vale_from_gestor: p_id inválido' };
  if (!pData || typeof pData !== 'object' || Array.isArray(pData)) pData = {};

  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var sh = _hoja('vales', _cabecera('vales'));
    var filas = _leerFilas('vales');
    var destino = null;
    for (var i = 0; i < filas.length; i++) {
      if (String(filas[i].pk) === String(idNum)) { destino = filas[i]; break; }
    }
    var ahora = _ahoraIso();
    if (!destino) {
      var data = {};
      for (var k in pData) {
        if (Object.prototype.hasOwnProperty.call(pData, k) && pData[k] !== undefined) data[k] = pData[k];
      }
      if (!Object.prototype.hasOwnProperty.call(data, 'status')) data['status'] = 'pending';
      sh.getRange(sh.getLastRow() + 1, 1, 1, 3).setValues([[idNum, JSON.stringify(data), ahora]]);
      _bumpCambios('vales', [{ pk: idNum, data: data, ts: ahora }]);
      return { ok: true };
    }
    var existente = (destino.data && typeof destino.data === 'object' && !Array.isArray(destino.data)) ? destino.data : {};
    var merged = {};
    for (var k2 in existente) {
      if (Object.prototype.hasOwnProperty.call(existente, k2)) merged[k2] = existente[k2];
    }
    for (var k3 in pData) {
      if (Object.prototype.hasOwnProperty.call(pData, k3)) merged[k3] = pData[k3];
    }
    for (var c = 0; c < CAMPOS_ADMIN_VALE.length; c++) {
      var campo = CAMPOS_ADMIN_VALE[c];
      if (Object.prototype.hasOwnProperty.call(existente, campo)) merged[campo] = existente[campo];
      else delete merged[campo];
    }
    sh.getRange(destino.fila, 2).setValue(JSON.stringify(merged));
    sh.getRange(destino.fila, 3).setValue(ahora);
    _bumpCambios('vales', [{ pk: destino.pk, data: merged, ts: ahora }]);
    return { ok: true };
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

// v96: el teléfono dice "quita 2" (no "queda en 8"). Con p_op como
// identificador de la orden, un reintento tras una conexión cortada no
// descuenta dos veces. Devuelve el stock que queda (-1 si no hay producto).
function _rpcDeltaStock(pId, pDelta, pOp) {
  var idNum = Number(pId);
  var delta = Math.round(Number(pDelta) || 0);
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    if (pOp !== null && pOp !== undefined && pOp !== '') {
      var ya = _buscarStockOp(String(pOp));
      if (ya !== null) {
        var prodYa = _leerProducto(idNum);
        return (prodYa === null) ? -1 : prodYa.stock;
      }
    }
    var prod = _leerProducto(idNum);
    if (prod === null) return -1;
    var nuevo = Math.max(0, prod.stock + delta);
    var ahora = _ahoraIso();
    var data = (prod.data && typeof prod.data === 'object') ? prod.data : {};
    data['stock'] = nuevo;
    var sh = _hoja('productos', _cabecera('productos'));
    sh.getRange(prod.fila, 2).setValue(JSON.stringify(data));
    sh.getRange(prod.fila, 3).setValue(ahora);
    if (pOp !== null && pOp !== undefined && pOp !== '') {
      _apuntarStockOp(String(pOp), idNum, delta, ahora);
    }
    _bumpCambios('productos', [{ pk: prod.pk, data: data, ts: ahora }]);
    return nuevo;
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

// v140: la base junta los cambios del documento (config, mermas…). Las
// claves con null se QUITAN; nextValeNum de la config solo sube.
function _rpcMetaFusionar(pName, pPatch) {
  if (!pName) return { __error: 'meta_fusionar: falta el nombre' };
  if (!pPatch || typeof pPatch !== 'object' || Array.isArray(pPatch)) {
    return { __error: 'meta_fusionar: el cambio tiene que ser un objeto' };
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var filas = _leerFilas('meta');
    var destino = null;
    for (var i = 0; i < filas.length; i++) {
      if (String(filas[i].pk) === String(pName)) { destino = filas[i]; break; }
    }
    var existente = (destino && destino.data && typeof destino.data === 'object' && !Array.isArray(destino.data)) ? destino.data : {};
    var poner = {}, quitar = [];
    for (var k in pPatch) {
      if (Object.prototype.hasOwnProperty.call(pPatch, k)) {
        if (pPatch[k] === null) quitar.push(k);
        else poner[k] = pPatch[k];
      }
    }
    if (Object.prototype.hasOwnProperty.call(poner, 'nextValeNum')) {
      var actual = parseInt(existente && existente.nextValeNum, 10) || 0;
      poner['nextValeNum'] = Math.max(parseInt(poner['nextValeNum'], 10) || 0, actual);
    }
    var merged = {};
    for (var k2 in existente) {
      if (Object.prototype.hasOwnProperty.call(existente, k2)) merged[k2] = existente[k2];
    }
    for (var q = 0; q < quitar.length; q++) delete merged[quitar[q]];
    for (var k3 in poner) {
      if (Object.prototype.hasOwnProperty.call(poner, k3)) merged[k3] = poner[k3];
    }
    var ahora = _ahoraIso();
    var sh = _hoja('meta', _cabecera('meta'));
    if (destino) {
      sh.getRange(destino.fila, 2).setValue(JSON.stringify(merged));
      sh.getRange(destino.fila, 3).setValue(ahora);
    } else {
      sh.getRange(sh.getLastRow() + 1, 1, 1, 3).setValues([[String(pName), JSON.stringify(merged), ahora]]);
    }
    _bumpCambios('meta', [{ pk: String(pName), data: merged, ts: ahora }]);
    return { ok: true };
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

// v134: números de vale que no se repiten. El contador vive en su
// pestaña y se atiende bajo candado: dos llamadas a la vez reciben
// números distintos. Arranca por encima del p_minimo que manda el teléfono.
function _rpcReservarValeNum(pMinimo) {
  var minimo = Math.trunc(Number(pMinimo) || 0);
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var sh = _hoja('vale_contador', _cabecera('vale_contador'));
    var last = sh.getLastRow();
    var viejo = null, fila = -1;
    if (last > 1) {
      var vals = sh.getRange(2, 1, last - 1, 2).getValues();
      for (var i = 0; i < vals.length; i++) {
        if (String(vals[i][0]) === '1') {
          viejo = Number(vals[i][1]) || 0;
          fila = i + 2;
          break;
        }
      }
    }
    var devuelto;
    if (fila === -1) {
      devuelto = Math.max(minimo, 1);
      sh.getRange(2, 1, 1, 2).setValues([[1, devuelto + 1]]);
    } else {
      devuelto = Math.max(viejo, minimo);
      sh.getRange(fila, 2).setValue(devuelto + 1);
    }
    return devuelto;
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

// ══════════════════════════════════════════════════════════════════════
//  HOJA _cambios — el sondeo barato
// ══════════════════════════════════════════════════════════════════════

function _leerCambios() {
  var cambios = {};
  var sh = _hoja(HOJA_CAMBIOS, ['clave', 'ultimo_cambio']);
  var last = sh.getLastRow();
  if (last > 1) {
    var vals = sh.getRange(2, 1, last - 1, 2).getValues();
    for (var i = 0; i < vals.length; i++) {
      var k = String(vals[i][0]);
      var ts = _celdaATs(vals[i][1]);
      if (k && ts) cambios[k] = ts;
    }
  }
  return cambios;
}

// Apunta la hora del último cambio para las claves dadas.
// claves: { 'vales': true, 'vales_gestor/123': true, 'meta/config': true … }
function _tocarCambios(claves, ts) {
  var hay = false;
  for (var k in claves) { hay = true; break; }
  if (!hay) return;
  var sh = _hoja(HOJA_CAMBIOS, ['clave', 'ultimo_cambio']);
  var last = sh.getLastRow();
  var existentes = {};
  if (last > 1) {
    var vals = sh.getRange(2, 1, last - 1, 2).getValues();
    for (var i = 0; i < vals.length; i++) {
      var kk = String(vals[i][0]);
      if (kk && claves[kk]) {
        sh.getRange(i + 2, 2).setValue(ts);
        existentes[kk] = true;
      }
    }
  }
  var nuevos = [];
  for (var k2 in claves) {
    if (Object.prototype.hasOwnProperty.call(claves, k2) && !existentes[k2]) nuevos.push([k2, ts]);
  }
  if (nuevos.length) {
    sh.getRange(sh.getLastRow() + 1, 1, nuevos.length, 2).setValues(nuevos);
  }
}

function _bumpCambios(t, filasTocadas) {
  var ahora = _ahoraIso();
  var claves = {};
  claves[t] = true;
  for (var i = 0; i < filasTocadas.length; i++) {
    var f = filasTocadas[i];
    if (t === 'vales' && f.data && typeof f.data === 'object' &&
        f.data.gestorId !== undefined && f.data.gestorId !== null) {
      claves['vales_gestor/' + String(f.data.gestorId)] = true;
    }
    if (t === 'meta') claves['meta/' + String(f.pk)] = true;
  }
  _tocarCambios(claves, ahora);
}

// ══════════════════════════════════════════════════════════════════════
//  AYUDANTES DE HOJA
// ══════════════════════════════════════════════════════════════════════

var __ssCache = null;
var __hojasCache = {};

function _idHoja() {
  var id = (SPREADSHEET_ID || '').trim();
  try {
    var props = PropertiesService.getScriptProperties();
    id = (props.getProperty('SPREADSHEET_ID') || id).trim();
  } catch (e) {}
  if (!id) {
    throw new Error('Falta el ID de la hoja: ejecuta setup() una vez desde el editor.');
  }
  return id;
}

function _ss() {
  if (!__ssCache) __ssCache = SpreadsheetApp.openById(_idHoja());
  return __ssCache;
}

function _cabecera(t) {
  if (t === 'meta' || t === 'backups') return ['name', 'data', 'updated_at'];
  if (t === 'stock_ops') return ['op_id', 'producto_id', 'delta', 'aplicado_en'];
  if (t === 'vale_contador') return ['id', 'siguiente'];
  return ['id', 'data', 'updated_at'];
}

function _pkDe(t) { return (t === 'meta' || t === 'backups') ? 'name' : 'id'; }

function _selectPorDefecto(t) { return (t === 'meta' || t === 'backups') ? 'name,data,updated_at' : 'id,data,updated_at'; }

function _esTablaValida(t) {
  return TABLAS_FILA.indexOf(t) !== -1 || TABLAS_CLAVE.indexOf(t) !== -1;
}

function _hoja(nombre, cabecera) {
  if (__hojasCache[nombre]) return __hojasCache[nombre];
  var ss = _ss();
  var sh = ss.getSheetByName(nombre);
  if (!sh) {
    sh = ss.insertSheet(nombre);
    if (cabecera && cabecera.length) {
      sh.getRange(1, 1, 1, cabecera.length).setValues([cabecera]);
      try { sh.setFrozenRows(1); } catch (e) {}
    }
  }
  __hojasCache[nombre] = sh;
  return sh;
}

// Lee TODAS las filas de datos de una tabla (sin la cabecera).
// Devuelve [{fila: nº de fila en la hoja, pk, data (objeto), ts}]
function _leerFilas(t) {
  var cab = _cabecera(t);
  var sh = _hoja(t, cab);
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, cab.length).getValues();
  var filas = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    var pkCelda = r[0];
    if (pkCelda === '' || pkCelda === null || pkCelda === undefined) continue;
    var data = null;
    var raw = r[1];
    if (raw !== '' && raw !== null && raw !== undefined) {
      if (typeof raw === 'string') {
        try { data = JSON.parse(raw); } catch (e) { data = null; }   // JSON roto a mano: se ignora la fila
      } else {
        data = raw;   // el usuario pegó el objeto a mano con el editor
      }
    }
    filas.push({
      fila: i + 2,
      pk: _normalizarPk(pkCelda, t),
      data: data,
      ts: _celdaATs(r[2])
    });
  }
  return filas;
}

function _normalizarPk(v, t) {
  if (typeof v === 'number') return v;
  var s = String(v);
  if ((t === 'meta' || t === 'backups') && !/^-?\d+(\.\d+)?$/.test(s)) return s;
  if (/^-?\d+$/.test(s)) {
    var n = Number(s);
    if (isFinite(n)) return n;
  }
  return s;
}

function _celdaATs(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return v.toISOString();
  return String(v);
}

function _ahoraIso() { return new Date().toISOString(); }

function _salida(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj === undefined ? null : obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function _decodificar(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

// ══════════════════════════════════════════════════════════════════════
//  stock_ops (idempotencia de los deltas)
// ══════════════════════════════════════════════════════════════════════

function _buscarStockOp(opId) {
  var sh = _hoja('stock_ops', _cabecera('stock_ops'));
  var last = sh.getLastRow();
  if (last < 2) return null;
  var vals = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) === opId) return true;
  }
  return null;
}

function _apuntarStockOp(opId, productoId, delta, ahora) {
  var sh = _hoja('stock_ops', _cabecera('stock_ops'));
  sh.getRange(sh.getLastRow() + 1, 1, 1, 4).setValues([[opId, productoId, delta, ahora]]);
}

function _leerProducto(idNum) {
  var filas = _leerFilas('productos');
  for (var i = 0; i < filas.length; i++) {
    if (String(filas[i].pk) === String(idNum)) {
      var data = (filas[i].data && typeof filas[i].data === 'object') ? filas[i].data : {};
      return { fila: filas[i].fila, pk: filas[i].pk, data: data, stock: parseInt(data.stock, 10) || 0 };
    }
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════
//  FUNCIONES PARA EJECUTAR DESDE EL EDITOR (una vez)
// ══════════════════════════════════════════════════════════════════════

/**
 * Ejecuta ESTA función una vez desde el editor (Run ▶):
 *  · Si SPREADSHEET_ID está vacío, crea la hoja "AXONTECH DB" en tu Drive
 *    y guarda su ID en las propiedades del script.
 *  · Crea todas las pestañas con sus cabeceras.
 * Después: Implementar → Aplicación web (Ejecutar como: Yo · Acceso:
 * Cualquier persona) y copia la URL /exec.
 */
function setup() {
  __ssCache = null; __hojasCache = {};   // por si algo se leyó antes en esta ejecución
  var props = PropertiesService.getScriptProperties();
  var id = (SPREADSHEET_ID || '').trim() || (props.getProperty('SPREADSHEET_ID') || '').trim();
  if (!id) {
    var ssNueva = SpreadsheetApp.create('AXONTECH DB');
    id = ssNueva.getId();
    props.setProperty('SPREADSHEET_ID', id);
  }
  var ss = SpreadsheetApp.openById(id);
  var nombres = TABLAS_FILA.concat(TABLAS_CLAVE).concat([HOJA_CAMBIOS, 'stock_ops', 'vale_contador']);
  for (var i = 0; i < nombres.length; i++) _hoja(nombres[i], _cabecera(nombres[i]));
  var porDefecto = ss.getSheetByName('Sheet1');
  if (porDefecto && porDefecto.getLastRow() === 0) {
    try { ss.deleteSheet(porDefecto); } catch (e) {}
  }
  var msg = 'Base lista. Hoja: https://docs.google.com/spreadsheets/d/' + id + '/edit';
  Logger.log(msg);
  return msg;
}

/**
 * Siembra el contador de vales por encima del número más alto que haya
 * en la pestaña `vales`. Útil después de importar datos a mano (pegando
 * filas en la hoja). No daña nada si se ejecuta más de una vez.
 */
function sembrarContadorVales() {
  var filas = _leerFilas('vales');
  var maxNum = 0;
  for (var i = 0; i < filas.length; i++) {
    var d = filas[i].data;
    if (d && typeof d === 'object' && d.valeNum !== undefined) {
      var n = parseInt(d.valeNum, 10);
      if (!isNaN(n) && n > maxNum) maxNum = n;
    }
  }
  var sh = _hoja('vale_contador', _cabecera('vale_contador'));
  var last = sh.getLastRow();
  var actual = 0, fila = -1;
  if (last > 1) {
    var vals = sh.getRange(2, 1, last - 1, 2).getValues();
    for (var j = 0; j < vals.length; j++) {
      if (String(vals[j][0]) === '1') { actual = Number(vals[j][1]) || 0; fila = j + 2; break; }
    }
  }
  var siguiente = Math.max(maxNum + 1, actual);
  if (fila === -1) sh.getRange(2, 1, 1, 2).setValues([[1, siguiente]]);
  else sh.getRange(fila, 2).setValue(siguiente);
  Logger.log('Contador de vales sembrado en ' + siguiente);
}


// ══════════════════════════════════════════════════════════════════════
//  v209 — RESPALDOS DE SEGURIDAD
//  Copia TODAS las pestañas (gestores, productos, vales, meta, contador…)
//  a un spreadsheet aparte en tu Drive: "AXONTECH respaldo AAAA-MM-DD HH:mm".
//  Se conserva los últimos BACKUP_CONSERVAR respaldos; los viejos se borran.
//
//  · Respaldo manual:  botón "Respaldar ahora" en Admin → Config → ☁️
//    (o ejecuta `backupAhora` aquí en el editor).
//  · Respaldo semanal: botón "Activar semanal" en la app — deja un trigger
//    instalado en TU cuenta de Google que corre cada lunes a las 6:00.
//    También puedes ejecutar `instalarBackupSemanal` una vez aquí.
//  · Recuperar: abre el respaldo en Drive y copia las pestañas a la hoja
//    viva (o cambia SPREADSHEET_ID). Es una copia idéntica, misma estructura.
// ══════════════════════════════════════════════════════════════════════

var BACKUP_PREFIJO   = 'AXONTECH respaldo';
var BACKUP_CONSERVAR = 8;          // cuántos respaldos se guardan
var BACKUP_PROPIEDAD = 'ultimo_backup';

// Lista de pestañas que se copian (datos + soporte, _cambios incluida)
function _backupTablas() {
  return TABLAS_FILA.concat(TABLAS_CLAVE).concat(['stock_ops', 'vale_contador', HOJA_CAMBIOS]);
}

// Hace el respaldo y devuelve el resumen que la app muestra.
function _backupAhora() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var origen = _ss();
    var nombres = _backupTablas();
    var fecha = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    var nombre = BACKUP_PREFIJO + ' ' + fecha;
    var destino = SpreadsheetApp.create(nombre);
    var hoja0 = destino.getSheets()[0];
    hoja0.setName('_info');

    var resumen = [];
    for (var i = 0; i < nombres.length; i++) {
      var t = nombres[i];
      var sh = null;
      try { sh = origen.getSheetByName(t); } catch (err) { sh = null; }
      if (!sh) continue;                       // pestaña que aún no existe: nada que copiar
      var ultima = sh.getLastRow();
      var datos = (ultima > 0) ? sh.getRange(1, 1, ultima, Math.max(1, sh.getLastColumn())).getValues() : [];
      var copia = destino.insertSheet(t);
      if (datos.length) copia.getRange(1, 1, datos.length, datos[0].length).setValues(datos);
      resumen.push(t + ': ' + Math.max(0, ultima - 1) + ' fila(s)');
    }

    // Carátula del respaldo: qué es, cuándo y qué traía
    hoja0.getRange(1, 1, 4, 1).setValues([
      ['Respaldo de ' + origen.getName()],
      ['Fecha: ' + new Date().toISOString()],
      ['Tablas: ' + resumen.length],
      ['(para restaurar: copia estas pestañas a la hoja viva, o usa su ID en SPREADSHEET_ID)']
    ]);

    // Rotación: borrar los respaldos viejos que pasen de BACKUP_CONSERVAR
    var viejos = [];
    var it = DriveApp.searchFiles('name contains "' + BACKUP_PREFIJO + '" and mimeType = "' + MimeType.GOOGLE_SHEETS + '"');
    while (it.hasNext()) viejos.push(it.next());
    viejos.sort(function (a, b) { return b.getDateCreated().getTime() - a.getDateCreated().getTime(); });
    var borrados = 0;
    for (var k = BACKUP_CONSERVAR; k < viejos.length; k++) {
      try { viejos[k].setTrashed(true); borrados++; } catch (err) {}
    }

    PropertiesService.getScriptProperties().setProperty(BACKUP_PROPIEDAD, new Date().toISOString());
    return { ok: true, nombre: nombre, tablas: resumen, archivos: (viejos.length - borrados), ultimo: new Date().toISOString(), trigger: _backupHayTrigger() };
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

// Nombre público para ejecutar a mano desde el editor / un trigger semanal
function backupAhora() { return _backupAhora(); }
function backupSemanal() { _backupAhora(); }   // la que llama el trigger

function _backupHayTrigger() {
  try {
    var trigs = ScriptApp.getProjectTriggers();
    for (var i = 0; i < trigs.length; i++) {
      if (trigs[i].getHandlerFunction() === 'backupSemanal') return true;
    }
  } catch (err) {}
  return false;
}

function _backupTriggerActivar() {
  if (!_backupHayTrigger()) {
    ScriptApp.newTrigger('backupSemanal').timeBased()
      .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(6).create();
  }
  return _backupEstado();
}

function _backupTriggerDesactivar() {
  var trigs = ScriptApp.getProjectTriggers();
  for (var i = 0; i < trigs.length; i++) {
    if (trigs[i].getHandlerFunction() === 'backupSemanal') ScriptApp.deleteTrigger(trigs[i]);
  }
  return _backupEstado();
}

// Nombre público para instalar el semanal a mano desde el editor
function instalarBackupSemanal() { return _backupTriggerActivar(); }
function desinstalarBackupSemanal() { return _backupTriggerDesactivar(); }

// Estado que la app pinta en Admin → Config → ☁️
function _backupEstado() {
  var ultimo = null;
  try { ultimo = PropertiesService.getScriptProperties().getProperty(BACKUP_PROPIEDAD); } catch (err) {}
  var archivos = 0;
  try {
    var it = DriveApp.searchFiles('name contains "' + BACKUP_PREFIJO + '" and mimeType = "' + MimeType.GOOGLE_SHEETS + '"');
    while (it.hasNext()) { it.next(); archivos++; }
  } catch (err) {}
  return { ok: true, ultimo: ultimo, trigger: _backupHayTrigger(), archivos: archivos };
}
