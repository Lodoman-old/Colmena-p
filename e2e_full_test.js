const http = require('http');
const JWT_SECRET = process.env.JWT_SECRET;
const token = require('jsonwebtoken').sign({ userId: 'b0000000-0000-0000-0000-000000000001', rol: 'admin' }, JWT_SECRET);

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'localhost', port: 3000, path: '/api' + path, method,
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, data: buf }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function run() {
  let pass = 0, fail = 0;
  function ok(name, cond, detail) {
    if (cond) { pass++; console.log('  PASS: ' + name); }
    else { fail++; console.log('  FAIL: ' + name + (detail ? ' | ' + JSON.stringify(detail).slice(0,200) : '')); }
  }

  console.log('\n=== E2E FULL TEST ===\n');

  // Setup: get valid IDs
  const secs = await api('GET', '/secciones?municipio_id=1');
  const secId = secs.data?.[0]?.id || 1;
  const casillas = await api('GET', '/casillas?seccion_id=' + secId);
  const casId = casillas.data?.[0]?.id || null;
  const partidos = await api('GET', '/partidos');
  const parId = partidos.data?.[0]?.id || 1;
  const usuarios = await api('GET', '/usuarios');
  const enlace = usuarios.data?.find(u => u.rol === 'enlace');
  const enlaceId = enlace?.id || 'b0000000-0000-0000-0000-000000000001';
  console.log('  secId:', secId, 'casId:', casId, 'parId:', parId, 'enlaceId:', enlaceId);

  // 1. Ciudadano
  console.log('1. CIUDADANO');
  const ciuRes = await api('POST', '/ciudadanos', {
    nombre: 'E2E Ciudadano', apellido_paterno: 'Auto', apellido_materno: 'Test',
    telefono: '4421234567', edad: 35, cp: '76120', calle: 'Av. Test', numero: '100',
    colonia: 'Centro', estado_id: 14, municipio_id: 1, seccion_id: secId,
    casilla_id: casId, lat: 20.5, lng: -100.39, sexo: 'H', prioridad: 1,
    intencion_voto_presidente: parId, intencion_voto_diputado: parId,
    motivo_puerta: 'no_abrio', votantes_casa: 3
  });
  ok('Ciudadano created', ciuRes.status === 201 || ciuRes.status === 200, ciuRes.data);
  const ciuId = ciuRes.data?.id;

  // 2. Comprometido
  console.log('2. COMPROMETIDO');
  const compRes = await api('POST', '/comprometidos', {
    nombre: 'E2E Simpatizante', apellido_paterno: 'Simpa', apellido_materno: 'Auto',
    telefono: '4429876543', fecha_nacimiento: '1990-05-15', vigencia_ine: '2030-01-01',
    curp: 'SITA900515MQRTRR01', ine: 'INE123456',
    correo: 'simpa@test.com', estado_id: 14, municipio_id: 1, seccion_id: secId,
    casilla_id: casId, calle: 'Calle Simpa', numero: '50', colonia: 'Centro', cp: '76120',
    lat: 20.51, lng: -100.38, sexo: 'M',
    intencion_voto_presidente: parId, intencion_voto_diputado: parId
  });
  ok('Comprometido created', compRes.status === 201 || compRes.status === 200, compRes.data);
  const compId = compRes.data?.id;

  // 3. Ruta general (needs enlace_ids)
  console.log('3. RUTA GENERAL');
  const rutaGenRes = await api('POST', '/rutas', {
    nombre: 'E2E Ruta General', seccion_id: secId, tipo: 'general',
    destino: 'general', enlace_ids: [enlaceId]
  });
  ok('Ruta general created', rutaGenRes.status === 201 || rutaGenRes.status === 200, rutaGenRes.data);

  // 4. Ruta simpatizantes
  console.log('4. RUTA SIMPATIZANTES');
  const rutaSimRes = await api('POST', '/rutas', {
    nombre: 'E2E Ruta Simpatizantes', seccion_id: secId, tipo: 'simpatizantes',
    destino: 'simpatizantes', enlace_ids: [enlaceId]
  });
  ok('Ruta simpatizantes created', rutaSimRes.status === 201 || rutaSimRes.status === 200, rutaSimRes.data);

  // 5. Preview ruta filtro
  console.log('5. PREVIEW RUTA FILTRO');
  const previewRes = await api('POST', '/rutas/preview-filtro', {
    destino: 'general', seccion_id: secId, filtros: {}
  });
  ok('Preview filtro', previewRes.status === 200, previewRes.data);

  // 6. Reporte confirmaciones
  console.log('6. REPORTE CONFIRMACIONES');
  const repConfRes = await api('GET', '/reportes/confirmaciones');
  ok('Reporte confirmaciones', repConfRes.status === 200, repConfRes.data);

  // 7. Reporte rutas
  console.log('7. REPORTE RUTAS');
  const repRutaRes = await api('GET', '/reportes/rutas');
  ok('Reporte rutas', repRutaRes.status === 200, typeof repRutaRes.data);

  // 8. Reporte capturados general
  console.log('8. REPORTE CAPTURADOS');
  const repCapRes = await api('GET', '/reportes/capturados-general');
  ok('Reporte capturados general', repCapRes.status === 200, typeof repCapRes.data);

  // 9. Reporte revisitas
  console.log('9. REPORTE REVISITAS');
  const repRevRes = await api('GET', '/reportes/revisitas');
  ok('Reporte revisitas', repRevRes.status === 200, typeof repRevRes.data);

  // 10. Cleanup
  console.log('10. CLEANUP');
  if (ciuId) { const r = await api('DELETE', '/ciudadanos/' + ciuId); ok('Ciudadano deleted', r.status === 200 || r.status === 204); }
  if (compId) { const r = await api('DELETE', '/comprometidos/' + compId); ok('Comprometido deleted', r.status === 200 || r.status === 204); }

  console.log('\n=== RESULTS: ' + pass + ' PASS, ' + fail + ' FAIL ===\n');
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
