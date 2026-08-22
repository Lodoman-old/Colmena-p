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
window.alert = function(msg, opts) {
  opts = opts || {};
  var el = document.getElementById('alert-modal');
  if (!el) { window.notify(msg, 'info'); return; }
  var tipo = opts.type || 'info';
  var iconos = { info: 'ℹ️', success: '✅', error: '⚠️', warn: '⚠️' };
  var titulos = { info: 'Aviso', success: 'Listo', error: 'Atención', warn: 'Atención' };
  document.getElementById('alert-icon').textContent = iconos[tipo] || iconos.info;
  document.getElementById('alert-title').textContent = opts.title || titulos[tipo] || 'Aviso';
  var msgEl = document.getElementById('alert-msg');
  msgEl.textContent = String(msg == null ? '' : msg);
  el.dataset.tipo = tipo;
  el.style.display = 'flex';
  var btn = document.getElementById('alert-ok');
  btn.onclick = function() { el.style.display = 'none'; if (opts.onOk) opts.onOk(); };
};
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
  const _lsPathRe = /^\/api\/(secciones\/\d+|secciones|partidos|estados(\/default)?|municipios(\/\d+|\/default)?)$/;
  function _lsKey(path) { return 'colmena_api_cache_' + path.replace(/[^a-z0-9]/gi, '_'); }
  function lsCacheGet(path) {
    if (!_lsPathRe.test(path)) return null;
    try {
      const raw = localStorage.getItem(_lsKey(path));
      if (!raw) return null;
      const c = JSON.parse(raw);
      if (Date.now() - (c.ts || 0) > 7 * 86400000) { localStorage.removeItem(_lsKey(path)); return null; }
      return c.data;
    } catch { return null; }
  }
  function lsCacheSet(path, data) {
    if (!_lsPathRe.test(path)) return;
    try { localStorage.setItem(_lsKey(path), JSON.stringify({ ts: Date.now(), data })); } catch {}
  }
  let _staleServed = false;
  let token = localStorage.getItem('colmena_token');
  let refreshToken = localStorage.getItem('colmena_refresh');
  let currentUser = (() => { try { return JSON.parse(localStorage.getItem('colmena_user') || 'null'); } catch { return null; } })();

  function setToken(t) {
    token = t;
    if (t) localStorage.setItem('colmena_token', t);
    else localStorage.removeItem('colmena_token');
  }

  function setRefreshToken(rt) {
    refreshToken = rt;
    if (rt) localStorage.setItem('colmena_refresh', rt);
    else localStorage.removeItem('colmena_refresh');
  }

  function guardarUser() {
    if (currentUser) localStorage.setItem('colmena_user', JSON.stringify(currentUser));
    else localStorage.removeItem('colmena_user');
  }

  let _cerrandoSesion = false;
  function cerrarSesionTokenExpirado() {
    if (_cerrandoSesion) return;
    _cerrandoSesion = true;
    setToken(null);
    setRefreshToken(null);
    localStorage.removeItem('colmena_user');
    _getCache.clear();
    if (typeof window.__colmenaCerrarSesion === 'function') {
      window.__colmenaCerrarSesion();
    } else {
      location.reload();
    }
  }

  async function renovarSesion() {
    if (!refreshToken) return false;
    try {
      const d = await request('POST', '/api/auth/refresh', { refresh_token: refreshToken }, 12000);
      setToken(d.token);
      setRefreshToken(d.refresh_token);
      currentUser = d.user;
      guardarUser();
      return true;
    } catch { return false; }
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
    let res;
    if (method === 'GET' && !navigator.onLine) {
      const cachedNow = lsCacheGet(path);
      if (cachedNow) {
        if (typeof window.notify === 'function') window.notify('Sin conexión: usando datos guardados', 'info');
        return cachedNow;
      }
    }
    try {
      res = await Promise.race([
        fetch(`${BASE}${path}`, opts),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
      ]);
    } catch (e) {
      if (method === 'GET') {
        const cached = lsCacheGet(path);
        if (cached) {
          if (typeof window.notify === 'function') window.notify('Sin conexión: usando datos guardados', 'info');
          return cached;
        }
      }
      throw e;
    }
    const fromSwCache = res.headers.get('X-SW-Stale') === '1';
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { error: text || 'Error de conexión' }; }
    if (!res.ok) {
      if ((res.status === 401 || res.status === 403) && /token/i.test(data.error || '')) {
        if (await renovarSesion()) return request(method, path, body, timeoutMs);
        cerrarSesionTokenExpirado();
      }
      if (method === 'GET') {
        const cached = lsCacheGet(path);
        if (cached) {
          if (typeof window.notify === 'function') window.notify('Sin conexión: usando datos guardados', 'info');
          return cached;
        }
      }
      throw new Error(data.error || 'Error de conexión');
    }
    if (method === 'GET') {
      if (fromSwCache) _staleServed = true;
      else _staleServed = false;
      if (!fromSwCache) {
        _getCache.set(cacheKey, { ts: Date.now(), data });
        lsCacheSet(path, data);
      }
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
      setRefreshToken(data.refresh_token);
      currentUser = data.user;
      guardarUser();
      return data;
    },
    setToken(t) { setToken(t); },
    setUser(u) { currentUser = u; guardarUser(); },
    logout() {
      const rt = refreshToken;
      setToken(null);
      setRefreshToken(null);
      currentUser = null;
      guardarUser();
      if (rt) fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: rt }) }).catch(() => {});
    },
    getToken() { return token; },
    getUser() { return currentUser; },
    getBase() { return BASE; },
    cerrarSesionTokenExpirado() { cerrarSesionTokenExpirado(); },
    async renovarSesionSiNecesario() {
      if (refreshToken) return await renovarSesion();
      return !!token;
    },

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
    solicitarCorreccionComprometido(id) { return request('POST', `/api/comprometidos/${id}/solicitar-correccion`); },

    getCatalogo(tipo, todos) { return request('GET', `/api/catalogos/${tipo}${todos ? '?todos=1' : ''}`); },
    crearCatalogoItem(tipo, data) { return request('POST', `/api/catalogos/${tipo}`, data); },
    actualizarCatalogoItem(tipo, id, data) { return request('PUT', `/api/catalogos/${tipo}/${id}`, data); },
    eliminarCatalogoItem(tipo, id) { return request('DELETE', `/api/catalogos/${tipo}/${id}`); },
    previewRutaFiltro(seccionId, filtros) { return request('POST', '/api/rutas/preview-filtro', { seccion_id: seccionId, filtros, destino: filtros && filtros.destino }); },
    getReporteRevisitas(dias) { return request('GET', `/api/reportes/revisitas${dias ? '?dias=' + dias : ''}`); },
    getReporteConfirmaciones(seccionId) { return request('GET', `/api/reportes/confirmaciones${seccionId ? '?seccion_id=' + seccionId : ''}`); },

    getSeccionalCapturistas() { return request('GET', '/api/seccional/capturistas'); },
    putSeccionalCapturistas(capturistaIds) { return request('PUT', '/api/seccional/capturistas', { capturista_ids: capturistaIds }); },
    getMetas() { return request('GET', '/api/metas'); },
    putMeta(capturistaId, meta) { return request('PUT', `/api/metas/${capturistaId}`, { meta }); },
    getCapturasPorCapturista() { return request('GET', '/api/reportes/capturas-por-capturista'); },
    getMisCasillasRep() { return request('GET', '/api/representante/casillas'); },

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
    getGeometrias(municipioId, todas) { return request('GET', `/api/secciones/${municipioId}/geometrias${todas ? '?todas=1' : ''}`); },
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
