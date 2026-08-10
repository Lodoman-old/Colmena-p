var _notifyTimer;
window.notify = function(msg, type) {
  type = type || 'error';
  var el = document.getElementById('notify-toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'notify-toast notify-' + type;
  el.style.display = 'block';
  clearTimeout(_notifyTimer);
  _notifyTimer = setTimeout(function(){ el.style.display = 'none'; }, 4000);
};
window.alert = function(msg) { window.notify(msg, 'info'); };
window.confirmAsync = function(msg) {
  return new Promise(function(resolve) {
    var el = document.getElementById('confirm-modal');
    if (!el) { resolve(confirm(msg)); return; }
    el.querySelector('.confirm-msg').textContent = msg;
    el.style.display = 'flex';
    el.querySelector('.confirm-yes').onclick = function() { el.style.display = 'none'; resolve(true); };
    el.querySelector('.confirm-no').onclick = function() { el.style.display = 'none'; resolve(false); };
  });
};

const API = (() => {
  const BASE = localStorage.getItem('colmena_server') || '';
  const _getCache = new Map();
  const _getCacheTtl = 20000;
  let _staleServed = false;
  let token = localStorage.getItem('colmena_token');
  let currentUser = (() => { try { return JSON.parse(localStorage.getItem('colmena_user') || 'null'); } catch { return null; } })();

  function setToken(t) {
    token = t;
    if (t) localStorage.setItem('colmena_token', t);
    else localStorage.removeItem('colmena_token');
  }

  function guardarUser() {
    if (currentUser) localStorage.setItem('colmena_user', JSON.stringify(currentUser));
    else localStorage.removeItem('colmena_user');
  }

  async function request(method, path, body = null, timeoutMs = 15000) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const cacheKey = method + ' ' + path;
    if (method === 'GET') {
      const hit = _getCache.get(cacheKey);
      if (hit && Date.now() - hit.ts < _getCacheTtl) return hit.data;
    }
    const res = await Promise.race([
      fetch(`${BASE}${path}`, opts),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
    ]);
    const fromSwCache = res.headers.get('X-SW-Stale') === '1';
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text || 'Error de conexión' }; }
    if (!res.ok) throw new Error(data.error || 'Error de conexión');
    if (method === 'GET') {
      if (fromSwCache) _staleServed = true;
      else _staleServed = false;
      if (!fromSwCache) _getCache.set(cacheKey, { ts: Date.now(), data });
    } else _getCache.clear();
    return data;
  }

  function limpiarCache() {
    _getCache.clear();
  }

  async function requestBlob(method, path, body = null, timeoutMs = 30000) {
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await Promise.race([
      fetch(`${BASE}${path}`, opts),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
    ]);
    if (!res.ok) {
      const text = await res.text();
      let data; try { data = JSON.parse(text); } catch { data = { error: text || 'Error de conexión' }; }
      throw new Error(data.error || 'Error de conexión');
    }
    return await res.blob();
  }

  return {
    async login(email, password) {
      const data = await request('POST', '/api/auth/login', { email, password });
      setToken(data.token);
      currentUser = data.user;
      guardarUser();
      return data;
    },
    setToken(t) { setToken(t); },
    setUser(u) { currentUser = u; guardarUser(); },
    logout() { setToken(null); currentUser = null; guardarUser(); },
    getToken() { return token; },
    getUser() { return currentUser; },
    getBase() { return BASE; },

    getEstados() { return request('GET', '/api/estados'); },
    getEstadoDefault() { return request('GET', '/api/estados/default'); },
    crearEstado(data) { return request('POST', '/api/estados', data); },
    actualizarEstado(id, data) { return request('PUT', `/api/estados/${id}`, data); },
    eliminarEstado(id) { return request('DELETE', `/api/estados/${id}`); },

    getMunicipios(estadoId) { return estadoId ? request('GET', `/api/municipios/${estadoId}`) : request('GET', '/api/municipios'); },
    getMunicipioDefault() { return request('GET', '/api/municipios/default'); },
    crearMunicipio(data) { return request('POST', '/api/municipios', data); },
    actualizarMunicipio(id, data) { return request('PUT', `/api/municipios/${id}`, data); },
    eliminarMunicipio(id) { return request('DELETE', `/api/municipios/${id}`); },

    getSecciones() { return request('GET', '/api/secciones'); },
    getSeccionesPorMunicipio(municipioId) { return request('GET', `/api/secciones/${municipioId}`); },
    crearSeccion(data) { return request('POST', '/api/secciones', data); },
    actualizarSeccion(id, data) { return request('PUT', `/api/secciones/${id}`, data); },
    eliminarSeccion(id) { return request('DELETE', `/api/secciones/${id}`); },

    getCiudadanos(seccionId) { return request('GET', `/api/ciudadanos${seccionId ? '?seccion_id='+seccionId : ''}`); },
    getCiudadano(id) { return request('GET', `/api/ciudadanos/${id}`); },
    crearCiudadano(data) { return request('POST', '/api/ciudadanos', data); },
    actualizarCiudadano(id, data) { return request('PUT', `/api/ciudadanos/${id}`, data); },
    eliminarCiudadano(id) { return request('DELETE', `/api/ciudadanos/${id}`); },

    getComprometidos(seccionId) { return request('GET', `/api/comprometidos${seccionId ? '?seccion_id='+seccionId : ''}`); },
    getComprometido(id) { return request('GET', `/api/comprometidos/${id}`); },
    crearComprometido(data) { return request('POST', '/api/comprometidos', data); },
    actualizarComprometido(id, data) { return request('PUT', `/api/comprometidos/${id}`, data); },
    eliminarComprometido(id) { return request('DELETE', `/api/comprometidos/${id}`); },

    getEventos() { return request('GET', '/api/eventos'); },
    crearEvento(data) { return request('POST', '/api/eventos', data); },
    actualizarEvento(id, data) { return request('PUT', `/api/eventos/${id}`, data); },
    eliminarEvento(id) { return request('DELETE', `/api/eventos/${id}`); },

    getMision(seccionId, soloSimpatizantes = false) {
      return request('POST', '/api/rutas/mision', { seccion_id: seccionId, tipo: soloSimpatizantes ? 'seguros' : 'encuesta' });
    },
    optimizarRuta(origenLat, origenLng, seccionId, soloSimpatizantes = false) {
      return request('POST', '/api/rutas/optimizar', {
        origen_lat: origenLat, origen_lng: origenLng, seccion_id: seccionId, tipo: soloSimpatizantes ? 'seguros' : 'encuesta'
      });
    },
    getParadas(seccionId) { return request('GET', `/api/rutas/paradas/${seccionId}`); },
    getCiudadanosEnRadio(eventoId) { return request('GET', `/api/eventos/${eventoId}/ciudadanos`); },
    getGeocercas(seccionId) { return request('GET', `/api/geo/geocercas/${seccionId || ''}`); },
    checkProximidad(ciudadanoId, geocercaId) {
      return request('POST', '/api/geo/proximidad', { ciudadano_id: ciudadanoId, geocerca_id: geocercaId });
    },
    getPartidos() { return request('GET', '/api/partidos'); },
    crearPartido(data) { return request('POST', '/api/partidos', data); },
    actualizarPartido(id, data) { return request('PUT', `/api/partidos/${id}`, data); },
    eliminarPartido(id) { return request('DELETE', `/api/partidos/${id}`); },
    getResultados(seccionId, casillaId, tipo) { let q = ''; if (tipo) q += 'tipo='+tipo; if (seccionId) q += (q?'&':'')+'seccion_id='+seccionId; if (casillaId) q += (q?'&':'')+'casilla_id='+casillaId; return request('GET', `/api/resultados${q?'?'+q:''}`); },
    crearResultado(data) { return request('POST', '/api/resultados', data); },
    eliminarResultado(id) { return request('DELETE', `/api/resultados/${id}`); },
    getCasillas(seccionId) { return request('GET', `/api/casillas${seccionId ? '?seccion_id='+seccionId : ''}`); },
    crearCasilla(data) { return request('POST', '/api/casillas', data); },
    actualizarCasilla(id, data) { return request('PUT', `/api/casillas/${id}`, data); },
    eliminarCasilla(id) { return request('DELETE', `/api/casillas/${id}`); },
    getVotantesCasilla(id) { return request('GET', `/api/casillas/${id}/votantes`); },
    marcarVoto(ciudadanoId, comprometidoId) { return request('POST', '/api/votos', { ciudadano_id: ciudadanoId, comprometido_id: comprometidoId }); },
    quitarVoto(tipo, id) { return request('DELETE', `/api/votos/${tipo}/${id}`); },
    getReporteVotacion(seccionId) { return request('GET', `/api/reportes/votacion${seccionId ? '?seccion_id='+seccionId : ''}`); },
    getPdfVotantes(seccionId, casillaId) {
      let q = '';
      if (casillaId) q += 'casilla_id=' + casillaId;
      else if (seccionId) q += 'seccion_id=' + seccionId;
      return requestBlob('GET', `/api/reportes/pdf-votantes${q ? '?' + q : ''}`);
    },
    request(method, path, body) { return request(method, path, body); },
    requestBlob(method, path, body) { return requestBlob(method, path, body); },
    getGeometrias(municipioId) { return request('GET', `/api/secciones/${municipioId}/geometrias`); },
    getSeccionesAlcanzadas(eventoId) { return request('GET', `/api/geocercas/${eventoId}/secciones-alcanzadas`); },
    getAlertasStats() { return request('GET', '/api/alertas/stats'); },
    getAlertasUltimas() { return request('GET', '/api/alertas/ultimas'); },
    dispararAlertasEvento(id) { return request('POST', `/api/eventos/${id}/disparar-alertas`); },
    getPlantillas() { return request('GET', '/api/plantillas'); },
    getPlantillasWhatsapp() { return request('GET', '/api/plantillas-whatsapp'); },
    crearPlantilla(data) { return request('POST', '/api/plantillas', data); },
    actualizarPlantilla(id, data) { return request('PUT', `/api/plantillas/${id}`, data); },
    eliminarPlantilla(id) { return request('DELETE', `/api/plantillas/${id}`); },
    getCampanas() { return request('GET', '/api/campanas'); },
    crearCampana(data) { return request('POST', '/api/campanas', data); },
    actualizarCampana(id, data) { return request('PUT', `/api/campanas/${id}`, data); },
    eliminarCampana(id) { return request('DELETE', `/api/campanas/${id}`); },
    previsualizarCampana(filtros) { return request('POST', '/api/campanas/preview', { filtros }); },
    enviarUbicacion(lat, lng, precision) { return request('POST', '/api/ubicacion', { lat, lng, precision }); },
    getUbicaciones() { return request('GET', '/api/ubicaciones'); },
    pushSubscribe(sub) { return request('POST', '/api/push/subscribe', sub); },
    pushUnsubscribe(endpoint) { return request('DELETE', '/api/push/unsubscribe', { endpoint }); },
    getFiltrosCampana() { return request('GET', '/api/filtros-campana'); },
    crearFiltroCampana(data) { return request('POST', '/api/filtros-campana', data); },
    actualizarFiltroCampana(id, data) { return request('PUT', `/api/filtros-campana/${id}`, data); },
    eliminarFiltroCampana(id) { return request('DELETE', `/api/filtros-campana/${id}`); },
    detectarSeccion(lat, lng) { return request('GET', `/api/detectar-seccion?lat=${lat}&lng=${lng}`); },
    uploadImage(base64) { return request('POST', '/api/upload', { image: base64 }, 8000); },
    requestWithTimeout(method, path, body, timeoutMs) { return request(method, path, body, timeoutMs); },
    limpiarCache: limpiarCache,
    isStaleData() { return _staleServed; }
  };
})();
