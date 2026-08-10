(function() {
  let dashboardMap = null;
  let _dashLoadSeq = 0;
  let dashboardClusterGroup = null;
  let dashboardGeoLayer = null;
  let dashboardEnlacesLayer = null;
  let barridoClusterGroup = null;
  let geocercasMap = null;
  let geocercasClusterGroup = null;
  let geocercasGeoLayer = null;
  let rutaMap = null;
  let rutaWatchId = null;
  let rutaGpsMarker = null;
  let _debounceTimers = {};
  let _gpsUsed = false;
  let _gpsFixObtained = false;

  // ── Tile cache (persistent, offline-capable) ──
  var TILE_CACHE_MAX = 3000;
  var _tileDb = null;
  function tileDb() {
    if (_tileDb) return Promise.resolve(_tileDb);
    return idbOpen().then(function(db) {
      _tileDb = db;
      db.onversionchange = function() { try { db.close(); } catch (e) {} _tileDb = null; };
      return db;
    });
  }
  function tileCacheGet(url) {
    return tileDb().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction('tiles', 'readonly');
        var req = tx.objectStore('tiles').index('url').get(url);
        req.onsuccess = function() { resolve(req.result ? req.result.blob : null); };
        req.onerror = function() { reject(req.error); };
      });
    });
  }
  function tileCachePut(url, blob) {
    return tileDb().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction('tiles', 'readwrite');
        tx.objectStore('tiles').put({ url: url, ts: Date.now(), blob: blob });
        tx.oncomplete = function() { resolve(); };
        tx.onerror = function() { reject(tx.error); };
      });
    });
  }
  function tileCachePutBatch(entries) {
    if (!entries.length) return Promise.resolve();
    return tileDb().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction('tiles', 'readwrite');
        var store = tx.objectStore('tiles');
        var ts = Date.now();
        entries.forEach(function(en) { store.put({ url: en.url, ts: ts, blob: en.blob }); });
        tx.oncomplete = function() { resolve(); };
        tx.onerror = function() { reject(tx.error); };
      });
    });
  }
  var _ultimaPurga = 0;
  function tileCachePurgeLite() {
    var now = Date.now();
    if (now - _ultimaPurga < 60000) return Promise.resolve();
    _ultimaPurga = now;
    return tileCachePurge().catch(function() {});
  }
  function tileCachePurge() {
    return tileDb().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction('tiles', 'readwrite');
        var store = tx.objectStore('tiles');
        var countReq = store.count();
        countReq.onsuccess = function() {
          if (countReq.result <= tileCacheMax()) { tx.oncomplete = function() { resolve(); }; return; }
          var toDelete = Math.floor(countReq.result * 0.2);
          var idx = store.index('ts');
          var cur = idx.openCursor();
          var deleted = 0;
          cur.onsuccess = function(e) {
            var cursor = e.target.result;
            if (cursor && deleted < toDelete) {
              cursor.delete();
              deleted++;
              cursor.continue();
            }
          };
        };
        tx.oncomplete = function() { resolve(); };
        tx.onerror = function() { reject(tx.error); };
      });
    });
  }

  var TileCachedLayer = L.TileLayer.extend({
    createTile: function(coords, done) {
      var tile = document.createElement('img');
      tile.alt = '';
      var url = this.getTileUrl(coords);
      var self = this;
      tileCacheGet(url).then(function(blob) {
        if (blob) { tile.src = URL.createObjectURL(blob); done(null, tile); }
        else self._cargarRemoto(tile, url, done, false);
      }).catch(function() { self._cargarRemoto(tile, url, done, false); });
      return tile;
    },
    _cargarRemoto: function(tile, url, done, reintento) {
      var self = this;
      var u = url;
      var local = esriUrlToLocal(url);
      if (!reintento && local) u = local;
      fetch(u).then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      }).then(function(blob) {
        tileCachePut(url, blob).catch(function() {});
        tile.src = URL.createObjectURL(blob);
        done(null, tile);
      }).catch(function(e) {
        if (!reintento) {
          if (u !== url) { setTimeout(function() { self._cargarRemoto(tile, url, done, true); }, 400); return; }
          setTimeout(function() { self._cargarRemoto(tile, url, done, true); }, 1500);
        } else done(e);
      });
    }
  });

  function crearTileLayer(opts) {
    if (!opts) opts = {};
    if (!opts.maxZoom) opts.maxZoom = 19;
    return new TileCachedLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', opts);
  }

  // Prefetch tiles of current view (zoom y zoom+1) after the map stops moving
  function prefetchTilesCercanas(mapa, layer) {
    try {
      if (!mapa || !layer) return;
      var zoomBase = Math.min(mapa.getZoom(), 17);
      var bounds = mapa.getBounds();
      var urls = [];
      [zoomBase, zoomBase + 1].forEach(function(z) {
        try {
          var nw = mapa.project(bounds.getNorthWest(), z);
          var se = mapa.project(bounds.getSouthEast(), z);
          var x0 = Math.floor(nw.x / 256), y0 = Math.floor(nw.y / 256);
          var x1 = Math.floor(se.x / 256), y1 = Math.floor(se.y / 256);
          var yMax = Math.pow(2, z);
          for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) {
            if (y < 0 || y >= yMax) continue;
            urls.push(layer.getTileUrl({ x: x, y: y, z: z }));
          }
        } catch (e) {}
      });
      var i = 0;
      function siguiente() {
        if (i >= urls.length) return;
        var url = urls[i++];
        tileCacheGet(url).then(function(blob) {
          if (!blob) {
            fetch(url).then(function(r) {
              if (r.ok) return r.blob();
              throw new Error('HTTP ' + r.status);
            }).then(function(b) { tileCachePut(url, b).catch(function() {}); })
              .catch(function() {});
          }
          setTimeout(siguiente, 250);
        }).catch(function() { setTimeout(siguiente, 250); });
      }
      siguiente();
    } catch (e) { console.warn('prefetch error:', e); }
  }

  function activarPrefetchMapa(mapa) {
    if (!mapa) return;
    var layer = null;
    Object.keys(mapa._layers || {}).forEach(function(k) {
      if (mapa._layers[k] instanceof TileCachedLayer) layer = mapa._layers[k];
    });
    if (!layer) return;
    var t = null;
    mapa.on('moveend', function() {
      if (t) clearTimeout(t);
      t = setTimeout(function() { prefetchTilesCercanas(mapa, layer); }, 3000);
    });
    setTimeout(function() { prefetchTilesCercanas(mapa, layer); }, 4000);
  }

  // ── Municipio offline download ──
  function tileCacheMax() {
    var n = parseInt(localStorage.getItem('colmena_tile_max') || '', 10);
    return (isNaN(n) || n < TILE_CACHE_MAX) ? TILE_CACHE_MAX : n;
  }
  var _descargaOffline = null;
  var TILE_URL_BASE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/';
  function esriUrlToLocal(url) {
    try {
      var m = String(url).match(/MapServer\/tile\/(\d+)\/(\d+)\/(\d+)/);
      if (!m) return null;
      return (localStorage.getItem('colmena_server') || '') + '/tiles/' + m[1] + '/' + m[2] + '/' + m[3] + '.jpg';
    } catch (e) { return null; }
  }
  var _tilesLocalesOk = 0;
  function fetchTileConLocal(url, opts) {
    var local = esriUrlToLocal(url);
    if (!local) return fetch(url, opts);
    return fetch(local, opts).then(function(r) {
      if (r.ok) { _tilesLocalesOk++; return r; }
      throw new Error('HTTP ' + r.status);
    }).catch(function() { return fetch(url); });
  }

  function bboxDeGeometrias(geojson) {
    if (!geojson?.features?.length) return null;
    var minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    function recorrer(c) {
      if (typeof c[0] === 'number') {
        if (c[1] < minLat) minLat = c[1]; if (c[1] > maxLat) maxLat = c[1];
        if (c[0] < minLng) minLng = c[0]; if (c[0] > maxLng) maxLng = c[0];
      } else { c.forEach(recorrer); }
    }
    geojson.features.forEach(function(f) { if (f?.geometry?.coordinates) recorrer(f.geometry.coordinates); });
    if (minLat > maxLat) return null;
    return { latMin: minLat - 0.005, latMax: maxLat + 0.005, lngMin: minLng - 0.005, lngMax: maxLng + 0.005 };
  }

  async function descargarMunicipio() {
    if (_descargaOffline) return;
    var select = document.getElementById('dash-municipio');
    var muniId = parseInt(select?.value || '', 10) || 11035;
    var muni = (typeof todosMunicipios !== 'undefined' ? todosMunicipios : []).find(function(m) { return m.id === muniId; });
    var nombre = muni?.nombre || 'Municipio seleccionado';
    var modal = document.getElementById('offline-modal');
    document.getElementById('offline-nombre').textContent = 'Descargando: ' + nombre;
    document.getElementById('offline-status').textContent = 'Calculando área...';
    document.getElementById('offline-detail').textContent = '';
    document.getElementById('offline-bar-fill').style.width = '0%';
    document.getElementById('offline-actions').style.display = 'none';
    document.getElementById('offline-actions-done').style.display = 'none';
    modal.classList.remove('hidden');

    var serverUrl = localStorage.getItem('colmena_server') || '(vacío)';
    var diagEl = document.getElementById('offline-diag');
    var swInfo = '';
    if (navigator.serviceWorker && navigator.serviceWorker.controller) swInfo = 'SW activo';
    else if ('serviceWorker' in navigator) swInfo = 'SW no controla';
    else swInfo = 'sin SW';
    if (diagEl) diagEl.textContent = 'Servidor: ' + serverUrl + ' · ' + swInfo;
    var probeLocal = esriUrlToLocal(TILE_URL_BASE + '15/14446/7179.jpg');
    if (probeLocal && diagEl) {
      var t0 = Date.now(), okProbe = 0;
      (async function() {
        for (var p = 0; p < 5; p++) {
          try {
            var rp = await fetch(probeLocal, { cache: 'no-store' });
            if (rp.ok) okProbe++;
          } catch (e) {}
        }
        var ms = Math.round((Date.now() - t0) / 5);
        diagEl.textContent = 'Servidor: ' + serverUrl + ' · ' + swInfo + ' · probe 5 tiles: ' + okProbe + '/5 OK, ~' + ms + ' ms/tile';
      })();
    }

    var bbox = null;
    try { bbox = bboxDeGeometrias(await API.getGeometrias(muniId)); } catch (e) { console.warn(e); }
    if (!bbox && muni?.lat && muni?.lng) {
      bbox = { latMin: muni.lat - 0.14, latMax: muni.lat + 0.14, lngMin: muni.lng - 0.14, lngMax: muni.lng + 0.14 };
    }
    if (!bbox) {
      document.getElementById('offline-status').textContent = 'No se pudo calcular el área del municipio.';
      document.getElementById('offline-actions').style.display = 'none';
      return;
    }

    var urls = [];
    for (var z = 13; z <= 19; z++) {
      var n = Math.pow(2, z);
      var x0 = Math.max(0, Math.floor(((bbox.lngMin + 180) / 360) * n));
      var x1 = Math.min(n - 1, Math.floor(((bbox.lngMax + 180) / 360) * n));
      function tileY(lat, zz) { var r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, zz)); }
      var y0 = Math.max(0, tileY(bbox.latMax, z));
      var y1 = Math.min(n - 1, tileY(bbox.latMin, z));
      for (var x = x0; x <= x1; x++) for (var y = y0; y <= y1; y++) urls.push(TILE_URL_BASE + z + '/' + y + '/' + x);
    }

    var total = urls.length;
    if (!total) {
      document.getElementById('offline-status').textContent = 'El área no contiene tiles.';
      document.getElementById('offline-actions').style.display = 'none';
      return;
    }

    var yaDescargados = {};
    try {
      var db = await idbOpen();
      await new Promise(function(resolve, reject) {
        var tx = db.transaction('tiles', 'readonly');
        var cur = tx.objectStore('tiles').index('url').openCursor();
        cur.onsuccess = function(e) {
          var c = e.target.result;
          if (c) { yaDescargados[c.value.url] = true; c.continue(); }
          else resolve();
        };
        cur.onerror = function() { reject(cur.error); };
      });
      db.close();
    } catch (e) { console.warn(e); }

    var pendientes = urls.filter(function(u) { return !yaDescargados[u]; });
    var totalPend = pendientes.length;
    if (!totalPend) {
      document.getElementById('offline-nombre').textContent = 'Mapa de: ' + nombre;
      document.getElementById('offline-status').textContent = '✅ El municipio ya está descargado (' + total + ' tiles).';
      document.getElementById('offline-detail').textContent = 'El mapa funciona sin internet en todo el municipio.';
      document.getElementById('offline-actions').style.display = 'none';
      document.getElementById('offline-actions-done').style.display = 'flex';
      return;
    }

    _descargaOffline = { cancelar: false, pausar: false };
    _tilesLocalesOk = 0;
    document.getElementById('offline-actions').style.display = 'flex';
    document.getElementById('offline-actions').style.gap = '8px';
    document.getElementById('btn-pausar-descarga').textContent = '⏸ Pausar';
    var maxActual = parseInt(localStorage.getItem('colmena_tile_max') || '', 10) || TILE_CACHE_MAX;
    localStorage.setItem('colmena_tile_max', String(Math.max(maxActual, total + 3000)));
    var hecho = 0, bytes = 0, errs = 0, idx = 0, fallidos = [];
    var CONCURRENCIA = 24;
    var inicio = Date.now();
    document.getElementById('offline-status').textContent = 'Descargando ' + totalPend + ' tiles...';

    function actualizar() {
      var done = hecho + fallidos.length;
      var pct = Math.min(100, done / totalPend * 100);
      document.getElementById('offline-bar-fill').style.width = pct.toFixed(2) + '%';
      var seg = (Date.now() - inicio) / 1000;
      var vel = seg > 2 ? Math.round(done / seg) : 0;
      var resto = totalPend - done;
      var eta = vel > 0 ? Math.round(resto / vel / 60) : null;
      document.getElementById('offline-status').textContent =
        (pct < 1 ? pct.toFixed(1) : pct.toFixed(0)) + '% (' + done + '/' + totalPend + ' tiles)';
      document.getElementById('offline-detail').textContent =
        Math.round(bytes / 1048576) + ' MB' +
        (vel ? ' · ' + vel + ' tiles/s' + (eta ? ' · faltan ~' + eta + ' min' : '') : '') +
        (_tilesLocalesOk ? ' · ' + _tilesLocalesOk + ' de tu servidor' : ' · todo de Esri') +
        (fallidos.length ? ' · ' + fallidos.length + ' por reintentar' : '') +
        (errs ? ' · ' + errs + ' fallos' : '');
    }
    var timer = setInterval(function() { actualizar(); }, 1000);

    async function trabajador() {
      var buffer = [];
      while (!_descargaOffline.cancelar) {
        while (_descargaOffline.pausar && !_descargaOffline.cancelar) await new Promise(function(r) { setTimeout(r, 400); });
        if (_descargaOffline.cancelar) break;
        var i = idx++;
        if (i >= pendientes.length) break;
        var url = pendientes[i];
        try {
          var ctrl = new AbortController();
          var tmo = setTimeout(function() { ctrl.abort(); }, 30000);
          var r = await fetchTileConLocal(url, { signal: ctrl.signal });
          clearTimeout(tmo);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          var blob = await r.blob();
          buffer.push({ url: url, blob: blob });
          bytes += blob.size;
          hecho++;
          if (buffer.length >= 25) { await tileCachePutBatch(buffer.splice(0)); }
          if (hecho % 250 === 0) tileCachePurgeLite();
        } catch (e) {
          fallidos.push(url);
        }
      }
      if (buffer.length) await tileCachePutBatch(buffer.splice(0));
    }
    try {
      var equipos = [];
      for (var t = 0; t < CONCURRENCIA; t++) equipos.push(trabajador());
      await Promise.all(equipos);

      if (fallidos.length && !_descargaOffline.cancelar) {
        var aReintentar = fallidos.slice();
        fallidos = [];
        var ri = 0;
        document.getElementById('offline-status').textContent = 'Reintentando ' + aReintentar.length + ' tiles fallidos...';
        async function reintentador() {
          var fallas = 0;
          var buffer2 = [];
          while (!_descargaOffline.cancelar) {
            while (_descargaOffline.pausar && !_descargaOffline.cancelar) await new Promise(function(r) { setTimeout(r, 400); });
            if (_descargaOffline.cancelar) return fallas;
            var j = ri++;
            if (j >= aReintentar.length) { if (buffer2.length) await tileCachePutBatch(buffer2.splice(0)); return fallas; }
            var url = aReintentar[j];
            try {
              var ctrl2 = new AbortController();
              var tmo2 = setTimeout(function() { ctrl2.abort(); }, 40000);
              var r2 = await fetchTileConLocal(url, { signal: ctrl2.signal });
              clearTimeout(tmo2);
              if (!r2.ok) throw new Error('HTTP ' + r2.status);
              var blob2 = await r2.blob();
              buffer2.push({ url: url, blob: blob2 });
              bytes += blob2.size;
              hecho++;
              if (buffer2.length >= 25) await tileCachePutBatch(buffer2.splice(0));
              if (hecho % 250 === 0) tileCachePurgeLite();
            } catch (e) {
              fallas++;
            }
          }
          if (buffer2.length) await tileCachePutBatch(buffer2.splice(0));
          return fallas;
        }
        var reintentos = [];
        for (var t2 = 0; t2 < 6; t2++) reintentos.push(reintentador());
        var resultados = await Promise.all(reintentos);
        errs = resultados.reduce(function(a, b) { return a + b; }, 0);
      }
    } catch (e) {
      clearInterval(timer);
      _descargaOffline = null;
      document.getElementById('offline-status').textContent = '❌ Error: ' + (e?.message || e);
      document.getElementById('offline-actions').style.display = 'none';
      document.getElementById('offline-actions-done').style.display = 'none';
      return;
    }
    clearInterval(timer);
    actualizar();
    tileCachePurgeLite();

    if (_descargaOffline.cancelar) {
      _descargaOffline = null;
      document.getElementById('offline-status').textContent = 'Descarga cancelada. Vuelve a pulsar para continuar donde quedó.';
      document.getElementById('offline-actions').style.display = 'none';
      document.getElementById('offline-actions-done').style.display = 'none';
      return;
    }
    _descargaOffline = null;
    var segs = Math.round((Date.now() - inicio) / 1000);
    document.getElementById('offline-nombre').textContent = 'Descargado: ' + nombre;
    document.getElementById('offline-status').textContent =
      '✅ Municipio descargado: ' + total + ' tiles (' + Math.round(bytes / 1048576) + ' MB) en ' + (segs > 60 ? Math.round(segs / 60) + ' min' : segs + ' s') + (errs ? ' · ' + errs + ' tiles fallaron' : '');
    document.getElementById('offline-detail').textContent = 'El mapa funcionará sin internet en todo el municipio.';
    document.getElementById('offline-actions').style.display = 'none';
    document.getElementById('offline-actions-done').style.display = 'flex';
  }

  window.cerrarModalOffline = function() {
    document.getElementById('offline-modal').classList.add('hidden');
  };
  window.descargarOtroMunicipio = function() {
    document.getElementById('offline-modal').classList.add('hidden');
    var sel = document.getElementById('dash-municipio');
    if (sel) {
      try { sel.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
      setTimeout(function() { try { sel.focus(); } catch (e) {} }, 400);
    }
  };

  window.cancelarDescargaOffline = function() {
    if (_descargaOffline) _descargaOffline.cancelar = true;
  };
  window.pausarDescargaOffline = function() {
    if (!_descargaOffline) return;
    _descargaOffline.pausar = !_descargaOffline.pausar;
    var btn = document.getElementById('btn-pausar-descarga');
    btn.textContent = _descargaOffline.pausar ? '▶ Reanudar' : '⏸ Pausar';
    document.getElementById('offline-status').textContent = _descargaOffline.pausar
      ? 'Pausado (' + document.getElementById('offline-status').textContent + ')'
      : String(document.getElementById('offline-status').textContent).replace('Pausado (', '').replace(')', '');
  };
  window.descargarMunicipio = descargarMunicipio;

  async function tryGetPosition() {
    if (typeof Capacitor !== 'undefined' && Capacitor.Plugins?.Geolocation) {
      try {
        const pos = await Capacitor.Plugins.Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
        if (pos?.coords) return pos;
      } catch (e) { console.warn('Capacitor GPS error:', e); }
    }
    if (navigator.geolocation) {
      try {
        const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 15000 }));
        if (pos?.coords) return pos;
      } catch (e) { console.warn('High-accuracy GPS error:', e); }
      try {
        const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: false, timeout: 10000 }));
        if (pos?.coords) return pos;
      } catch (e) { console.warn('Low-accuracy GPS error:', e); }
    } else {
      console.warn('navigator.geolocation no disponible (HTTPS requerido)');
    }
    return null;
  }

  function debounce(key, fn, ms) {
    if (_debounceTimers[key]) clearTimeout(_debounceTimers[key]);
    _debounceTimers[key] = setTimeout(fn, ms);
  }

  // ── Offline queue ──
  // IndexedDB offline queue (more capacity than localStorage)
  function idbOpen() {
    return new Promise(function(resolve, reject) {
      var req = indexedDB.open('colmena_offline', 2);
      req.onupgradeneeded = function(e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('tiles')) {
          var ts = db.createObjectStore('tiles', { keyPath: 'id', autoIncrement: true });
          ts.createIndex('url', 'url', { unique: true });
          ts.createIndex('ts', 'ts');
        }
      };
      req.onsuccess = function(e) { resolve(e.target.result); };
      req.onerror = function(e) { reject(e.target.error); };
    });
  }
  function idbGet(key) {
    return idbOpen().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction('kv', 'readonly');
        var req = tx.objectStore('kv').get(key);
        req.onsuccess = function() { resolve(req.result); db.close(); };
        req.onerror = function() { reject(req.error); db.close(); };
      });
    });
  }
  function idbSet(key, val) {
    return idbOpen().then(function(db) {
      return new Promise(function(resolve, reject) {
        var tx = db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(val, key);
        tx.oncomplete = function() { db.close(); resolve(); };
        tx.onerror = function() { reject(tx.error); db.close(); };
      });
    });
  }
  // Migrate existing localStorage data on first load
  (function() {
    try {
      var old = localStorage.getItem('colmena_offline_queue');
      if (old) {
        var parsed = JSON.parse(old);
        if (Array.isArray(parsed) && parsed.length) {
          idbSet('queue', parsed).then(function() {
            localStorage.removeItem('colmena_offline_queue');
          }).catch(function(e) { console.warn('IDB migrate failed:', e); });
        } else {
          localStorage.removeItem('colmena_offline_queue');
        }
      }
    } catch (e) { console.warn('IDB migrate error:', e); }
  })();
  function getQueue() { return idbGet('queue').then(function(d) { return Array.isArray(d) ? d : []; }); }
  function saveQueue(q) { return idbSet('queue', q); }
  let _syncLock = false;
  function fotoUrlFromNotas(notas) {
    if (!notas || !notas.startsWith('📷 ') || notas.startsWith('📷 data:')) return null;
    var path = notas.replace('📷 ', '');
    if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:')) return path;
    return (localStorage.getItem('colmena_server') || '') + path;
  }
  function fullUrl(path) {
    if (!path || path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:') || path.startsWith('blob:')) return path;
    return (localStorage.getItem('colmena_server') || '') + path;
  }

  // ── Evitar bloqueo mixed-content: recargar imagenes remotas via fetch→blob ──
  var _blobImgCache = {};
  function cargarImgViaBlob(img) {
    var url = img && img.src;
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return;
    if (_blobImgCache[url]) { img.src = _blobImgCache[url]; return; }
    fetch(url, { cache: 'no-store' })
      .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(function(blob) {
        var objUrl = URL.createObjectURL(blob);
        _blobImgCache[url] = objUrl;
        if (img.isConnected) img.src = objUrl;
      })
      .catch(function() {});
  }
  document.addEventListener('error', function(e) {
    var t = e.target;
    if (t && t.tagName === 'IMG' && t.src && !t.src.startsWith('blob:') && !t.src.startsWith('data:')) {
      if (t.getAttribute('data-blob-tried')) return;
      t.setAttribute('data-blob-tried', '1');
      cargarImgViaBlob(t);
    }
  }, true);

  function distanciaKm(a, b) {
    var R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLng = (b.lng - a.lng) * Math.PI / 180;
    var s = Math.sin(dLat/2)*Math.sin(dLat/2) + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)*Math.sin(dLng/2);
    return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1-s));
  }

  async function geocodeAddress(calle, numero, colonia, seccionId) {
    const street = [calle, numero].filter(Boolean).join(' ');
    if (!street) {
      if (seccionId) return geocodeSeccion(seccionId);
      return null;
    }
    const params = new URLSearchParams({ format: 'json', limit: '1', street, state: 'Guanajuato' });
    if (colonia) params.set('city', colonia);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { signal: controller.signal });
      clearTimeout(timer);
      const data = await res.json();
      if (data?.length) {
        const coords = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
        if (seccionId && !(await coordsCercanasASeccion(coords, seccionId))) {
          console.warn('Geocode lejano de la seccion, usando centroid:', coords);
          const sec = await geocodeSeccion(seccionId);
          if (sec) return sec;
        }
        return coords;
      }
    } catch (e) { clearTimeout(timer); console.warn('geocodeAddress error:', e); }
    if (seccionId) return geocodeSeccion(seccionId);
    return null;
  }

  async function coordsCercanasASeccion(coords, seccionId) {
    try {
      const sec = await API.request('GET', '/api/secciones/' + seccionId + '/centroid');
      if (!sec?.lat || !sec?.lng) return true;
      return distanciaKm(coords, { lat: sec.lat, lng: sec.lng }) <= 15;
    } catch (e) { return true; }
  }

  async function geocodeSeccion(seccionId) {
    try { return await API.request('GET', '/api/secciones/' + seccionId + '/centroid'); }
    catch (e) { console.warn('geocodeSeccion error:', e); return null; }
  }
  async function agregarAOfflineQueue(item) {
    var q = await getQueue();
    q.push({ ...item, ts: Date.now() });
    await saveQueue(q);
    actualizarBadgeSync();
  }
  async function quitarDeOfflineQueue(idx) {
    var q = await getQueue();
    q.splice(idx, 1);
    await saveQueue(q);
    actualizarBadgeSync();
  }
  async function abrirModalPendientes() {
    const modal = document.getElementById('pendientes-modal');
    const lista = document.getElementById('pendientes-lista');
    const q = await getQueue();
    if (!q.length) { lista.innerHTML = '<p style="color:#999;text-align:center;padding:20px">Sin pendientes</p>'; modal.classList.remove('hidden'); return; }
    lista.innerHTML = q.map((item, i) => {
      var info = '', extra = '';
      if (item.type === 'crearCiudadano') {
        info = item.data.nombre || 'Ciudadano sin nombre';
        if (item.data.notas && (item.data.notas.startsWith('📷 data:') || item.data.notas.startsWith('\uD83D\uDCF7 data:'))) extra = ' 📷 pendiente';
      } else if (item.type === 'marcarVisita') { info = 'Visita en ruta #' + item.data.rutaId + ' parada ' + item.data.idx; if (item.data.body?.evidencia?.startsWith('data:')) extra = ' 📷 pendiente'; }
      else if (item.type === 'completarRuta') info = 'Completar ruta #' + item.data.rutaId;
      var fecha = item.ts ? new Date(item.ts).toLocaleString() : '';
      var err = item._error || '';
      return '<div style="padding:8px 10px;border-bottom:1px solid var(--border-color);font-size:12px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<span>' + info + extra + '</span>' +
        '<span style="color:#999;font-size:11px">' + fecha + '</span></div>' +
        (err ? '<div style="color:var(--pri-red);font-size:11px;margin-top:2px">⚠ ' + err + '</div>' : '') +
        '<div style="margin-top:4px"><button class="btn-small btn-secondary" style="font-size:10px;padding:2px 6px" onclick="(async()=>{await procesarOfflineQueueItem('+i+');})()">Reintentar</button> <button class="btn-small btn-danger" style="font-size:10px;padding:2px 6px" onclick="(async()=>{await quitarDeOfflineQueue('+i+');abrirModalPendientes();})()">Saltar</button></div></div>';
    }).join('');
    modal.classList.remove('hidden');
  }
  window.procesarOfflineQueueItem = async function(idx) {
    if (_syncLock) return;
    _syncLock = true;
    mostrarSyncStatus('Sincronizando datos...', true);
    try {
      var q = await getQueue();
      var item = q[idx];
      if (!item) return;
      if (item.type === 'crearCiudadano') {
        var d = item.data;
        if (!d.lat || !d.lng) {
          try {
            var coords = await geocodeAddress(d.calle, d.numero, d.colonia, d.seccion_id);
            if (coords) { d.lat = coords.lat; d.lng = coords.lng; }
          } catch (e) { console.warn('Geocode in queue failed:', e); }
        }
        if (d.notas && (d.notas.startsWith('📷 data:') || d.notas.startsWith('\uD83D\uDCF7 data:'))) {
          var base64 = d.notas.replace(/^📷 /, '').replace(/^\uD83D\uDCF7 /, '');
          var upRes = await API.uploadImage(base64);
          if (upRes?.url) {
            d.notas = '📷 ' + upRes.url;
            var q2 = await getQueue();
            if (q2[idx]) { q2[idx].data = d; await saveQueue(q2); }
          }
        }
        await API.crearCiudadano(d);
      } else if (item.type === 'marcarVisita') {
        var b = item.data.body;
        if (b.evidencia && b.evidencia.startsWith('data:')) {
          var up = await API.uploadImage(b.evidencia);
          if (up?.url) b.evidencia = up.url;
        }
        await API.request('PATCH', '/api/rutas/' + item.data.rutaId + '/parada/' + item.data.idx, b);
      } else if (item.type === 'completarRuta') {
        await API.request('PATCH', '/api/rutas/' + item.data.rutaId + '/estado', { estado: 'completada' });
      }
      q.splice(idx, 1);
      await saveQueue(q);
      actualizarBadgeSync();
      await abrirModalPendientes();
      API.limpiarCache();
      loadCiudadanos();
      if (typeof loadDashboard === 'function') loadDashboard({ preserveMapView: true });
    } catch (e) {
      var q2 = await getQueue();
      if (q2[idx]) { q2[idx]._error = e.message || 'Error'; await saveQueue(q2); }
      await abrirModalPendientes();
    } finally {
      _syncLock = false;
      mostrarSyncStatus('\u2713 Datos sincronizados', false);
    }
  };

  async function actualizarBadgeSync() {
    var q = await getQueue();
    var n = q.length;
    var badge = document.getElementById('sync-badge');
    if (badge) { badge.classList.toggle('hidden', n === 0); badge.textContent = n > 0 ? '\u23eb ' + n : '\u23eb'; }
    var count = document.getElementById('pendientes-count');
    if (count) count.textContent = n;
    var mobCount = document.getElementById('mob-pendientes-count');
    if (mobCount) mobCount.textContent = n;
  }

  let _syncStatusTimer = null;
  function mostrarSyncStatus(texto, persistir) {
    var el = document.getElementById('sync-status-pill');
    if (!el) return;
    var t = document.getElementById('sync-status-text');
    if (t) t.textContent = texto;
    el.classList.remove('hidden');
    clearTimeout(_syncStatusTimer);
    if (!persistir) _syncStatusTimer = setTimeout(function() { el.classList.add('hidden'); }, 2500);
  }
  function finalizarStatus() {
    mostrarSyncStatus(API.isStaleData() ? 'Mostrando datos guardados' : '\u2713 Al d\u00eda', false);
  }

  function comprimirBase64(b64, maxW, calidad) {
    return new Promise(function(resolve) {
      var img = new Image();
      var timeout = setTimeout(function() { resolve(b64); }, 5000);
      img.onload = function() {
        clearTimeout(timeout);
        var w = img.width, h = img.height;
        if (w > maxW) { h = h * maxW / w; w = maxW; }
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        var ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', calidad));
      };
      img.onerror = function() { clearTimeout(timeout); resolve(b64); };
      img.src = b64;
    });
  }
  async function procesarOfflineQueue() {
    if (_syncLock) return;
    _syncLock = true;
    mostrarSyncStatus('Sincronizando datos...', true);
    try {
      var q = await getQueue();
      if (!q.length) return;
      var badge = document.getElementById('sync-badge');
      if (badge) badge.textContent = '\u23f3';
      for (var i = q.length - 1; i >= 0; i--) {
        try {
          var item = q[i];
          if (item.type === 'crearCiudadano') {
            var d = item.data;
            try {
              if (!d.lat || !d.lng) {
                var coords = await geocodeAddress(d.calle, d.numero, d.colonia, d.seccion_id);
                if (coords) { d.lat = coords.lat; d.lng = coords.lng; }
              }
            } catch (e) { console.warn('Geocode in queue failed:', e); }
            if (d.notas && d.notas.startsWith('\uD83D\uDCF7 data:')) {
              var base64 = d.notas.replace('\uD83D\uDCF7 ', '');
              var upRes = await API.uploadImage(base64);
              if (upRes?.url) {
                d.notas = '\uD83D\uDCF7 ' + upRes.url;
                var q3 = await getQueue();
                if (q3[i]) { q3[i].data = d; await saveQueue(q3); }
              }
            }
            await API.crearCiudadano(d);
          } else if (item.type === 'marcarVisita') {
            var b = item.data.body;
            if (b.evidencia && b.evidencia.startsWith('data:')) {
              var up = await API.uploadImage(b.evidencia);
              if (up?.url) b.evidencia = up.url;
            }
            await API.request('PATCH', '/api/rutas/' + item.data.rutaId + '/parada/' + item.data.idx, b);
          } else if (item.type === 'completarRuta') {
            await API.request('PATCH', '/api/rutas/' + item.data.rutaId + '/estado', { estado: 'completada' });
          }
          await quitarDeOfflineQueue(i);
        } catch (e) {
          console.warn('Offline queue item ' + i + ' failed:', e);
          var q2 = await getQueue();
          if (q2[i]) { q2[i]._error = e.message || 'Error'; await saveQueue(q2); }
        }
      }
      await actualizarBadgeSync();
      if (badge) badge.textContent = '\u2713';
      q = await getQueue();
      setTimeout(function() { if (badge && !q.length) badge.classList.add('hidden'); }, 2000);
      API.limpiarCache();
      loadCiudadanos();
      if (typeof loadDashboard === 'function') loadDashboard({ preserveMapView: true });
    } finally {
      _syncLock = false;
      mostrarSyncStatus('\u2713 Datos sincronizados', false);
    }
  }

  // Aviso al admin cuando este dispositivo (brigadista) se reconecta con datos pendientes
  async function avisarReconexion() {
    try {
      const user = API.getUser();
      if (!user || user.rol === 'admin') return;
      const q = await getQueue();
      const n = q.length;
      API.request('POST', '/api/sync/reconexion', { pendientes: n }).catch(() => {});
    } catch (e) { console.warn('avisarReconexion:', e); }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    // Service Worker (web y APK): cachea datos de la última conexión para modo
    // offline y recibe notificaciones push. No intercepta /tiles/ ni /uploads/
    // (los tiles van por IndexedDB y el servidor local, sin lentitud).
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(e => console.warn(e));
      navigator.serviceWorker.addEventListener('message', function(e) {
        if (e.data?.type === 'sw-refresh') {
          API.limpiarCache();
          if (document.getElementById('view-dashboard')?.classList.contains('active')) loadDashboard({ preserveMapView: true });
          if (document.getElementById('view-ciudadanos')?.classList.contains('active')) loadCiudadanos();
          if (document.getElementById('view-eventos')?.classList.contains('active')) loadEventos();
          if (document.getElementById('view-rutas')?.classList.contains('active') && API.getUser()?.rol === 'enlace') loadRutasEnlace();
        }
      });
    }
    // Offline queue — process when back online, click badge, or periodically
    window.addEventListener('online', function() { procesarOfflineQueue().then(avisarReconexion); conectarSocket(); });
    document.getElementById('sync-badge')?.addEventListener('click', async function() { await procesarOfflineQueue(); await abrirModalPendientes(); });
    setInterval(function() {
      procesarOfflineQueue().then(avisarReconexion);
      if (typeof API.isStaleData === 'function' && API.isStaleData()) {
        if (typeof loadCiudadanos === 'function') loadCiudadanos();
        if (typeof loadDashboard === 'function') loadDashboard({ preserveMapView: true });
      }
    }, 30000);
    document.addEventListener('visibilitychange', function() {
      if (!document.hidden) {
        procesarOfflineQueue().then(avisarReconexion);
        conectarSocket();
        if (typeof API.isStaleData === 'function' && API.isStaleData()) {
          if (typeof loadCiudadanos === 'function') loadCiudadanos();
          if (typeof loadDashboard === 'function') loadDashboard({ preserveMapView: true });
        }
      }
    });
    await actualizarBadgeSync();
    const savedServer = localStorage.getItem('colmena_server');
    const isCapacitor = typeof window.Capacitor !== 'undefined' && !!window.Capacitor.isNativePlatform?.();
    if (savedServer || !isCapacitor) {
      document.getElementById('config-screen').classList.add('hidden');
      const bioEnabled = Biometric.isEnabled() && await Biometric.isAvailable();
      if (bioEnabled) {
        document.getElementById('config-status').textContent = 'Autenticando con huella...';
        document.getElementById('config-status').style.color = '#999';
        const verified = await Biometric.verify('Acceso a Colmena');
        if (verified) {
          const creds = await Biometric.getCredentials();
          if (creds?.password) API.setToken(creds.password);
          await restaurarSesion();
          if (API.getToken() && API.getUser()) {
            showDashboard();
            if (window.iniciarSesionActiva) window.iniciarSesionActiva();
          } else {
            document.getElementById('login-screen').classList.remove('hidden');
          }
        } else {
          API.logout();
          document.getElementById('login-screen').classList.remove('hidden');
        }
        document.getElementById('config-status').textContent = '';
      } else if (API.getToken()) {
        await restaurarSesion();
        showDashboard();
        if (window.iniciarSesionActiva) window.iniciarSesionActiva();
      } else {
        await tryBiometricLogin();
      }
    }
    if (savedServer) document.getElementById('server-url').value = savedServer;

    async function restaurarSesion() {
      if (!API.getUser()) {
        try {
          const res = await fetch(`${API.getBase()}/api/auth/me`, { headers: { 'Authorization': `Bearer ${API.getToken()}` } });
          if (res.ok) { const d = await res.json(); API.setUser(d); }
        } catch (e) { console.warn(e); }
      }
    }
    async function tryBiometricLogin() {
      if (API.getToken()) { await restaurarSesion(); showDashboard(); if (window.iniciarSesionActiva) window.iniciarSesionActiva(); return; }
      if (!Biometric.isEnabled() || !(await Biometric.isAvailable())) {
        document.getElementById('login-screen').classList.remove('hidden');
        return;
      }
      document.getElementById('config-status').textContent = 'Autenticando con huella...';
      document.getElementById('config-status').style.color = '#999';
      const verified = await Biometric.verify('Acceso a Colmena');
      if (!verified) {
        document.getElementById('login-screen').classList.remove('hidden');
        document.getElementById('config-status').textContent = '';
        return;
      }
      const creds = await Biometric.getCredentials();
      if (creds && creds.password) {
        API.setToken(creds.password);
        await restaurarSesion();
        document.getElementById('login-screen').classList.add('hidden');
        showDashboard();
        if (window.iniciarSesionActiva) window.iniciarSesionActiva();
        return;
      }
      document.getElementById('login-screen').classList.remove('hidden');
    }
    document.getElementById('config-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = document.getElementById('server-url').value.replace(/\/+$/, '');
      if (!url) { document.getElementById('config-status').textContent = 'Ingresa una URL válida'; return; }
      localStorage.setItem('colmena_server', url);
      document.getElementById('config-status').textContent = 'Conectando...';
      document.getElementById('config-status').style.color = cssColor('--color-secondary');
      location.reload();
    });
    document.getElementById('btn-test-server').addEventListener('click', async () => {
      const url = document.getElementById('server-url').value.replace(/\/+$/, '');
      const status = document.getElementById('config-status');
      if (!url) { status.textContent = 'Ingresa una URL válida'; status.style.color = cssColor('--color-primary'); return; }
      status.textContent = 'Probando...'; status.style.color = '#999';
      const TMO = 8000;
      async function httpGet(u) {
        const req = new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', u, true);
          xhr.timeout = TMO;
          xhr.onload = () => resolve(xhr.status);
          xhr.onerror = () => reject(new Error('Red'));
          xhr.ontimeout = () => reject(new Error('Timeout'));
          xhr.send();
        });
        return await req;
      }
      try {
        const code = await httpGet(url + '/api/estados');
        if (code >= 200 && code < 300) { status.textContent = 'Conexion exitosa (HTTP ' + code + ')'; status.style.color = cssColor('--color-secondary'); }
        else { status.textContent = 'Error HTTP ' + code; status.style.color = cssColor('--color-primary'); }
      } catch (e) { status.textContent = 'Error: ' + (e.message || 'No se pudo conectar'); status.style.color = cssColor('--color-primary'); }
    });
    document.getElementById('btn-change-server').addEventListener('click', (e) => {
      e.preventDefault();
      localStorage.removeItem('colmena_server');
      location.reload();
    });
    document.getElementById('btn-forgot-password').addEventListener('click', (e) => {
      e.preventDefault();
      const email = prompt('Ingresa tu correo electronico para solicitar restablecimiento:');
      if (email && email.includes('@')) {
        API.request('POST', '/api/auth/solicitar-reseteo', { email }).then(r => notify(r.message, 'success')).catch(e => notify(e.message, 'error'));
      } else if (email) notify('Correo invalido', 'warning');
    });
    document.getElementById('btn-share-app').addEventListener('click', (e) => {
      e.preventDefault();
      mostrarQR();
    });
    function mostrarQR() {
      const url = API.getBase() + '/apk/Colmena.apk';
      document.getElementById('qr-url-input').value = url;
      document.getElementById('qr-url').textContent = url;
      document.getElementById('qr-container').innerHTML = '';
      new QRCode(document.getElementById('qr-container'), { text: url, width: 256, height: 256 });
      document.getElementById('pwa-url').textContent = API.getBase() + '/';
      cambiarPestanaCompartir('android');
      document.getElementById('qr-modal').classList.remove('hidden');
    }
    window.cambiarPestanaCompartir = function(p) {
      const esAndroid = p === 'android';
      document.getElementById('panel-share-android').style.display = esAndroid ? '' : 'none';
      document.getElementById('panel-share-ios').style.display = esAndroid ? 'none' : '';
      const btnA = document.getElementById('tab-share-android');
      const btnI = document.getElementById('tab-share-ios');
      btnA.className = 'btn-small ' + (esAndroid ? 'btn-primary' : 'btn-secondary');
      btnI.className = 'btn-small ' + (esAndroid ? 'btn-secondary' : 'btn-primary');
    }
    window.descargarApkDirecto = function() {
      const url = document.getElementById('qr-url-input').value.trim() || (API.getBase() + '/apk/Colmena.apk');
      const a = document.createElement('a');
      a.href = url;
      a.download = 'Colmena.apk';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      if (window.Capacitor?.isNativePlatform?.()) {
        window.open(url, '_system');
      }
    }
    window.generarQR = function() {
      const url = document.getElementById('qr-url-input').value.trim();
      if (!url) return;
      document.getElementById('qr-url').textContent = url;
      document.getElementById('qr-container').innerHTML = '';
      new QRCode(document.getElementById('qr-container'), { text: url, width: 256, height: 256 });
    }

    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('login-error');
      const email = document.getElementById('email').value;
      try {
        const data = await API.login(email, document.getElementById('password').value);
        errEl.textContent = '';
        if (await Biometric.isAvailable()) {
          await Biometric.saveCredentials(data.token, data.user.email || email);
        }
        showDashboard();
        if (window.iniciarSesionActiva) window.iniciarSesionActiva();
      } catch (err) { errEl.textContent = err.message; }
    });

    document.getElementById('menu-toggle').addEventListener('click', () => {
      document.getElementById('nav-links').classList.toggle('nav-open');
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.nav-dropdown')) {
        document.querySelectorAll('.nav-dropdown').forEach(d => d.classList.remove('nav-dropdown-open'));
      }
    });
    document.querySelectorAll('.dropdown-toggle').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const drop = e.target.closest('.nav-dropdown');
        const isOpen = drop.classList.contains('nav-dropdown-open');
        document.querySelectorAll('.nav-dropdown').forEach(d => d.classList.remove('nav-dropdown-open'));
        if (!isOpen) drop.classList.add('nav-dropdown-open');
      });
    });

    document.getElementById('logout-btn-mobile').addEventListener('click', () => doLogout());
    document.getElementById('mob-drop-menu-password').addEventListener('click', () => { closeNav(); document.getElementById('password-modal').classList.remove('hidden'); });
    document.getElementById('btn-logout-nav').addEventListener('click', () => doLogout());
    document.getElementById('nav-btn-share').addEventListener('click', () => {
      closeNav();
      mostrarQR();
    });
    function doLogout() {
      Biometric.deleteCredentials();
      API.logout();
      if (socket) { socket.disconnect(); socket = null; }
      document.getElementById('dashboard').classList.add('hidden');
      document.getElementById('nav-links').classList.remove('nav-open');
      document.getElementById('btn-logout-nav').style.display = 'none';
      document.getElementById('login-screen').classList.remove('hidden');
    }
    function closeNav() { document.getElementById('nav-links').classList.remove('nav-open'); }

    document.querySelectorAll('.nav-btn[data-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        closeNav();
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        const view = document.getElementById('view-' + btn.dataset.view);
        if (view) view.classList.add('active');
        loadView(btn.dataset.view);
      });
    });

    function getViewId(name) { const m = { 'mi-ruta': 'rutas' }; return 'view-' + (m[name] || name); }

    document.querySelectorAll('.dropdown-item').forEach(item => {
      item.addEventListener('click', () => {
        document.querySelectorAll('.nav-dropdown').forEach(d => d.classList.remove('nav-dropdown-open'));
        closeNav();
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        const view = document.getElementById(getViewId(item.dataset.view));
        if (view) view.classList.add('active');
        loadView(item.dataset.view);
      });
    });

    document.getElementById('dash-estado').addEventListener('change', async (e) => {
      const muniSel = document.getElementById('dash-municipio');
      muniSel.innerHTML = '<option value="">Todos los municipios</option>';
      if (e.target.value) {
        const municipios = await API.getMunicipios(e.target.value);
        muniSel.innerHTML = '<option value="">Todos los municipios</option>' + municipios.map(m => `<option value="${m.id}">${m.nombre}</option>`).join('');
        if (!muniSel.value) {
          const defMuni = await API.getMunicipioDefault();
          if (defMuni && municipios.some(m => m.id === defMuni.id)) muniSel.value = defMuni.id;
          else muniSel.value = municipios.find(m => m.id === 11035) ? 11035 : (municipios[0]?.id || '');
        }
      }
      loadDashboard();
    });
    document.getElementById('dash-municipio').addEventListener('change', loadDashboard);
    document.getElementById('geo-filtro-estado').addEventListener('change', async (e) => {
      const muniSel = document.getElementById('geo-filtro-municipio');
      const secSel = document.getElementById('geo-filtro-seccion');
      muniSel.innerHTML = '<option value="">Todos los municipios</option>';
      secSel.innerHTML = '<option value="">Todas las secciones</option>';
      if (e.target.value) {
        const municipios = await API.getMunicipios(e.target.value);
        muniSel.innerHTML = '<option value="">Todos los municipios</option>' + municipios.map(m => `<option value="${m.id}">${m.nombre}</option>`).join('');
        if (!muniSel.value) {
          const defMuni = await API.getMunicipioDefault();
          if (defMuni && municipios.some(m => m.id === defMuni.id)) muniSel.value = defMuni.id;
          else muniSel.value = municipios.find(m => m.id === 11035) ? 11035 : (municipios[0]?.id || '');
        }
      }
      loadGeocercas();
    });
    document.getElementById('geo-filtro-municipio').addEventListener('change', async (e) => {
      const secSel = document.getElementById('geo-filtro-seccion');
      secSel.innerHTML = '<option value="">Todas las secciones</option>';
      if (e.target.value) {
        const secs = await API.getSeccionesPorMunicipio(e.target.value);
        secSel.innerHTML = '<option value="">Todas las secciones</option>' + secs.map(s => `<option value="${s.id}">Sección ${s.id}</option>`).join('');
      }
      loadGeocercas();
    });
    document.getElementById('geo-filtro-seccion').addEventListener('change', () => {
      loadGeocercas();
    });
    document.querySelectorAll('.dash-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.dash-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const sel = document.getElementById('dash-partido');
        if (tab.dataset.filter === 'partido') sel.classList.remove('hidden');
        else sel.classList.add('hidden');
        loadDashboard();
      });
    });
    document.getElementById('dash-partido').addEventListener('change', loadDashboard);
    document.getElementById('dash-intencion-tipo').addEventListener('change', loadDashboard);
    document.getElementById('dash-toggle-sec').addEventListener('click', () => {
      const panel = document.getElementById('dash-sec-panel');
      panel.classList.toggle('hidden');
      if (!panel.classList.contains('hidden')) loadDashboard();
    });
    let _dashDebounce = null;
    function cargarDashboardDebounced() {
      if (_dashDebounce) clearTimeout(_dashDebounce);
      _dashDebounce = setTimeout(() => { _dashDebounce = null; loadDashboard(); }, 300);
    }
    document.getElementById('dash-sec-todas').addEventListener('change', function() {
      document.querySelectorAll('#dash-sec-list input[type=checkbox]').forEach(cb => cb.checked = this.checked);
      updateSecCount();
      cargarDashboardDebounced();
    });
    document.getElementById('geo-filtro-evento').addEventListener('change', loadGeocercas);
    document.querySelectorAll('.evt-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.evt-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const esCulm = tab.dataset.filter === 'culminados';
        document.getElementById('eventos-list').style.display = esCulm ? 'none' : '';
        document.getElementById('eventos-culminados-list').style.display = esCulm ? '' : 'none';
      });
    });
    document.querySelectorAll('.geo-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.geo-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const sel = document.getElementById('geo-filtro-partido');
        if (tab.dataset.filter === 'partido') sel.classList.remove('hidden');
        else sel.classList.add('hidden');
        loadGeocercas();
      });
    });
    document.getElementById('geo-filtro-partido').addEventListener('change', loadGeocercas);
    document.getElementById('geo-intencion-tipo').addEventListener('change', loadGeocercas);

    window.addEventListener('resize', () => {
      if (dashboardMap) setTimeout(() => dashboardMap.invalidateSize(), 100);
      if (typeof geocercasMap !== 'undefined' && geocercasMap) setTimeout(() => geocercasMap.invalidateSize(), 100);
    });

    document.getElementById('mun-filtro-estado').addEventListener('change', loadMunicipios);
    document.getElementById('sec-filtro-estado').addEventListener('change', async (e) => {
      const muniSel = document.getElementById('sec-filtro-municipio');
      muniSel.innerHTML = '<option value="">Todos los municipios</option>';
      if (e.target.value) {
        const municipios = await API.getMunicipios(e.target.value);
        muniSel.innerHTML = '<option value="">Todos los municipios</option>' + municipios.map(m => `<option value="${m.id}">${m.nombre}</option>`).join('');
      }
      loadSecciones();
    });
    document.getElementById('sec-filtro-municipio').addEventListener('change', loadSecciones);
    document.getElementById('ciu-filtro-seccion').addEventListener('change', loadCiudadanos);
    document.getElementById('cpr-filtro-seccion')?.addEventListener('change', loadComprometidos);
    document.getElementById('rep-filtro-seccion').addEventListener('change', () => { document.getElementById('rep-filtro-casilla').value = ''; loadReportes(); });
    document.getElementById('rep-filtro-casilla').addEventListener('change', loadReportes);
    document.getElementById('btn-csv-secciones')?.addEventListener('click', () => exportarSeguimientoCsv('secciones'));
    document.getElementById('btn-csv-casillas')?.addEventListener('click', () => exportarSeguimientoCsv('casillas'));
    document.getElementById('inc-filtro-seccion')?.addEventListener('change', loadIncidencias);
    document.getElementById('inc-filtro-estado')?.addEventListener('change', loadIncidencias);
    document.getElementById('btn-inc-nueva')?.addEventListener('click', abrirModalIncidencia);
    document.getElementById('cas-filtro-seccion').addEventListener('change', loadCasillas);
    document.getElementById('res-filtro-seccion').addEventListener('change', () => { document.getElementById('res-filtro-casilla').value = ''; loadResultados(); });
    document.getElementById('res-filtro-casilla').addEventListener('change', loadResultados);


    document.addEventListener('click', function(e) {
      if (e.target.classList.contains('gps-btn')) {
        _gpsUsed = true;
        navigator.geolocation.getCurrentPosition(
          p => { document.getElementById('f-lat').value = p.coords.latitude.toFixed(6); document.getElementById('f-lng').value = p.coords.longitude.toFixed(6); },
          () => alert('GPS no disponible'),
          { enableHighAccuracy: true }
        );
      }
    }, true);

    document.getElementById('dash-sec-list').addEventListener('change', function(e) {
      if (e.target.type === 'checkbox') {
        updateSecCount();
        cargarDashboardDebounced();
      }
    });

    window.updateSecCount = function() {
      const cbs = document.querySelectorAll('#dash-sec-list input[type=checkbox]');
      const checked = [...cbs].filter(cb => cb.checked).length;
      document.getElementById('dash-sec-count').textContent = checked + ' / ' + cbs.length + ' seleccionadas';
      document.getElementById('dash-sec-todas').checked = checked === cbs.length;
    };

    const userDropdown = document.getElementById('user-dropdown');
    const userMenu = document.getElementById('user-dropdown-menu');
    userDropdown.addEventListener('click', (e) => {
      e.stopPropagation();
      userDropdown.classList.toggle('open');
    });
    document.addEventListener('click', () => userDropdown.classList.remove('open'));
    userMenu.addEventListener('click', (e) => e.stopPropagation());

    document.getElementById('drop-menu-usuarios').addEventListener('click', () => {
      closeNav();
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById('view-usuarios').classList.add('active');
      loadView('usuarios');
    });
    document.getElementById('drop-menu-config').addEventListener('click', () => {
      closeNav();
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById('view-configuracion').classList.add('active');
      loadView('configuracion');
    });
    document.getElementById('drop-menu-filtros').addEventListener('click', () => {
      closeNav();
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
      document.getElementById('view-filtros').classList.add('active');
      loadView('filtros');
    });
    document.getElementById('drop-menu-password').addEventListener('click', () => {
      document.getElementById('password-modal').classList.remove('hidden');
    });
    document.getElementById('drop-menu-logout').addEventListener('click', () => doLogout());

    document.getElementById('drop-menu-notificaciones').addEventListener('click', toggleNotificaciones);
    document.getElementById('mob-drop-menu-notificaciones').addEventListener('click', () => { closeNav(); toggleNotificaciones(); });

    document.getElementById('drop-menu-pendientes')?.addEventListener('click', abrirModalPendientes);
    document.getElementById('mob-drop-menu-pendientes')?.addEventListener('click', () => { closeNav(); abrirModalPendientes(); });
    document.getElementById('btn-sync-now')?.addEventListener('click', async function() {
      await procesarOfflineQueue();
      await abrirModalPendientes();
    });

    document.getElementById('password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const actual = document.getElementById('pw-actual').value;
      const nueva = document.getElementById('pw-nueva').value;
      const confirmar = document.getElementById('pw-confirmar').value;
      const status = document.getElementById('pw-status');
      if (nueva !== confirmar) { status.textContent = 'Las contrasenas no coinciden'; status.style.color = 'var(--pri-red)'; return; }
      try {
        await API.request('PUT', '/api/auth/password', { password_actual: actual, password_nueva: nueva });
        status.textContent = 'Contrasena actualizada exitosamente';
        status.style.color = 'var(--pri-green)';
        setTimeout(() => { document.getElementById('password-modal').classList.add('hidden'); }, 1500);
      } catch (err) { status.textContent = 'Error: ' + err.message; status.style.color = 'var(--pri-red)'; }
    });
  });

  document.getElementById('modal-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    const submitBtn = document.getElementById('modal-submit');
    const tipo = submitBtn.dataset.tipo;
    const editId = submitBtn.dataset.editId;
    const msg = document.getElementById('modal-msg');
    try {
      if (tipo === 'usuario') {
        const rol = document.getElementById('f-rol').value;
        const muniId = parseInt(document.getElementById('f-municipio_id').value) || null;
        const cont = document.getElementById('f-secciones-container');
        const secciones = cont ? [...cont.querySelectorAll('input[type=checkbox]:checked')].map(cb => parseInt(cb.value)).filter(Boolean) : [];
        if (rol !== 'admin' && !muniId) { throw new Error('Debe seleccionar un municipio para este rol'); }
        if (rol === 'enlace' && !secciones.length) { throw new Error('Debe asignar al menos una seccion para Enlace de Campo'); }
        const data = { nombre: document.getElementById('f-nombre').value, email: document.getElementById('f-email').value, username: document.getElementById('f-username').value, telefono: document.getElementById('f-telefono').value, password: document.getElementById('f-password').value, rol, municipio_id: muniId, secciones };
        const errTel = validarTelefono(data.telefono);
        if (errTel) { msg.textContent = errTel; msg.style.color = 'var(--pri-red)'; return; }
        if (editId) await API.request('PUT', '/api/usuarios/' + editId, data);
        else await API.request('POST', '/api/usuarios', data);
      } else if (tipo === 'ciudadano') {
        const data = {
          seccion_id: parseInt(document.getElementById('f-seccion').value),
          numero_hogar: document.getElementById('f-hogar')?.value || '',
          nombre: document.getElementById('f-nombre').value,
          telefono: document.getElementById('f-telefono').value,
          edad: parseInt(document.getElementById('f-edad').value) || null,
          calle: document.getElementById('f-calle').value,
          numero: document.getElementById('f-numero').value,
          colonia: document.getElementById('f-colonia').value,
          cp: document.getElementById('f-cp').value,
          lat: parseFloat(document.getElementById('f-lat').value) || 20.6434,
          lng: parseFloat(document.getElementById('f-lng').value) || -100.9929,
          simpatizante: document.getElementById('f-simpatizante').checked,
          prioridad: parseInt(document.getElementById('f-prioridad').value),
          intencion_voto_presidente: parseInt(document.getElementById('f-intencion_voto_presidente').value) || null,
          intencion_voto_diputado: parseInt(document.getElementById('f-intencion_voto_diputado').value) || null,
          casilla_id: document.getElementById('f-casilla').value ? parseInt(document.getElementById('f-casilla').value) : null,
          votantes_casa: (parseInt(document.getElementById('f-votantes_casa').value) || 0) + 1,
          no_abrio: document.getElementById('f-no_abrio').checked
        };
        const vcDef = Array.isArray(window._vcList) ? window._vcList.filter(v => v.nombre || v.partido_id || v.partido_diputado_id) : [];
        if (vcDef.length) {
          data.votantes_casa_list = vcDef.map(v => ({ ...v, pendiente: !v.partido_id && !v.partido_diputado_id }));
        }
        const errTel = validarTelefono(data.telefono);
        if (errTel) { msg.textContent = errTel; msg.style.color = 'var(--pri-red)'; return; }
        const edadVal = document.getElementById('f-edad').value;
        if (edadVal && (data.edad === null || data.edad < 18 || data.edad > 130)) { msg.textContent = 'Edad invalida (18-130)'; msg.style.color = 'var(--pri-red)'; return; }
        let ciudadanoId = editId;
        if (editId) await API.actualizarCiudadano(editId, data);
        else { const creado = await API.crearCiudadano(data); ciudadanoId = creado?.id || ciudadanoId; }
        _gpsUsed = false;
      } else if (tipo === 'comprometido') {
        const curpVal = (document.getElementById('f-curp').value || '').trim().toUpperCase();
        if (curpVal && !/^[A-Z][AEIOUX][A-Z]{2}\d{6}[HM][A-Z]{5}[0-9A-Z]\d$/.test(curpVal)) { msg.textContent = 'CURP inválida: debe tener 18 caracteres con el formato oficial (ej. GODE561231HDFRRN09)'; msg.style.color = 'var(--pri-red)'; return; }
        const fechaNac = document.getElementById('f-fecha_nacimiento').value || null;
        let edadVal = parseInt(document.getElementById('f-edad').value) || null;
        if (fechaNac) {
          const anios = Math.floor((Date.now() - new Date(fechaNac).getTime()) / (365.25 * 24 * 3600 * 1000));
          if (anios < 0 || anios > 130) { msg.textContent = 'Fecha de nacimiento inválida'; msg.style.color = 'var(--pri-red)'; return; }
          if (!edadVal) edadVal = anios;
        }
        if (edadVal !== null && (edadVal < 18 || edadVal > 130)) { msg.textContent = 'Edad invalida (18-130)'; msg.style.color = 'var(--pri-red)'; return; }
        const errCurpSem = validarCurpSemanticaFront(curpVal, document.getElementById('f-nombre').value, fechaNac);
        if (errCurpSem) { msg.textContent = errCurpSem; msg.style.color = 'var(--pri-red)'; return; }
        const data = {
          seccion_id: parseInt(document.getElementById('f-seccion').value),
          numero_hogar: document.getElementById('f-hogar')?.value || '',
          nombre: document.getElementById('f-nombre').value,
          telefono: document.getElementById('f-telefono').value,
          edad: edadVal,
          fecha_nacimiento: fechaNac,
          calle: document.getElementById('f-calle').value,
          numero: document.getElementById('f-numero').value,
          colonia: document.getElementById('f-colonia').value,
          cp: document.getElementById('f-cp').value,
          correo: document.getElementById('f-correo').value,
          curp: curpVal,
          ine: document.getElementById('f-ine').value,
          nivel_compromiso: document.getElementById('f-nivel_compromiso').value || null,
          lat: parseFloat(document.getElementById('f-lat').value) || 20.6434,
          lng: parseFloat(document.getElementById('f-lng').value) || -100.9929,
          simpatizante: true,
          prioridad: parseInt(document.getElementById('f-prioridad').value),
          intencion_voto_presidente: parseInt(document.getElementById('f-intencion_voto_presidente').value) || null,
          intencion_voto_diputado: null,
          casilla_id: document.getElementById('f-casilla').value ? parseInt(document.getElementById('f-casilla').value) : null
        };
        const errTel = validarTelefono(data.telefono);
        if (errTel) { msg.textContent = errTel; msg.style.color = 'var(--pri-red)'; return; }
        if (editId) await API.actualizarComprometido(editId, data);
        else await API.crearComprometido(data);
        _gpsUsed = false;
      } else if (tipo === 'estado') {
        const data = { id: parseInt(document.getElementById('f-id').value), nombre: document.getElementById('f-nombre').value, abreviatura: document.getElementById('f-abreviatura').value, es_default: document.getElementById('f-es_default').checked };
        if (editId) await API.actualizarEstado(editId, data);
        else await API.crearEstado(data);
      } else if (tipo === 'municipio') {
        const data = { id: parseInt(document.getElementById('f-id').value), nombre: document.getElementById('f-nombre').value, estado_id: parseInt(document.getElementById('f-estado_id').value), lat: parseFloat(document.getElementById('f-lat').value) || null, lng: parseFloat(document.getElementById('f-lng').value) || null, es_default: document.getElementById('f-es_default').checked };
        if (editId) await API.actualizarMunicipio(editId, data);
        else await API.crearMunicipio(data);
      } else if (tipo === 'seccion') {
        const data = { id: parseInt(document.getElementById('f-id').value), municipio_id: parseInt(document.getElementById('f-municipio_id').value), tipo: document.getElementById('f-tipo').value };
        if (editId) await API.actualizarSeccion(editId, data);
        else await API.crearSeccion(data);
      } else if (tipo === 'evento') {
        const plantillaEl = document.getElementById('f-plantilla_id');
        const chkAlertas = [...document.querySelectorAll('.chk-alerta-programada:checked')].map(c => c.value);
        function toISOWithOffset(val) {
          if (!val) return '';
          const offset = -new Date().getTimezoneOffset();
          const sign = offset >= 0 ? '+' : '-';
          const h = Math.floor(Math.abs(offset) / 60);
          const m = Math.abs(offset) % 60;
          return val + ':00' + sign + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
        }
        const data = {
          nombre: document.getElementById('f-nombre').value,
          fecha_inicio: toISOWithOffset(document.getElementById('f-fecha_inicio').value),
          fecha_fin: toISOWithOffset(document.getElementById('f-fecha_fin').value),
          lat: parseFloat(document.getElementById('f-lat').value),
          lng: parseFloat(document.getElementById('f-lng').value),
          radio_geocerca: parseInt(document.getElementById('f-radio').value),
          seccion_id: parseInt(document.getElementById('f-seccion').value),
          plantilla_id: plantillaEl.value ? parseInt(plantillaEl.value) : null,
          alertar_config: chkAlertas.length ? JSON.stringify(chkAlertas) : '[]',
          alertar_solo_simpatizantes: document.getElementById('f-alertar-solo-simp').checked
        };
        if (!data.nombre) throw new Error('El nombre del evento es obligatorio');
        if (!data.fecha_inicio || !data.fecha_fin) throw new Error('Las fechas de inicio y fin son obligatorias');
        if (new Date(data.fecha_inicio) >= new Date(data.fecha_fin)) throw new Error('La fecha de fin debe ser posterior a la de inicio');
        if (isNaN(data.lat) || isNaN(data.lng)) throw new Error('Las coordenadas son obligatorias');
        if (isNaN(data.seccion_id)) throw new Error('Debe seleccionar una sección');
        if (data.radio_geocerca < 10) throw new Error('El radio debe ser al menos 10 metros');
        if (editId) await API.actualizarEvento(editId, data);
        else await API.crearEvento(data);
      } else if (tipo === 'partido') {
        const data = { nombre: document.getElementById('f-nombre').value, abreviatura: document.getElementById('f-abreviatura').value, color: document.getElementById('f-color').value, es_favorito: document.getElementById('f-es_favorito').checked };
        if (editId) await API.actualizarPartido(editId, data);
        else await API.crearPartido(data);
      } else if (tipo === 'casilla') {
        const data = { seccion_id: parseInt(document.getElementById('f-seccion_id').value), nombre: document.getElementById('f-nombre').value, direccion: document.getElementById('f-direccion').value, meta_votos: parseInt(document.getElementById('f-meta_votos').value) || 0, lat: document.getElementById('f-lat').value || null, lng: document.getElementById('f-lng').value || null };
        if (editId) await API.actualizarCasilla(editId, data);
        else await API.crearCasilla(data);
      } else if (tipo === 'resultado') {
        const data = { seccion_id: parseInt(document.getElementById('f-seccion_id').value), partido_id: parseInt(document.getElementById('f-partido_id').value), votos: parseInt(document.getElementById('f-votos').value) };
        await API.crearResultado(data);
      }
      msg.textContent = 'Guardado';
      const plural = tipo === 'evento' ? 'eventos' : tipo === 'casilla' ? 'casillas' : tipo === 'usuario' ? 'usuarios' : tipo.endsWith('o') ? tipo + 's' : tipo + 'es';
      setTimeout(() => { cerrarModal(); if (tipo === 'comprometido') loadComprometidos(); else loadView(plural); }, 500);
    } catch (err) { msg.textContent = 'Error: ' + err.message; }
  });

  // ---- Notificaciones Push ----
  let pushSubscriptionObj = null;

  window.toggleNotificaciones = async function() {
    if (pushSubscriptionObj) {
      // Unsubscribe
      try {
        await pushSubscriptionObj.unsubscribe();
      } catch (e) { console.warn(e); }
      await API.pushUnsubscribe(pushSubscriptionObj.endpoint).catch(e => console.warn(e));
      pushSubscriptionObj = null;
      document.getElementById('notif-status').textContent = 'Activar';
      document.getElementById('mob-drop-menu-notificaciones').textContent = 'Activar notificaciones';
      return;
    }
    // Subscribe
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array('BB5pVjSsiQS444Q2RW3hWbqJthQLpjjIgkMV9E522AR2Mjgjq2W_RxdhuBQte4Udt_8rEr3JxbHWGjuD4E8oX6w')
      });
      await API.pushSubscribe({ endpoint: sub.endpoint, keys: sub.toJSON().keys });
      pushSubscriptionObj = sub;
      document.getElementById('notif-status').textContent = 'Activadas';
      document.getElementById('mob-drop-menu-notificaciones').textContent = 'Desactivar notificaciones';
    } catch (err) {
      alert('No se pudieron activar las notificaciones. Revisa los permisos del navegador.');
    }
  };

  async function initPushNotifications() {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
    if (Notification.permission === 'denied') return;
    if (Notification.permission === 'default') {
      document.getElementById('notif-status').textContent = 'Permitir';
      return;
    }
    // Permission already granted, try to restore existing subscription
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        pushSubscriptionObj = sub;
        document.getElementById('notif-status').textContent = 'Activadas';
        document.getElementById('mob-drop-menu-notificaciones').textContent = 'Desactivar notificaciones';
      }
    } catch (e) { console.warn(e); }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
  }

  function showDashboard() {
    initPushNotifications();
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
    aplicarConfiguracionVisual();
    const user = API.getUser();
    if (user) {
      document.getElementById('user-name').textContent = user.nombre;
      const mobBtn = document.getElementById('user-btn-mobile');
      if (mobBtn) mobBtn.textContent = user.nombre + ' ▾';
    }
    document.querySelectorAll('.nav-btn').forEach(b => b.style.display = '');
    document.querySelectorAll('.nav-dropdown').forEach(b => b.style.display = '');
    document.querySelectorAll('.dropdown-item').forEach(b => b.style.display = '');
    document.querySelectorAll('.user-dropdown-item').forEach(b => b.style.display = '');
    document.getElementById('btn-logout-nav').style.display = '';
    const navDrops = document.querySelectorAll('.nav-dropdown');
    if (navDrops.length >= 2) {
      navDrops[0].style.display = ''; // Operacion visible a todos
    }
    if (user?.rol !== 'admin') {
      document.getElementById('drop-menu-usuarios').style.display = 'none';
      document.getElementById('drop-menu-config').style.display = 'none';
      document.getElementById('drop-menu-filtros').style.display = 'none';
      if (navDrops.length >= 2) navDrops[1].style.display = 'none'; // Catalogo solo admin
      const mobAdminBtns = document.querySelectorAll('.nav-dropdown-mobile .dropdown-item[data-view]');
      mobAdminBtns.forEach(b => b.style.display = 'none');
    }
    if (user?.rol === 'enlace') {
      // Enlace sees Dashboard, Mi Ruta, Ciudadanos, Reportes
      const operacionItems = document.querySelectorAll('.nav-dropdown:first-of-type .dropdown-item');
      operacionItems.forEach(item => {
        const v = item.dataset.view;
        if (v && v !== 'mi-ruta' && v !== 'ciudadanos' && v !== 'casilla' && v !== 'incidencias') item.style.display = 'none';
      });
      document.querySelectorAll('.nav-btn[data-view="reportes"]').forEach(b => b.style.display = 'none');
      document.querySelectorAll('.nav-dropdown').forEach(d => {
        const t = d.querySelector('.dropdown-toggle');
        if (t && (t.textContent || '').indexOf('Reportes') >= 0) d.style.display = 'none';
      });
    }
    if (typeof window.mostrarSubTabSeguros === 'function') window.mostrarSubTabSeguros(user?.rol === 'admin' || user?.rol === 'coordinador');
    loadView('dashboard');
    // Pre-populate geocercas dropdowns so they are ready when user navigates there
    initGeocercasDropdowns();
  }

  async function initGeocercasDropdowns() {
    try {
      const [estados, defMuni, municipios] = await Promise.all([
        API.getEstados(), API.getMunicipioDefault(), API.getMunicipios(11)
      ]);
      const estadoSel = document.getElementById('geo-filtro-estado');
      const muniSel = document.getElementById('geo-filtro-municipio');
      estadoSel.innerHTML = '<option value="">Todos los estados</option>' + estados.map(e => `<option value="${e.id}">${e.nombre}</option>`).join('');
      estadoSel.value = '11';
      muniSel.innerHTML = '<option value="">Todos los municipios</option>' + municipios.map(m => `<option value="${m.id}">${m.nombre}</option>`).join('');
      if (defMuni && municipios.some(m => m.id === defMuni.id)) muniSel.value = defMuni.id;
      const [eventos, secs] = await Promise.all([
        API.getEventos(), API.getSeccionesPorMunicipio(muniSel.value)
      ]);
      const evtSel = document.getElementById('geo-filtro-evento');
      evtSel.innerHTML = '<option value="">Todos los eventos</option>' + eventos.map(e => `<option value="${e.id}">${e.nombre}</option>`).join('');
      const secSel = document.getElementById('geo-filtro-seccion');
      secSel.innerHTML = '<option value="">Todas las secciones</option>' + secs.map(s => `<option value="${s.id}">Sección ${s.id}</option>`).join('');
    } catch (e) { console.warn(e); }
  }

  function loadView(view) {
    if (view !== 'reportes' && reportesTimer) { clearInterval(reportesTimer); reportesTimer = null; }
    const loaders = {
      dashboard: loadDashboard,
      usuarios: loadUsuarios,
      estados: loadEstados,
      municipios: loadMunicipios,
      secciones: loadSecciones,
      ciudadanos: loadCiudadanos,
      eventos: loadEventos,
      geocercas: loadGeocercas,
      rutas: loadRutas,
      'mi-ruta': loadMiRuta,
      reportes: iniciarReportes,
      'reportes-encuesta': loadReportesEncuesta,
      partidos: loadPartidos,
      resultados: loadResultados,
      casillas: loadCasillas,
      casilla: loadCasillaRep,
      incidencias: loadIncidencias,
      plantillas: loadPlantillas,
      campanas: loadCampanas,
      filtros: loadFiltrosCampana,
      configuracion: loadConfiguracion
    };
    if (loaders[view]) loaders[view]();
  }

  async function loadDashboard(opts) {
    const seq = ++_dashLoadSeq;
    try {
      mostrarSyncStatus('Actualizando...', true);
      const user = API.getUser();
      const [estados, todosMunicipios, ciudadanos, defEstado, defMunicipio, secciones, partidos] = await Promise.all([
        API.getEstados(), API.getMunicipios(), API.getCiudadanos(), API.getEstadoDefault(), API.getMunicipioDefault(), API.getSecciones(), API.getPartidos()
      ]);
      window._seccionesList = secciones;
      window.todosMunicipios = todosMunicipios;
      mostrarCheckboxEnlaces();      const seccionMuniMap = {}; secciones.forEach(s => seccionMuniMap[s.id] = s.municipio_id);
      const banner = document.getElementById('offline-banner');
      if (banner) banner.classList.toggle('hidden', !API.isStaleData());
      const estadoSel = document.getElementById('dash-estado');
      const muniSel = document.getElementById('dash-municipio');

      if (!estadoSel.value) {
        estadoSel.innerHTML = '<option value="">Todos</option>' + estados.map(e => `<option value="${e.id}">${e.nombre}</option>`).join('');
        estadoSel.value = String(defEstado?.id || 11);
        muniSel.innerHTML = '<option value="">Todos los municipios</option>';
        const municipios = todosMunicipios.filter(m => m.estado_id === parseInt(estadoSel.value));
        muniSel.innerHTML = '<option value="">Todos los municipios</option>' + municipios.map(m => `<option value="${m.id}">${m.nombre}</option>`).join('');
        if (!muniSel.value) {
          if (defMunicipio && municipios.some(m => m.id === defMunicipio.id)) muniSel.value = defMunicipio.id;
          else muniSel.value = municipios.find(m => m.id === 11035) ? 11035 : (municipios[0]?.id || '');
        }
      }
      if (user?.rol === 'coordinador' && user.municipio_id && muniSel.value && todosMunicipios.some(m => m.id === user.municipio_id)) {
        muniSel.value = String(user.municipio_id);
      }
      const filtroEstado = parseInt(estadoSel.value);
      const filtroMuni = parseInt(muniSel.value);

      // Populate seccion checkboxes
      const secList = document.getElementById('dash-sec-list');
      const seccionesMuni = filtroMuni ? secciones.filter(s => s.municipio_id === filtroMuni) : [];
      const secCheckIds = new Set();
      if (seccionesMuni.length && !secList.querySelector(`[data-sec="${seccionesMuni[0].id}"]`)) {
        const esAdmin = user?.rol !== 'enlace';
        secList.innerHTML = seccionesMuni.map(s => `<label style="font-size:12px;display:flex;align-items:center;gap:3px"><input type="checkbox" data-sec="${s.id}" checked>${s.id}</label>
          ${esAdmin ? `<button class="btn-small btn-secondary" style="font-size:10px;padding:1px 6px;margin-right:4px" onclick="abrirModalRuta(${s.id})" title="Generar ruta para sección ${s.id}">Ruta</button>` : ''}`).join('');
        document.getElementById('dash-sec-todas').checked = true;
        updateSecCount();
      }
      document.querySelectorAll('#dash-sec-list input[type=checkbox]').forEach(cb => { if (cb.checked) secCheckIds.add(parseInt(cb.dataset.sec)); });

      const partidoSel = document.getElementById('dash-partido');
      if (!partidoSel.value || partidoSel.options.length <= 1) {
        partidoSel.innerHTML = '<option value="">Partido...</option>' + partidos.map(p => `<option value="${p.nombre}">${p.abreviatura}</option>`).join('');
      }
      const activeTab = document.querySelector('.dash-tab.active')?.dataset?.filter || 'all';
      const partidoFiltro = partidoSel.value;
      const intencionTipo = document.getElementById('dash-intencion-tipo')?.value || 'intencion_voto_presidente';

      const geoFiltered = (filtroMuni ? ciudadanos.filter(c => seccionMuniMap[c.seccion_id] === filtroMuni) : ciudadanos)
        .filter(c => !secCheckIds.size || secCheckIds.has(c.seccion_id));
      let tabFiltered = geoFiltered;
      if (activeTab === 'simpatizantes') tabFiltered = geoFiltered.filter(c => c.simpatizante);
      else if (activeTab === 'nosimp') tabFiltered = geoFiltered.filter(c => !c.simpatizante);
      else if (activeTab === 'partido' && partidoFiltro) {
        tabFiltered = geoFiltered.filter(c => c.partido_presidente?.nombre === partidoFiltro || c.partido_diputado?.nombre === partidoFiltro);
      }
      window._exportData = tabFiltered;

      const munFiltrados = filtroEstado ? todosMunicipios.filter(m => m.estado_id === filtroEstado) : todosMunicipios;
      const secsUnicas = [...new Set(tabFiltered.map(c => c.seccion_id).filter(Boolean))];
      document.getElementById('stat-estados').textContent = estados.length;
      document.getElementById('stat-municipios').textContent = munFiltrados.length;
      document.getElementById('stat-secciones').textContent = secsUnicas.length;
      document.getElementById('stat-ciudadanos').textContent = tabFiltered.length;
      document.getElementById('stat-simpatizantes').textContent = geoFiltered.filter(c => c.simpatizante).length;
      let rutas = [];
      try {
        const [geocercas, rutasData] = await Promise.all([API.getGeocercas(), API.request('GET', '/api/rutas').catch(() => [])]);
        rutas = rutasData;
        document.getElementById('stat-eventos').textContent = geocercas.length;
        document.getElementById('stat-rutas-activas').textContent = rutas.filter(r => r.estado === 'en_progreso').length;
        // Count visits today
        const hoy = new Date(); hoy.setHours(0,0,0,0);
        const visitasHoy = rutas.filter(r => {
          if (!r.completado_en) return false;
          const d = new Date(r.completado_en);
          return d >= hoy;
        }).length;
        document.getElementById('stat-visitas-hoy').textContent = visitasHoy;
      } catch { document.getElementById('stat-eventos').textContent = '0'; }

      // ---- Mini gráficas en tarjetas (stat-micro) ----
      renderMicroCharts(tabFiltered, geoFiltered, rutas);
      iniciarAvanceEnVivo();

      // ---- Votantes en casa (para eventos / cambaceo / visita) ----
      (function() {
        const cont = document.getElementById('dash-votantes-casa');
        if (!cont) return;
        const parte = geoFiltered.filter(c => c.no_abrio).length;
        const totalCasa = geoFiltered.reduce((s, c) => s + (parseInt(c.votantes_casa) || 1), 0);
        const porPartido = {};
        geoFiltered.forEach(c => {
          const llave = c.partido_presidente?.abreviatura || 'Indeciso / Sin partido';
          porPartido[llave] = porPartido[llave] || 0;
          porPartido[llave] += 1;
          (Array.isArray(c.votantes_casa_list) ? c.votantes_casa_list : []).forEach(v => {
            const key = v.partido_id && partidos.find(p => p.id === v.partido_id) ? partidos.find(p => p.id === v.partido_id).abreviatura : 'Pendiente / No sabe';
            porPartido[key] = porPartido[key] || 0;
            porPartido[key] += 1;
          });
        });
        const filas = Object.entries(porPartido)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `<div style="display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px solid #f0f0f0"><span>${k}</span><strong>${n}</strong></div>`)
          .join('');
        cont.innerHTML = `
          <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:6px">
            <div><strong style="font-size:15px">${totalCasa}</strong> votantes en casa</div>
            <div><strong style="font-size:15px">${parte}</strong> hogares sin abrir (re-visitar)</div>
          </div>
          <div style="margin-bottom:4px;color:#666">Distribución (encuestado + acompañantes):</div>
          ${filas || '<span style="color:#999">Sin datos</span>'}`;
      })();

      // ---- Partido breakdown (donut + legend) ----
      const partidoDown = document.getElementById('dash-partido-breakdown');
      if (activeTab === 'partido' && !partidoFiltro) {
        const agrupados = {};
        geoFiltered.forEach(c => {
          [c.partido_presidente, c.partido_diputado].forEach(p => {
            if (p?.abreviatura) agrupados[p.abreviatura] = (agrupados[p.abreviatura] || 0) + 1;
          });
        });
        const keys = Object.keys(agrupados);
        if (keys.length) {
          const colores = {}; partidos.forEach(p => colores[p.abreviatura] = p.color);
          const total = keys.reduce((s, k) => s + agrupados[k], 0);
          const svg = document.getElementById('dash-donut-svg');
          const legend = document.getElementById('dash-donut-legend');
          const cx = 50, cy = 50, r = 40, PI = Math.PI;
          let ang = -PI / 2;
          let paths = '';
          legend.innerHTML = '';
          keys.forEach((n, i) => {
            const porc = agrupados[n] / total;
            const a1 = ang, a2 = ang + porc * 2 * PI;
            const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
            const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
            const large = porc > 0.5 ? 1 : 0;
            paths += `<path d="M${cx} ${cy} L${x1} ${y1} A${r} ${r} 0 ${large} 1 ${x2} ${y2} Z" fill="${colores[n] || '#999'}"/>`;
            ang = a2;
            legend.innerHTML += `<div style="display:flex;align-items:center;gap:4px;margin:2px 0"><span style="width:8px;height:8px;border-radius:50%;background:${colores[n]||'#999'};flex:none"></span><span style="flex:1">${n}</span><strong>${agrupados[n]}</strong></div>`;
          });
          svg.innerHTML = paths;
          partidoDown.style.display = '';
        } else partidoDown.style.display = 'none';
      } else partidoDown.style.display = 'none';

      // ---- Seccion bar chart ----
      const secChartContainer = document.getElementById('dash-sec-chart-container');
      if (filtroMuni || secCheckIds.size) {
        const secCounts = {};
        tabFiltered.forEach(c => { if (c.seccion_id) secCounts[c.seccion_id] = (secCounts[c.seccion_id] || 0) + 1; });
        const sorted = Object.entries(secCounts).sort((a, b) => b[1] - a[1]);
        const maxCount = sorted.length ? Math.max(...sorted.map(s => s[1])) : 1;
        const chart = document.getElementById('dash-sec-chart');
        chart.innerHTML = sorted.map(([sec, count]) =>
          `<div style="display:flex;align-items:center;gap:6px;margin:3px 0;font-size:11px">
            <span style="width:36px;flex:none;text-align:right;font-weight:600">${sec}</span>
            <div style="flex:1;height:14px;background:#eee;border-radius:4px;overflow:hidden;min-width:40px">
              <div style="height:100%;width:${(count / maxCount * 100)}%;background:var(--pri-green);border-radius:4px;transition:width 0.3s"></div>
            </div>
            <span style="width:24px;text-align:right;color:#666">${count}</span>
          </div>`
        ).join('');
        secChartContainer.style.display = '';
      } else {
        secChartContainer.style.display = 'none';
      }

      const muni = filtroMuni ? todosMunicipios.find(m => m.id === filtroMuni) : null;
      const center = (muni?.lat && muni?.lng) ? [muni.lat, muni.lng] : [20.6434, -100.9929];
      const zoom = (muni?.lat && muni?.lng) ? 13 : 8;
      const label = muni?.nombre || 'Guanajuato';

      // Fetch seccion polygons if municipio selected
      let geojsonData = null;
      if (filtroMuni) {
        try {
          const data = await API.getGeometrias(filtroMuni);
          geojsonData = (secCheckIds.size
            ? { type: data.type, features: data.features.filter(f => secCheckIds.has(Math.round(f.properties.seccion))) }
            : { type: data.type, features: [] });
        } catch (e) { console.warn(e); }
      }

      requestAnimationFrame(() => {
        if (seq !== _dashLoadSeq) return;
        if (!dashboardMap) {
          const el = document.getElementById('dashboard-map');
          if (!el) return;
          dashboardMap = L.map(el, { zoomControl: true, maxZoom: 19 }).setView(center, zoom);
          crearTileLayer({ attribution: '&copy; <a href="https://www.esri.com/">Esri</a>', maxNativeZoom: 19 }).addTo(dashboardMap);
          activarPrefetchMapa(dashboardMap);
        const cargaEl = L.DomUtil.create('div', 'map-loading-indicator', el);
        dashboardMap.on('loading', function() { cargaEl.style.display = 'block'; });
        dashboardMap.on('load', function() { cargaEl.style.display = 'none'; });
        } else {
          dashboardMap.eachLayer(l => {
            if (l instanceof L.CircleMarker || l instanceof L.Marker || l === dashboardGeoLayer || l === dashboardEnlacesLayer) dashboardMap.removeLayer(l);
          });
          if (dashboardEnlacesLayer) { dashboardEnlacesLayer = null; }
          if (!opts?.preserveMapView) dashboardMap.setView(center, zoom);
        }

        // Add seccion polygons
        if (dashboardGeoLayer) { dashboardMap.removeLayer(dashboardGeoLayer); dashboardGeoLayer = null; }
        if (geojsonData?.features?.length) {
          // Calculate dominant party per seccion
          const secPartyCounts = {};
          tabFiltered.forEach(c => {
            const p = intencionTipo === 'intencion_voto_presidente' ? c.partido_presidente : c.partido_diputado;
            if (p?.nombre) {
              if (!secPartyCounts[c.seccion_id]) secPartyCounts[c.seccion_id] = {};
              secPartyCounts[c.seccion_id][p.nombre] = (secPartyCounts[c.seccion_id][p.nombre] || 0) + 1;
            }
          });
          const secDominantColor = {};
          Object.keys(secPartyCounts).forEach(secId => {
            const counts = secPartyCounts[secId];
            const top = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
            const partido = partidos.find(p => p.nombre === top);
            secDominantColor[secId] = partido?.color || '#3388ff';
          });
          const coloresPartidosMap = {}; partidos.forEach(p => coloresPartidosMap[p.nombre] = p.color);

          dashboardGeoLayer = L.geoJSON(geojsonData, {
            style: feature => {
              const sec = Math.round(feature.properties.seccion);
              const hasData = secDominantColor[sec];
              const single = secCheckIds.size === 1;
              const fill = hasData || '#f5d0d0';
              const border = hasData || '#e8a0a0';
              return { fillColor: single ? '#ffe066' : fill, fillOpacity: single ? 0.25 : 0.12, color: single ? '#ffaa00' : border, weight: single ? 4 : 2, opacity: single ? 1 : 0.8 };
            },
            onEachFeature: (feature, layer) => {
              const sec = Math.round(feature.properties.seccion);
              const ciudadanosSec = tabFiltered.filter(c => c.seccion_id === sec);
              const simps = ciudadanosSec.filter(c => c.simpatizante).length;
              layer.bindTooltip(String(sec), { permanent: true, direction: 'center', className: 'sec-label', offset: [0, 0] });
              layer.bindPopup(`<b>Sección ${sec}</b><br>Ciudadanos: ${ciudadanosSec.length}<br>Simpatizantes: ${simps}`);
              layer.on('mouseover', function() {
                this.setStyle({ weight: 3, opacity: 1, fillOpacity: 0.25 });
              });
              layer.on('mouseout', function() {
                if (dashboardGeoLayer) dashboardGeoLayer.resetStyle(this);
              });
            }
          }).addTo(dashboardMap);
          // Zoom to single selected section polygon
          if (!opts?.preserveMapView && secCheckIds.size === 1 && dashboardGeoLayer) {
            const bounds = dashboardGeoLayer.getBounds();
            if (bounds.isValid()) dashboardMap.fitBounds(bounds, { padding: [30,30], maxZoom: 17 });
          }
        }
        setTimeout(() => { if (dashboardMap) dashboardMap.invalidateSize(); }, 200);
        setTimeout(() => { if (dashboardMap) dashboardMap.invalidateSize(); }, 800);
        setTimeout(() => { if (dashboardMap) dashboardMap.invalidateSize(); }, 2000);

        if (!dashboardClusterGroup) { dashboardClusterGroup = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 50 }); dashboardMap.addLayer(dashboardClusterGroup); }
        dashboardClusterGroup.clearLayers();
        L.circleMarker(center, { radius: 10, fillColor: C_PRIMARY, color: '#fff', weight: 3, fillOpacity: 0.8 }).addTo(dashboardMap).bindPopup('<b>' + label + '</b>');
        tabFiltered.forEach(c => {
          if (c.ubicacion?.lat && c.ubicacion?.lng) {
            const partidoColor = intencionTipo === 'intencion_voto_presidente' ? c.partido_presidente : c.partido_diputado;
            let color = partidoColor?.color || (c.simpatizante ? C_SECONDARY : '#000');
            dashboardClusterGroup.addLayer(L.circleMarker([c.ubicacion.lat, c.ubicacion.lng], {
              radius: 6, fillColor: color, color: '#fff', weight: 2, fillOpacity: 0.8
            }).bindPopup(`<b>${c.nombre}</b><br>Tel: ${c.telefono || '-'}<br>Dir: ${[c.calle, c.numero].filter(Boolean).join(' ')}${c.colonia ? ', '+c.colonia : ''}<br>${c.simpatizante ? 'Simpatizante' : 'No simpatizante'}<br>Pres: ${c.partido_presidente?.abreviatura || '-'}<br>Dip: ${c.partido_diputado?.abreviatura || '-'}${c.notas ? (function(){var u=fotoUrlFromNotas(c.notas);return u?'<br><img src="'+u+'" style="width:100%;max-width:120px;border-radius:4px;border:1px solid #ddd;margin-top:4px">':'';})() : ''}`));
          }
        });
        // Re-add enlaces if checkbox still checked
        if (document.getElementById('dash-ver-enlaces')?.checked) toggleUbicacionesEnlace();
      });
      finalizarStatus();
    } catch (err) { console.error(err); finalizarStatus(); }
  }

  // Show/hide enlace selector for admin/coordinador
  function mostrarCheckboxEnlaces() {
    const user = API.getUser();
    const container = document.getElementById('dash-enlaces-container');
    if (container) container.style.display = (user?.rol === 'admin' || user?.rol === 'coordinador') ? '' : 'none';
  }

  window.toggleUbicacionesEnlace = async function() {
    const checked = document.getElementById('dash-ver-enlaces').checked;
    if (dashboardEnlacesLayer) { dashboardMap?.removeLayer(dashboardEnlacesLayer); dashboardEnlacesLayer = null; }
    if (!checked || !dashboardMap) return;
    try {
      const ubicaciones = await API.getUbicaciones();
      dashboardEnlacesLayer = L.layerGroup().addTo(dashboardMap);
      ubicaciones.forEach(u => {
        const marker = L.marker([u.lat, u.lng], {
          icon: L.divIcon({
            className: 'enlace-divicon',
            html: `<div class="enlace-dot"></div><span class="enlace-nombre">${u.nombre}</span>`,
            iconAnchor: [8, 14]
          })
        }).bindPopup(`<b>${u.nombre}</b><br>Tel: ${u.telefono || '—'}<br>${u.precision != null ? 'Precisión: ' + Math.round(u.precision) + 'm' : ''}<br>${u.creado_en ? 'Última vez: '+new Date(u.creado_en).toLocaleString() : ''}`);
        marker.addTo(dashboardEnlacesLayer);
      });
      if (ubicaciones.length) {
        const group = L.featureGroup(dashboardEnlacesLayer.getLayers());
        dashboardMap.fitBounds(group.getBounds().pad(0.1));
      }
    } catch (e) { console.warn(e); }
  };

  async function loadUsuarios() {
    try {
      const usuarios = await API.request('GET', '/api/usuarios');
      document.getElementById('usuarios-body').innerHTML = usuarios.map(u => `
        <tr><td>${u.nombre}</td><td>${u.email}</td><td>${u.rol}</td><td>${u.municipio || '-'}</td>
        <td>${(u.secciones||[]).length} secciones</td>
        <td>
          <button class="btn-small btn-primary" onclick="abrirModal('usuario','${u.id}')">Editar</button>
          <button class="btn-small btn-secondary" onclick="resetearPass('${u.id}','${u.nombre}')" style="margin-left:2px">Reset</button>
          <button class="btn-small btn-danger" onclick="eliminarItem('usuario','${u.id}','${u.nombre}')">X</button>
        </td></tr>
      `).join('');
    } catch (err) { console.error(err); }
  }

  window.resetearPass = async function(id, nombre) {
    if (!confirm('Restablecer contrasena de ' + nombre + '? Se le notificara via push y WhatsApp.')) return;
    try {
      const r = await API.request('POST', '/api/usuarios/' + id + '/reset-password');
      notify('Contrasena restablecida: ' + r.password + '. El usuario recibio una notificacion.', 'success');
      loadUsuarios();
    } catch (e) { notify('Error: ' + e.message, 'error'); }
  }

  async function loadEstados() {
    try {
      const estados = await API.getEstados();
      document.getElementById('estados-body').innerHTML = estados.map(e => `
        <tr><td>${e.id}</td><td>${e.nombre}${e.es_default ? ' *' : ''}</td><td>${e.abreviatura || '-'}</td>
        <td><button class="btn-small btn-primary" onclick="abrirModal('estado','${e.id}')">Editar</button> <button class="btn-small btn-danger" onclick="eliminarItem('estado','${e.id}','${e.nombre}')">X</button></td></tr>
      `).join('');
    } catch (err) { console.error(err); }
  }

  async function loadMunicipios() {
    try {
      const [municipios, estados] = await Promise.all([API.getMunicipios(), API.getEstados()]);
      const filtro = document.getElementById('mun-filtro-estado');
      filtro.innerHTML = '<option value="">Todos</option>' + estados.map(e => `<option value="${e.id}">${e.nombre}</option>`).join('');
      if (!filtro.value) { filtro.value = '11'; }
      const filtrados = filtro.value ? municipios.filter(m => m.estado_id === parseInt(filtro.value)) : municipios;
      document.getElementById('municipios-body').innerHTML = filtrados.map(m => `
        <tr><td>${m.id}</td><td>${m.nombre}${m.es_default ? ' *' : ''}</td><td>${m.estado || '-'}</td><td>${m.lat || '-'}</td><td>${m.lng || '-'}</td>
        <td><button class="btn-small btn-primary" onclick="abrirModal('municipio','${m.id}')">Editar</button> <button class="btn-small btn-danger" onclick="eliminarItem('municipio','${m.id}','${m.nombre}')">X</button></td></tr>
      `).join('');
    } catch (err) { console.error(err); }
  }

  async function loadSecciones() {
    try {
      const [secciones, municipios, estados] = await Promise.all([API.getSecciones(), API.getMunicipios(), API.getEstados()]);
      const estFiltro = document.getElementById('sec-filtro-estado');
      estFiltro.innerHTML = '<option value="">Todos los estados</option>' + estados.map(e => `<option value="${e.id}">${e.nombre}</option>`).join('');
      if (!estFiltro.value) { estFiltro.value = '11'; }

      const muniFiltro = document.getElementById('sec-filtro-municipio');
      const muniFiltrados = estFiltro.value ? municipios.filter(m => m.estado_id === parseInt(estFiltro.value)) : municipios;
      if (!muniFiltro.value) { muniFiltro.innerHTML = '<option value="">Todos los municipios</option>' + muniFiltrados.map(m => `<option value="${m.id}">${m.nombre}</option>`).join(''); muniFiltro.value = '11035'; }
      function renderSecs() {
        const tab = document.querySelector('#view-secciones .dash-tab.active');
        const tipo = tab?.dataset?.tipo || '';
        const filtro = muniFiltro.value ? secciones.filter(s => s.municipio_id === parseInt(muniFiltro.value)) : secciones;
        const filtradas = tipo ? filtro.filter(s => s.tipo === tipo) : filtro;
        document.getElementById('secciones-body').innerHTML = filtradas.map(s => `
          <tr><td>${s.id}</td><td>${s.municipio || '-'}</td><td>${s.tipo || 'urbana'}</td>
          <td><button class="btn-small btn-primary" onclick="abrirModal('seccion','${s.id}')">Editar</button> <button class="btn-small btn-danger" onclick="eliminarItem('seccion','${s.id}','Sec. ${s.id}')">X</button></td></tr>
        `).join('');
      }
      document.querySelectorAll('#view-secciones .dash-tab').forEach(t => {
        t.onclick = function() {
          document.querySelectorAll('#view-secciones .dash-tab').forEach(x => x.classList.remove('active'));
          this.classList.add('active');
          renderSecs();
        };
      });
      estFiltro.onchange = function() {
        const fid = parseInt(estFiltro.value);
        muniFiltro.innerHTML = '<option value="">Todos los municipios</option>' + (fid ? municipios.filter(m => m.estado_id === fid) : municipios).map(m => `<option value="${m.id}">${m.nombre}</option>`).join('');
        renderSecs();
      };
      muniFiltro.onchange = renderSecs;
      renderSecs();
    } catch (err) { console.error(err); }
  }

  async function loadPartidos() {
    try {
      const partidos = await API.getPartidos();
      document.getElementById('partidos-body').innerHTML = partidos.map(p => `
        <tr><td>${p.id}</td><td>${p.nombre}</td><td><strong>${p.abreviatura}</strong></td>
        <td><span style="display:inline-block;width:24px;height:24px;border-radius:4px;background:${p.color};border:1px solid #ccc"></span></td>
        <td><button class="btn-small" onclick="setPartidoFavorito(${p.id})" title="Marcar como partido favorito (se preselecciona al capturar)" style="font-size:14px;cursor:pointer;background:none;border:none">${p.es_favorito ? '⭐' : '☆'}</button>
        <button class="btn-small btn-primary" onclick="abrirModal('partido','${p.id}')">Editar</button>
        <button class="btn-small btn-danger" onclick="eliminarItem('partido','${p.id}','${p.nombre}')">X</button></td></tr>
      `).join('');
    } catch (err) { console.error(err); }
  }

  window.setPartidoFavorito = async function(id) {
    try {
      const partido = (await API.getPartidos()).find(p => p.id === id);
      if (!partido) return;
      await API.actualizarPartido(id, { ...partido, es_favorito: true });
      await loadPartidos();
      if (typeof cargarPartidosSelects === 'function') cargarPartidosSelects();
      alert('Partido favorito actualizado');
    } catch (err) { console.error(err); alert('Error al marcar favorito'); }
  }

  async function loadCasillas() {
    try {
      const [casillas, secciones] = await Promise.all([API.getCasillas(), API.getSecciones()]);
      const filtro = document.getElementById('cas-filtro-seccion');
      if (!filtro.value) {
        filtro.innerHTML = '<option value="">Todas las secciones</option>' + secciones.map(s => `<option value="${s.id}">Sec. ${s.id} — ${s.municipio}</option>`).join('');
      }
      const secId = filtro.value ? parseInt(filtro.value) : null;
      const filtradas = secId ? casillas.filter(c => c.seccion_id === secId) : casillas;
      document.getElementById('casillas-body').innerHTML = filtradas.length ? filtradas.map(c => `
        <tr><td>${c.id}</td><td>Sec. ${c.seccion_id} — ${c.municipio||''}</td><td><strong>${c.nombre}</strong></td><td>${c.direccion||'-'}</td>
        <td>${c.meta_votos ?? 0}</td>
        <td>${c.lat != null ? c.lat.toFixed(4) + ', ' + c.lng.toFixed(4) : '-'}</td>
        <td><button class="btn-small btn-primary" onclick="abrirModal('casilla','${c.id}')">Editar</button> <button class="btn-small btn-danger" onclick="eliminarItem('casilla','${c.id}','${c.nombre}')">X</button></td></tr>
      `).join('') : '<tr><td colspan="7" style="text-align:center;color:#999">No hay casillas registradas</td></tr>';
    } catch (err) { console.error(err); }
  }

  async function loadResultados() {
    try {
      const [resultadosPres, resultadosDip, partidos, secciones, casillas] = await Promise.all([
        API.getResultados(null, null, 'presidente_municipal'), API.getResultados(null, null, 'diputado_local'),
        API.getPartidos(), API.getSecciones(), API.getCasillas()
      ]);
      const filtroSec = document.getElementById('res-filtro-seccion');
      const filtroCas = document.getElementById('res-filtro-casilla');
      if (!filtroSec.value) {
        filtroSec.innerHTML = '<option value="">Seleccionar sección</option>' + secciones.map(s => `<option value="${s.id}">Sec. ${s.id} — ${s.municipio}</option>`).join('');
        if (secciones.length) filtroSec.value = secciones[0].id;
      }
      const secId = parseInt(filtroSec.value);
      const casillasSec = secId ? casillas.filter(c => c.seccion_id === secId) : [];
      const oldCasVal = filtroCas.value;
      filtroCas.innerHTML = '<option value="">Todas las casillas</option>' + casillasSec.map(c => `<option value="${c.id}">${c.nombre}</option>`).join('');
      if (oldCasVal && casillasSec.some(c => c.id == oldCasVal)) filtroCas.value = oldCasVal;
      const casId = filtroCas.value ? parseInt(filtroCas.value) : null;
      const body = document.getElementById('res-body');
      if (!secId) { body.innerHTML = '<div class="res-empty">Selecciona sección</div>'; return; }

      const presFiltrados = casId ? resultadosPres.filter(r => r.casilla_id === casId) : resultadosPres.filter(r => r.seccion_id === secId);
      const dipFiltrados = casId ? resultadosDip.filter(r => r.casilla_id === casId) : resultadosDip.filter(r => r.seccion_id === secId);
      const presMap = {}; presFiltrados.forEach(r => { presMap[r.partido_id] = (presMap[r.partido_id] || 0) + r.votos; });
      const dipMap = {}; dipFiltrados.forEach(r => { dipMap[r.partido_id] = (dipMap[r.partido_id] || 0) + r.votos; });
      let totalPres = 0, totalDip = 0;
      const editable = !!casId;
      const rows = partidos.map(p => {
        const vPres = presMap[p.id] || '';
        const vDip = dipMap[p.id] || '';
        if (presMap[p.id]) totalPres += presMap[p.id];
        if (dipMap[p.id]) totalDip += dipMap[p.id];
        const label = editable
          ? `<div class="res-row">
              <span class="res-dot" style="background:${p.color||'#999'}"></span>
              <span class="res-abrev">${p.abreviatura}</span>
              <input type="number" class="res-input" id="votos-pres-${p.id}" value="${vPres}" min="0" placeholder="0" onfocus="this.select()" style="width:90px">
              <input type="number" class="res-input" id="votos-dip-${p.id}" value="${vDip}" min="0" placeholder="0" onfocus="this.select()" style="width:90px">
              <button class="res-btn" onclick="guardarVotosPartido(${casId},${p.id})">Guardar</button>

            </div>`
          : `<div class="res-row">
              <span class="res-dot" style="background:${p.color||'#999'}"></span>
              <span class="res-abrev">${p.abreviatura}</span>
              <span class="res-sum" style="width:90px">${vPres !== '' ? vPres : 0}</span>
              <span class="res-sum" style="width:90px">${vDip !== '' ? vDip : 0}</span>
            </div>`;
        return label;
      }).join('');
      const label = casId ? `Casilla: ${(casillasSec.find(c=>c.id===casId)||{}).nombre}` : '';
      body.innerHTML = `
        <div class="res-header" style="display:flex;gap:24px;justify-content:space-between;flex-wrap:wrap">
          <span><strong>Presidente:</strong> ${totalPres} votos</span>
          <span><strong>Diputado:</strong> ${totalDip} votos</span>
          <span style="color:#999;font-size:12px;font-weight:400">${label}</span>
        </div>
        <div class="res-th">
          <span style="width:10px;flex-shrink:0"></span>
          <span style="width:60px;flex-shrink:0">Partido</span>
          <span style="width:90px;text-align:center">Presidente</span>
          <span style="width:90px;text-align:center">Diputado</span>
          ${editable ? '<span style="width:70px"></span>' : ''}
        </div>
        ${rows}
        <div class="res-footer" style="display:flex;gap:24px;justify-content:space-between;flex-wrap:wrap">
          <span><strong>Presidente:</strong> ${totalPres} votos</span>
          <span><strong>Diputado:</strong> ${totalDip} votos</span>
          <span style="color:#999;font-size:12px;font-weight:400">${label}</span>
        </div>`;
    } catch (err) { console.error(err); }
  }

  async function loadPlantillas() {
    try {
      const plantillas = await API.getPlantillas();
      document.getElementById('plantillas-body').innerHTML = plantillas.map(p => {
        const prev = p.cuerpo ? p.cuerpo.substring(0, 80) + (p.cuerpo.length > 80 ? '...' : '') : '';
        const mediaCount = Array.isArray(p.archivos) ? p.archivos.length : 0;
        return `<tr>
          <td><strong>${p.nombre}</strong></td>
          <td><span style="font-size:12px;color:#666">${p.tipo}</span></td>
          <td style="font-size:12px;color:#666;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${prev}${mediaCount ? ' <span style="color:#0066cc">['+mediaCount+' archivo(s)]</span>' : ''}</td>
          <td><button class="btn-small btn-primary" onclick="editarPlantilla('${p.id}','${p.nombre.replace(/'/g,"\\'")}','${p.tipo}','${p.cuerpo.replace(/'/g,"\\'").replace(/\n/g,"\\n")}')">Editar</button>
          <button class="btn-small btn-danger" onclick="eliminarPlantilla('${p.id}','${p.nombre.replace(/'/g,"\\'")}')">X</button></td>
        </tr>`;
      }).join('') || '<tr><td colspan="4" style="text-align:center;color:#999">No hay plantillas</td></tr>';
    } catch (err) { console.error(err); }
  }

  window.eliminarPlantilla = async function(id, nombre) {
    if (!confirm(`¿Eliminar plantilla "${nombre}"?`)) return;
    try {
      await API.eliminarPlantilla(id);
      loadPlantillas();
    } catch (err) { alert(err.message); }
  };

  window.nuevaPlantilla = function() {
    document.getElementById('plantilla-id').value = '';
    document.getElementById('plantilla-nombre').value = '';
    document.getElementById('plantilla-cuerpo').value = '';
    document.getElementById('plantilla-modal-title').textContent = 'Nueva plantilla';
    _plantillaArchivos = [];
    renderArchivos();
    document.getElementById('plantilla-modal').classList.remove('hidden');
  };

  window.guardarPlantilla = async function() {
    const id = document.getElementById('plantilla-id').value;
    const nombre = document.getElementById('plantilla-nombre').value.trim();
    const tipo = document.getElementById('plantilla-tipo').value;
    const cuerpo = document.getElementById('plantilla-cuerpo').value;
    if (!nombre) { alert('El nombre es obligatorio'); return; }
    const archivos = window._plantillaArchivos || [];
    try {
      if (id) {
        await API.actualizarPlantilla(id, { nombre, tipo, cuerpo, archivos });
      } else {
        await API.crearPlantilla({ nombre, tipo, cuerpo, archivos });
      }
      cerrarModal('plantilla');
      loadPlantillas();
    } catch (err) { alert(err.message); }
  };

  window.editarPlantilla = function(id, nombre, tipo, cuerpo) {
    document.getElementById('plantilla-id').value = id;
    document.getElementById('plantilla-nombre').value = nombre;
    document.getElementById('plantilla-tipo').value = tipo;
    document.getElementById('plantilla-cuerpo').value = cuerpo;
    document.getElementById('plantilla-modal-title').textContent = 'Editar plantilla';
    _plantillaArchivos = [];
    renderArchivos();
    document.getElementById('plantilla-modal').classList.remove('hidden');
  };

  window._plantillaArchivos = [];
  document.addEventListener('change', function(e) {
    if (e.target.id === 'plantilla-file-input') {
      const files = e.target.files;
      const maxSize = 2 * 1024 * 1024;
      const maxFiles = 5;
      for (const file of files) {
        if (_plantillaArchivos.length >= maxFiles) {
          alert(`Máximo ${maxFiles} archivos`);
          break;
        }
        if (file.size > maxSize) {
          alert(`"${file.name}" excede 2MB`);
          continue;
        }
        if (!file.type.startsWith('image/')) {
          alert(`"${file.name}" no es una imagen`);
          continue;
        }
        const reader = new FileReader();
        reader.onload = function(ev) {
          _plantillaArchivos.push({ nombre: file.name, mime: file.type, data: ev.target.result, size: file.size });
          renderArchivos();
        };
        reader.readAsDataURL(file);
      }
      e.target.value = '';
    }
  });
  function renderArchivos() {
    const list = document.getElementById('plantilla-archivos-list');
    if (!list) return;
    list.innerHTML = (_plantillaArchivos || []).map((f, i) =>
      `<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;background:#f5f5f5;border-radius:8px;font-size:12px">
        ${f.mime?.startsWith('image/') ? `<img src="${f.data}" style="width:48px;height:48px;object-fit:cover;border-radius:6px">` : ''}
        <span style="display:flex;flex-direction:column">
          <span style="font-weight:500;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.nombre}</span>
          <span style="color:#999;font-size:10px">${(f.size / 1024).toFixed(0)} KB</span>
        </span>
        <button onclick="_plantillaArchivos.splice(${i},1);renderArchivos()" style="background:none;border:none;cursor:pointer;font-size:16px;color:#999;padding:0 2px;line-height:1">&times;</button>
      </span>`
    ).join('');
  }


  window.guardarVotosPartido = async function(casillaId, partidoId) {
    const fb = document.getElementById(`fb-${partidoId}`);
    const btn = document.querySelector(`.res-btn[onclick*="guardarVotosPartido(${casillaId},${partidoId})"]`);
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    try {
      for (const t of [{ tipo: 'presidente_municipal', pre: 'pres' }, { tipo: 'diputado_local', pre: 'dip' }]) {
        const input = document.getElementById(`votos-${t.pre}-${partidoId}`);
        if (!input) continue;
        const votos = parseInt(input.value);
        if (isNaN(votos) || votos < 0) continue;
        await API.crearResultado({ casilla_id: casillaId, partido_id: partidoId, votos, tipo: t.tipo });
      }
      if (fb) { fb.textContent = 'OK'; fb.style.color = cssColor('--color-secondary'); }
      setTimeout(() => loadResultados(), 500);
    } catch (err) {
      if (fb) { fb.textContent = 'Error'; fb.style.color = cssColor('--color-primary'); }
      if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; }
    }
  };

  // ---- Campañas ----
  let _campanaTabActiva = 'whatsapp';
  window.cambiarTabCampanas = function(tipo) {
    _campanaTabActiva = tipo;
    document.querySelectorAll('.campana-tab-btn').forEach(b => {
      const activo = b.dataset.tipo === tipo;
      b.classList.toggle('active', activo);
      b.style.background = activo ? '#fff' : 'transparent';
    });
    loadCampanas();
  };

  window.cambiarTipoCampanaModal = function(tipo) {
    document.getElementById('campana-tipo').value = tipo;
    document.getElementById('campana-fields-whatsapp').style.display = tipo === 'whatsapp' ? '' : 'none';
    document.getElementById('campana-fields-encuesta').style.display = tipo === 'encuesta' ? '' : 'none';
    if (tipo === 'encuesta') actualizarEstadoEncuestaModal();
  };

  window.abrirEncuestaEditor = function() {
    const id = document.getElementById('campana-id').value;
    if (!id) { alert('Guarda primero la campaña de encuesta'); return; }
    abrirEncuesta(id, document.getElementById('campana-nombre').value || 'Encuesta');
  };

  window.verEnlaceDemoPropia = async function() {
    const id = document.getElementById('campana-id').value;
    if (!id) { alert('Guarda primero la campaña de encuesta'); return; }
    try {
      const data = await API.request('POST', `/api/campanas/${id}/enlace-demo`);
      window.open(data.url, '_blank');
    } catch (e) { notify('Error: ' + e.message, 'error'); }
  };

  window.verEnlaceDemoAdjunta = async function() {
    const id = document.getElementById('campana-encuesta-adjunta').value;
    if (!id) { alert('Selecciona una encuesta adjunta'); return; }
    try {
      const data = await API.request('POST', `/api/campanas/${id}/enlace-demo`);
      window.open(data.url, '_blank');
    } catch (e) { notify('Error: ' + e.message, 'error'); }
  };

  async function actualizarEstadoEncuestaModal() {
    const id = document.getElementById('campana-id').value;
    const el = document.getElementById('campana-encuesta-status');
    if (!id) { el.textContent = 'Se guardará al crear la campaña'; return; }
    try {
      const campanas = await API.getCampanas();
      const c = campanas.find(x => x.id === id);
      const n = await API.request('GET', '/api/encuestas/preguntas?campana_id=' + id);
      el.textContent = c && c.encuesta_lanzada
        ? `🟢 Lanzada (${n.length} preguntas)`
        : `${n.length} pregunta(s) · ${c && c.encuesta_lanzada === false ? 'pausada' : 'no lanzada'}`;
    } catch (e) { el.textContent = ''; }
  }

  window.toggleEncuestaAdjunta = function(val) {
    document.getElementById('campana-enlace-encuesta').style.display = val ? 'block' : 'none';
  };

  async function cargarEncuestasAdjuntas() {
    const sel = document.getElementById('campana-encuesta-adjunta');
    try {
      const campanas = await API.getCampanas();
      const encuestas = (campanas || []).filter(c => c.tipo === 'encuesta' && c.id !== document.getElementById('campana-id').value);
      sel.innerHTML = '<option value="">Sin encuesta</option>' +
        encuestas.map(c => `<option value="${c.id}">${c.nombre}${c.encuesta_lanzada ? ' (lanzada)' : ''}</option>`).join('');
    } catch (e) { sel.innerHTML = '<option value="">Sin encuesta</option>'; }
  }

  async function loadCampanas() {
    try {
      const [campanas, plantillas, secciones, partidos, filtrosDef] = await Promise.all([
        API.getCampanas(), API.getPlantillas(), API.getSecciones(), API.getPartidos(), API.getFiltrosCampana()
      ]);
      window._campanasSecciones = secciones;
      window._campanasPartidos = partidos;
      window._campanaFiltrosDef = filtrosDef;
      const filtroDefMap = {};
      for (const fd of filtrosDef) filtroDefMap[fd.id] = fd;
      const tbody = document.getElementById('campanas-body');
      const filtradas = (campanas || []).filter(c => (c.tipo || 'whatsapp') === _campanaTabActiva);
      tbody.innerHTML = filtradas.map(c => {
        const statusLabel = c.status === 'sent' ? '<span style="color:var(--pri-green)">Enviada</span>'
          : c.status === 'cancelled' ? '<span style="color:#999">Cancelada</span>'
          : '<span style="color:var(--color-primary)">Pendiente</span>';
        const filtroResumen = (c.filtros || []).map(f => {
          const def = filtroDefMap[f.campo];
          if (def) {
            let val = f.valor;
            if (def.tipo_input === 'range') {
              const parts = f.valor.split('-');
              val = `${parts[0]}-${parts[1]}`;
            } else if (def.opciones) {
              const opt = (def.opciones || []).find(function(o) { return o.valor == f.valor; });
              if (opt) val = opt.etiqueta;
            }
            return `${def.nombre}: ${val}`;
          }
          return `${f.campo}: ${f.valor}`;
        }).join(', ') || 'Todos';
        const creado = c.creado_en ? new Date(c.creado_en).toLocaleDateString() : '-';
        let botones;
        if ((c.tipo || 'whatsapp') === 'encuesta') {
          botones = `
            <button class="btn-small btn-primary" onclick="editarCampana('${c.id}')">Editar</button>
            <button class="btn-small btn-secondary" onclick="abrirEncuesta('${c.id}','${(c.nombre||'').replace(/'/g,"\\'")}')">Preguntas</button>
            <button class="btn-small btn-secondary" onclick="verEnlaceDemoCampaña('${c.id}')" title="Ver encuesta en el navegador (no guarda)">Demo</button>
            ${c.encuesta_lanzada
              ? `<button class="btn-small btn-primary" style="background:var(--pri-green)" onclick="lanzarEncuestaCampana('${c.id}', false)">Lanzada ✓</button>`
              : `<button class="btn-small btn-secondary" onclick="lanzarEncuestaCampana('${c.id}', true)">Lanzar encuesta</button>`}
            <button class="btn-small btn-danger" onclick="eliminarCampana('${c.id}')">X</button>`;
        } else {
          botones = `
            <button class="btn-small btn-primary" onclick="editarCampana('${c.id}')">Editar</button>
            ${c.encuesta_id ? `<button class="btn-small btn-secondary" onclick="verEnlaceDemoCampaña('${c.encuesta_id}')" title="Encuesta adjunta">Demo adjunta</button>` : ''}
            <button class="btn-small btn-danger" onclick="eliminarCampana('${c.id}')">X</button>`;
        }
        return `<tr>
          <td><strong>${c.nombre}</strong>${c.encuesta_id ? '<div style="font-size:10px;color:var(--pri-green)">📎 con encuesta</div>' : ''}</td>
          <td>${c.plantilla_nombre || '-'}</td>
          <td style="font-size:12px;color:var(--text-muted)">${filtroResumen}</td>
          <td>${statusLabel}</td>
          <td>${c.total_ciudadanos || 0}</td>
          <td>${creado}</td>
          <td>${botones}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="7" style="text-align:center;color:#999">No hay campañas ' + (_campanaTabActiva === 'encuesta' ? 'de encuesta' : 'de WhatsApp') + '</td></tr>';
    } catch (err) { console.error(err); }
  }

  window.verEnlaceDemoCampaña = async function(id) {
    try {
      const data = await API.request('POST', `/api/campanas/${id}/enlace-demo`);
      window.open(data.url, '_blank');
    } catch (e) { notify('Error: ' + e.message, 'error'); }
  };

  async function loadFiltrosCampana() {
    try {
      const filtros = await API.getFiltrosCampana();
      const tbody = document.getElementById('filtros-body');
      tbody.innerHTML = filtros.map(f => `<tr>
        <td><strong>${f.nombre}</strong></td>
        <td style="font-size:12px;color:var(--text-muted)">${f.campo_bd}</td>
        <td>${f.tipo_input}</td>
        <td>${f.operador_sql}</td>
        <td style="font-size:11px;color:var(--text-muted)">${f.opciones ? (Array.isArray(f.opciones) ? f.opciones.map(function(o) { return o.valor||o; }).join(', ') : 'Sí') : '-'}</td>
        <td>${f.orden}</td>
        <td>
          <button class="btn-small btn-primary" onclick="editarFiltroCampana('${f.id}')">Editar</button>
          <button class="btn-small btn-danger" onclick="eliminarFiltroCampana('${f.id}')">X</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="7" style="text-align:center;color:#999">Sin filtros</td></tr>';
    } catch (err) { console.error(err); }
  }

  window.nuevoFiltroCampana = function() {
    document.getElementById('filtro-id').value = '';
    document.getElementById('filtro-nombre').value = '';
    document.getElementById('filtro-campo-bd').value = '';
    document.getElementById('filtro-tipo-input').value = 'text';
    document.getElementById('filtro-operador-sql').value = '=';
    document.getElementById('filtro-opciones').value = '';
    document.getElementById('filtro-orden').value = '0';
    document.getElementById('filtro-modal-title').textContent = 'Nuevo filtro';
    document.getElementById('filtro-modal').classList.remove('hidden');
  };

  window.guardarFiltroCampana = async function() {
    const id = document.getElementById('filtro-id').value;
    const nombre = document.getElementById('filtro-nombre').value.trim();
    const campo_bd = document.getElementById('filtro-campo-bd').value.trim();
    const tipo_input = document.getElementById('filtro-tipo-input').value;
    const operador_sql = document.getElementById('filtro-operador-sql').value;
    const opcionesRaw = document.getElementById('filtro-opciones').value.trim();
    const orden = parseInt(document.getElementById('filtro-orden').value) || 0;
    if (!nombre || !campo_bd) { alert('Nombre y Campo BD son obligatorios'); return; }
    let opciones = null;
    if (opcionesRaw && (tipo_input === 'select' || tipo_input === 'multiselect')) {
      opciones = opcionesRaw.split('\n').filter(l => l.trim()).map(l => {
        const parts = l.split('|');
        return { valor: parts[0].trim(), etiqueta: parts[1] ? parts[1].trim() : parts[0].trim() };
      });
    }
    try {
      if (id) await API.actualizarFiltroCampana(id, { nombre, campo_bd, tipo_input, operador_sql, opciones, orden });
      else await API.crearFiltroCampana({ nombre, campo_bd, tipo_input, operador_sql, opciones, orden });
      cerrarModal('filtro');
      loadFiltrosCampana();
    } catch (err) { alert(err.message); }
  };

  window.editarFiltroCampana = async function(id) {
    try {
      const filtros = await API.getFiltrosCampana();
      const f = filtros.find(x => x.id === id);
      if (!f) return;
      document.getElementById('filtro-id').value = f.id;
      document.getElementById('filtro-nombre').value = f.nombre;
      document.getElementById('filtro-campo-bd').value = f.campo_bd;
      document.getElementById('filtro-tipo-input').value = f.tipo_input;
      document.getElementById('filtro-operador-sql').value = f.operador_sql;
      document.getElementById('filtro-opciones').value = Array.isArray(f.opciones) ? f.opciones.map(function(o) { return o.valor + '|' + o.etiqueta; }).join('\n') : '';
      document.getElementById('filtro-orden').value = f.orden || 0;
      document.getElementById('filtro-modal-title').textContent = 'Editar filtro';
      document.getElementById('filtro-modal').classList.remove('hidden');
    } catch (err) { console.error(err); }
  };

  window.eliminarFiltroCampana = async function(id) {
    if (!confirm('¿Eliminar este filtro?')) return;
    try {
      await API.eliminarFiltroCampana(id);
      loadFiltrosCampana();
    } catch (err) { alert(err.message); }
  };

  window.eliminarCampana = async function(id) {
    if (!confirm('¿Eliminar esta campaña?')) return;
    try {
      await API.eliminarCampana(id);
      loadCampanas();
    } catch (err) { alert(err.message); }
  };

  window.nuevaCampana = async function() {
    document.getElementById('campana-id').value = '';
    document.getElementById('campana-nombre').value = '';
    document.getElementById('campana-plantilla').value = '';
    document.getElementById('campana-preview-msg').textContent = '';
    document.getElementById('campana-fecha').value = '';
    document.getElementById('campana-enviar').checked = true;
    document.getElementById('campana-modal-title').textContent = 'Nueva campaña';
    document.getElementById('campana-tipo').value = _campanaTabActiva;
    document.getElementById('campana-tipo-select').value = _campanaTabActiva;
    cambiarTipoCampanaModal(_campanaTabActiva);
    await cargarEncuestasAdjuntas();
    window._campanaFiltrosCarrito = [];
    window._campanaFiltrosDef = null;
    if (!window._campanasSecciones) {
      try {
        const [secciones, partidos] = await Promise.all([API.getSecciones(), API.getPartidos()]);
        window._campanasSecciones = secciones;
        window._campanasPartidos = partidos;
      } catch (e) { console.warn(e); }
    }
    await poblarSelectCampana();
    await poblarSelectFiltrosCampana();
    renderCarritoCampana();
    document.getElementById('campana-modal').classList.remove('hidden');
  };

  async function poblarSelectCampana() {
    const sel = document.getElementById('campana-plantilla');
    try {
      const plantillas = await API.getPlantillas();
      sel.innerHTML = '<option value="">Seleccionar plantilla...</option>' +
        plantillas.map(p => `<option value="${p.id}">${p.nombre}</option>`).join('');
    } catch (e) { console.warn(e); }
  }

  async function poblarSelectFiltrosCampana() {
    const sel = document.getElementById('campana-filtro-campo');
    try {
      const filtros = await API.getFiltrosCampana();
      window._campanaFiltrosDef = filtros;
      sel.innerHTML = '<option value="">Seleccionar filtro...</option>' +
        filtros.map(f => `<option value="${f.id}">${f.nombre}</option>`).join('');
      sel.onchange = function() { renderFiltroInput(this.value); };
    } catch (err) {
      console.error('Error cargando filtros campaña:', err);
      sel.innerHTML = '<option value="">Error al cargar filtros</option>';
    }
  }

  function renderFiltroInput(filtroId) {
    const container = document.getElementById('campana-filtro-valor');
    const def = (window._campanaFiltrosDef || []).find(f => f.id === filtroId);
    if (!def) { container.innerHTML = ''; return; }

    if (def.campo_bd === 'seccion_id') {
      const secciones = window._campanasSecciones || [];
      container.innerHTML = `<select style="flex:1">${secciones.map(function(s) { return '<option value="' + s.id + '">Sec. ' + s.id + ' - ' + s.municipio + '</option>'; }).join('')}</select>`;
    } else if (def.campo_bd === 'intencion_voto') {
      const partidos = window._campanasPartidos || [];
      container.innerHTML = `<select style="flex:1"><option value="indefinido">Indeciso / Sin definir</option>${partidos.map(function(p) { return '<option value="' + p.id + '">' + p.abreviatura + '</option>'; }).join('')}</select>`;
    } else if (def.tipo_input === 'select' || def.tipo_input === 'boolean') {
      const opts = def.tipo_input === 'boolean'
        ? [{ valor: 'si', etiqueta: 'Sí' }, { valor: 'no', etiqueta: 'No' }]
        : (def.opciones || []);
      container.innerHTML = `<select style="flex:1">${opts.map(function(o) { return '<option value="' + o.valor + '">' + o.etiqueta + '</option>'; }).join('')}</select>`;
    } else if (def.tipo_input === 'range') {
      container.innerHTML = '<input type="number" class="rango-min" placeholder="Desde" min="0" style="flex:1"><input type="number" class="rango-max" placeholder="Hasta" min="0" style="flex:1">';
    } else {
      container.innerHTML = `<input type="${def.tipo_input === 'number' ? 'number' : 'text'}" placeholder="Valor..." style="flex:1">`;
    }
  }

  window.actualizarValorFiltro = function(campoEl) {
    renderFiltroInput(campoEl?.value || document.getElementById('campana-filtro-campo').value);
  };

  window.agregarFiltroCarrito = function() {
    const filtroId = document.getElementById('campana-filtro-campo').value;
    if (!filtroId) { alert('Selecciona un filtro'); return; }
    const def = (window._campanaFiltrosDef || []).find(f => f.id === filtroId);
    if (!def) return;
    const container = document.getElementById('campana-filtro-valor');
    let valor = '';
    let etiquetaValor = '';
    if (def.tipo_input === 'range') {
      const min = container.querySelector('.rango-min')?.value;
      const max = container.querySelector('.rango-max')?.value;
      if (!min && !max) { alert('Completa el rango'); return; }
      valor = `${min || '0'}-${max || '999'}`;
      etiquetaValor = `${min || '0'} a ${max || '999'}`;
    } else {
      const input = container.querySelector('input, select');
      if (!input || !input.value) { alert('Selecciona un valor'); return; }
      valor = input.value;
      if (input.tagName === 'SELECT') {
        etiquetaValor = input.options[input.selectedIndex]?.text || valor;
      } else {
        etiquetaValor = valor;
      }
    }
    if (!window._campanaFiltrosCarrito) window._campanaFiltrosCarrito = [];
    window._campanaFiltrosCarrito.push({ campo: filtroId, valor, etiqueta: `${def.nombre}: ${etiquetaValor}` });
    renderCarritoCampana();
  };

  window.quitarFiltroCarrito = function(idx) {
    if (!window._campanaFiltrosCarrito) return;
    window._campanaFiltrosCarrito.splice(idx, 1);
    renderCarritoCampana();
  };

  function renderCarritoCampana() {
    const lista = document.getElementById('carrito-lista');
    const count = document.getElementById('carrito-count');
    const arr = window._campanaFiltrosCarrito || [];
    count.textContent = arr.length;
    if (!arr.length) {
      lista.innerHTML = '<div class="carrito-vacio">Sin filtros</div>';
      return;
    }
    lista.innerHTML = arr.map((f, i) =>
      `<div class="carrito-item">
        <span>${f.etiqueta}</span>
        <button class="btn-small btn-danger" onclick="quitarFiltroCarrito(${i})" style="flex:none;padding:2px 6px;font-size:11px">X</button>
      </div>`
    ).join('');
  }

  window.toggleCampanaFecha = function() {
    const grupo = document.getElementById('campana-fecha-group');
    const val = document.getElementById('campana-cuando').value;
    grupo.classList.toggle('hidden', val !== 'fecha');
  };

  window.previsualizarCampana = async function() {
    const filtros = recolectarFiltrosCampana();
    const msg = document.getElementById('campana-preview-msg');
    msg.textContent = 'Consultando...';
    try {
      const data = await API.previsualizarCampana(filtros);
      msg.textContent = `${data.total} ciudadanos alcanzados`;
      document.getElementById('campana-preview-count').textContent = `${data.total} ciudadanos alcanzados`;
      const body = document.getElementById('campana-preview-body');
      body.innerHTML = (data.ciudadanos || []).map(c => `<tr>
        <td>${c.nombre}</td>
        <td>${c.seccion_id}</td>
        <td>${c.telefono || '-'}</td>
        <td>${c.simpatizante ? 'Sí' : 'No'}</td>
      </tr>`).join('') || '<tr><td colspan="4" style="text-align:center;color:#999">Sin resultados</td></tr>';
      document.getElementById('campana-preview-modal').classList.remove('hidden');
    } catch (err) {
      msg.textContent = 'Error al previsualizar';
    }
  };

  function recolectarFiltrosCampana() {
    return (window._campanaFiltrosCarrito || []).map(f => ({ campo: f.campo, valor: f.valor }));
  }

  window.guardarCampana = async function() {
    const id = document.getElementById('campana-id').value;
    const nombre = document.getElementById('campana-nombre').value.trim();
    const tipo = document.getElementById('campana-tipo').value || 'whatsapp';
    const plantilla_id = document.getElementById('campana-plantilla').value;
    const encuesta_id = tipo === 'whatsapp' ? document.getElementById('campana-encuesta-adjunta').value || null : null;
    const filtros = tipo === 'whatsapp' ? recolectarFiltrosCampana() : [];
    const enviar = document.getElementById('campana-enviar').checked;
    const cuando = document.getElementById('campana-cuando').value;
    const scheduled_at = cuando === 'fecha' ? document.getElementById('campana-fecha').value : null;

    if (!nombre) { alert('El nombre es obligatorio'); return; }
    if (tipo === 'whatsapp' && !plantilla_id) { alert('Selecciona una plantilla'); return; }

    try {
      if (id) {
        await API.actualizarCampana(id, { nombre, plantilla_id, filtros, scheduled_at, status: enviar ? 'sent' : 'pending', tipo, encuesta_id });
      } else {
        await API.crearCampana({ nombre, plantilla_id, filtros, scheduled_at, tipo, encuesta_id });
        if (enviar) {
          const campanas = await API.getCampanas();
          const creada = campanas.find(c => c.nombre === nombre);
          if (creada) await API.actualizarCampana(creada.id, { ...creada, status: 'sent' });
        }
      }
      cerrarModal('campana');
      loadCampanas();
    } catch (err) { alert(err.message); }
  };

  window.editarCampana = async function(id) {
    try {
      const campanas = await API.getCampanas();
      const c = campanas.find(x => x.id === id);
      if (!c) return;
      document.getElementById('campana-id').value = c.id;
      document.getElementById('campana-nombre').value = c.nombre;
      document.getElementById('campana-modal-title').textContent = 'Editar campaña';
      const tipo = c.tipo || 'whatsapp';
      document.getElementById('campana-tipo').value = tipo;
      document.getElementById('campana-tipo-select').value = tipo;
      cambiarTipoCampanaModal(tipo);
      await cargarEncuestasAdjuntas();
      document.getElementById('campana-encuesta-adjunta').value = c.encuesta_id || '';
      await poblarSelectCampana();
      document.getElementById('campana-plantilla').value = c.plantilla_id || '';
      if (!window._campanasSecciones) {
        const [secciones, partidos] = await Promise.all([API.getSecciones(), API.getPartidos()]);
        window._campanasSecciones = secciones;
        window._campanasPartidos = partidos;
      }
      await poblarSelectFiltrosCampana();
      window._campanaFiltrosCarrito = [];
      const filtrosDef = window._campanaFiltrosDef || [];
      for (const f of (c.filtros || [])) {
        const def = filtrosDef.find(x => x.id === f.campo);
        if (def) {
          let etiquetaValor = f.valor;
          if (def.tipo_input === 'range') {
            const parts = f.valor.split('-');
            etiquetaValor = `${parts[0]} a ${parts[1]}`;
          } else if (def.opciones) {
            const opt = (def.opciones || []).find(function(o) { return o.valor == f.valor; });
          if (opt) etiquetaValor = opt.etiqueta;
          }
          window._campanaFiltrosCarrito.push({ campo: f.campo, valor: f.valor, etiqueta: `${def.nombre}: ${etiquetaValor}` });
        } else {
          window._campanaFiltrosCarrito.push({ campo: f.campo, valor: f.valor, etiqueta: `${f.campo}: ${f.valor}` });
        }
      }
      renderCarritoCampana();
      if (c.scheduled_at) {
        document.getElementById('campana-cuando').value = 'fecha';
        toggleCampanaFecha();
        document.getElementById('campana-fecha').value = new Date(c.scheduled_at).toISOString().slice(0, 16);
      }
      document.getElementById('campana-enviar').checked = c.status === 'sent';
      document.getElementById('campana-modal').classList.remove('hidden');
    } catch (err) { console.error(err); }
  };

  async function loadReportes() {
    reportesCargando = true;
    try {
      const pdfBtn = document.getElementById('btn-pdf-votantes');
      if (pdfBtn) pdfBtn.style.display = (API.getUser()?.rol === 'admin') ? '' : 'none';
      const [partidos, ciudadanos, secciones, resultados, resultadosDip, casillas, comprometidos] = await Promise.all([
        API.getPartidos(), API.getCiudadanos(), API.getSecciones(), API.getResultados(null, null, 'presidente_municipal'), API.getResultados(null, null, 'diputado_local'), API.getCasillas(), API.getComprometidos().catch(() => [])
      ]);
      const filtroSec = document.getElementById('rep-filtro-seccion');
      const filtroCas = document.getElementById('rep-filtro-casilla');
      if (!filtroSec.value) {
        filtroSec.innerHTML = '<option value="">Todas las secciones</option>' + secciones.map(s => `<option value="${s.id}">Sec. ${s.id} - ${s.municipio}</option>`).join('');
      }
      const secId = filtroSec.value ? parseInt(filtroSec.value) : null;

      const casillasSec = secId ? casillas.filter(c => c.seccion_id === secId) : [];
      const oldCasVal = filtroCas.value;
      filtroCas.innerHTML = '<option value="">Todas las casillas</option>' + casillasSec.map(c => `<option value="${c.id}">${c.nombre}</option>`).join('');
      if (oldCasVal && casillasSec.some(c => c.id == oldCasVal)) filtroCas.value = oldCasVal;

      const casId = filtroCas.value ? parseInt(filtroCas.value) : null;

      const ciudadanosFiltrados = secId ? ciudadanos.filter(c => c.seccion_id === secId) : ciudadanos;
      const resultadosFiltrados = secId
        ? (casId ? resultados.filter(r => r.casilla_id === casId) : resultados.filter(r => r.seccion_id === secId))
        : resultados;
      const resultadosDipFiltrados = secId
        ? (casId ? resultadosDip.filter(r => r.casilla_id === casId) : resultadosDip.filter(r => r.seccion_id === secId))
        : resultadosDip;

      const abrevMap = {}; partidos.forEach(p => { abrevMap[p.nombre] = p.abreviatura; });
      const colorMap = {}; partidos.forEach(p => { colorMap[p.nombre] = p.color; colorMap[p.abreviatura] = p.color; });

      // Presidente Municipal - intencion
      const intMapPres = {};
      ciudadanosFiltrados.forEach(c => {
        const key = c.partido_presidente?.nombre ? (abrevMap[c.partido_presidente.nombre] || c.partido_presidente.nombre) : null;
        if (key) intMapPres[key] = (intMapPres[key] || 0) + 1;
      });
      const indecisosPres = ciudadanosFiltrados.filter(c => !c.partido_presidente?.nombre).length;
      if (indecisosPres > 0) intMapPres['Indeciso'] = indecisosPres;

      // Diputado Local - intencion
      const intMapDip = {};
      ciudadanosFiltrados.forEach(c => {
        const key = c.partido_diputado?.nombre ? (abrevMap[c.partido_diputado.nombre] || c.partido_diputado.nombre) : null;
        if (key) intMapDip[key] = (intMapDip[key] || 0) + 1;
      });
      const indecisosDip = ciudadanosFiltrados.filter(c => !c.partido_diputado?.nombre).length;
      if (indecisosDip > 0) intMapDip['Indeciso'] = indecisosDip;

      // Seguros (comprometidos con voto seguro)
      const segurosFiltrados = secId
        ? (casId ? comprometidos.filter(c => c.casilla_id === casId) : comprometidos.filter(c => c.seccion_id === secId))
        : comprometidos;
      const segMapPres = {};
      const segMapDip = {};
      segurosFiltrados.forEach(c => {
        const keyP = c.partido_presidente ? (c.partido_presidente.abreviatura || c.partido_presidente.nombre) : null;
        if (keyP) segMapPres[keyP] = (segMapPres[keyP] || 0) + 1;
        const keyD = c.partido_diputado ? (c.partido_diputado.abreviatura || c.partido_diputado.nombre) : null;
        if (keyD) segMapDip[keyD] = (segMapDip[keyD] || 0) + 1;
      });

      // Resultados reales
      const resMapPres = {};
      const resMapDip = {};
      let resTotalPres = 0, resTotalDip = 0;
      resultadosFiltrados.forEach(r => {
        resMapPres[r.abreviatura] = (resMapPres[r.abreviatura] || 0) + r.votos;
        resTotalPres += r.votos;
      });
      resultadosDipFiltrados.forEach(r => {
        resMapDip[r.abreviatura] = (resMapDip[r.abreviatura] || 0) + r.votos;
        resTotalDip += r.votos;
      });

      if (window.intencionChart) window.intencionChart.destroy();
      if (window.intencionChart2) window.intencionChart2.destroy();

      function expandHex(c) {
        if (c.length === 4) return '#' + c[1]+c[1]+c[2]+c[2]+c[3]+c[3];
        return c;
      }
      function realColor(c) { return expandHex(c) + '80'; }
      const chartOpts = { responsive: true, maintainAspectRatio: true, aspectRatio: 2, resizeDelay: 200, plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 12, padding: 8, font: { size: 11 } } } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } };

      const presCombined = [...new Set([...Object.keys(intMapPres), ...Object.keys(resMapPres), ...Object.keys(segMapPres)])];
      const presIntData = presCombined.map(l => intMapPres[l] || 0);
      const presRealData = presCombined.map(l => resMapPres[l] || 0);
      const presColors = presCombined.map(l => colorMap[l] || '#999999');

      const ctxPres = document.getElementById('chart-presidente').getContext('2d');
      window.intencionChart = new Chart(ctxPres, {
        type: 'bar',
        data: {
          labels: presCombined,
          datasets: [
            { label: 'Esperado (Intención)', data: presIntData, backgroundColor: presColors },
            { label: 'Real (Votos)', data: presRealData, backgroundColor: presColors.map(realColor), borderColor: presColors, borderWidth: 2 },
            ...(Object.keys(segMapPres).length ? [{ label: 'Seguros (Comprometidos)', data: presCombined.map(l => segMapPres[l] || 0), backgroundColor: '#CC0000', borderColor: '#CC0000', borderWidth: 2, borderDash: [5, 5] }] : [])
          ]
        },
        options: chartOpts
      });

      const dipCombined = [...new Set([...Object.keys(intMapDip), ...Object.keys(resMapDip), ...Object.keys(segMapDip)])];
      const dipIntData = dipCombined.map(l => intMapDip[l] || 0);
      const dipRealData = dipCombined.map(l => resMapDip[l] || 0);
      const dipColors = dipCombined.map(l => colorMap[l] || '#999999');

      const ctxDip = document.getElementById('chart-diputado').getContext('2d');
      window.intencionChart2 = new Chart(ctxDip, {
        type: 'bar',
        data: {
          labels: dipCombined,
          datasets: [
            { label: 'Esperado (Intención)', data: dipIntData, backgroundColor: dipColors },
            { label: 'Real (Votos)', data: dipRealData, backgroundColor: dipColors.map(realColor), borderColor: dipColors, borderWidth: 2 },
            ...(Object.keys(segMapDip).length ? [{ label: 'Seguros (Comprometidos)', data: dipCombined.map(l => segMapDip[l] || 0), backgroundColor: '#CC0000', borderColor: '#CC0000', borderWidth: 2, borderDash: [5, 5] }] : [])
          ]
        },
        options: chartOpts
      });

      // Votación por hora (histórico)
      if (window.horariaChart) window.horariaChart.destroy();
      try {
        const qs = new URLSearchParams();
        if (casId) qs.set('casilla_id', casId); else if (secId) qs.set('seccion_id', secId);
        const horaria = await API.request('GET', '/api/reportes/votacion-horaria' + (qs.toString() ? '?' + qs.toString() : ''));
        if (horaria.length) {
          const hrs = horaria.map(h => String(h.hora).slice(5).replace(' ', ' '));
          const ctxHor = document.getElementById('chart-horaria').getContext('2d');
          window.horariaChart = new Chart(ctxHor, {
            type: 'bar',
            data: {
              labels: hrs,
              datasets: [
                { type: 'bar', label: 'Votos por hora', data: horaria.map(h => h.votos), backgroundColor: '#90a4ae', borderRadius: 3 },
                { type: 'line', label: 'Acumulado', data: horaria.map(h => h.acumulado), borderColor: '#CC0000', backgroundColor: '#CC0000', borderWidth: 2, pointRadius: 3, tension: 0.3 }
              ]
            },
            options: chartOpts
          });
        }
      } catch (e) { console.warn('Horaria no disponible:', e?.message || e); }

      let casillasHtml = '';
      const casillasMostrar = casId ? casillasSec.filter(c => c.id === casId) : (secId ? casillasSec : casillas);
      if (secId) {
        casillasHtml = casillasMostrar.map(c => {
          const casPres = resultadosFiltrados.filter(r => r.casilla_id === c.id);
          const casDip = resultadosDipFiltrados.filter(r => r.casilla_id === c.id);
          const totalCasPres = casPres.reduce((s, r) => s + r.votos, 0);
          const totalCasDip = casDip.reduce((s, r) => s + r.votos, 0);
          return `<div style="background:#f9f9f9;border-radius:8px;padding:10px 14px;font-size:13px;margin-bottom:6px">
            <strong style="color:var(--pri-red)">${c.nombre}</strong>
            <div style="margin-top:4px"><strong>Pres. Municipal:</strong> ${totalCasPres} votos</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">${casPres.map(r =>
              `<span style="font-size:11px;background:#eee;padding:2px 8px;border-radius:4px">${r.abreviatura}: ${r.votos}</span>`
            ).join('')}</div>
            <div style="margin-top:4px"><strong>Dip. Local:</strong> ${totalCasDip} votos</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">${casDip.map(r =>
              `<span style="font-size:11px;background:#eee;padding:2px 8px;border-radius:4px">${r.abreviatura}: ${r.votos}</span>`
            ).join('')}</div></div>`;
        }).join('');
      }
      let votacion = null, votacionHtml = '';
      try {
        votacion = await API.getReporteVotacion(secId || null);
        const pctColor = p => p == null ? '#999' : (p >= 100 ? '#1b8a3a' : (p >= 50 ? '#b58900' : '#c62828'));
        const rowBg = p => p == null ? '' : (p >= 100 ? 'background:#e8f5e9' : (p >= 50 ? 'background:#fff8e1' : 'background:#ffebee'));
        const secRows = (votacion.por_seccion || []).map(s => {
          const p = s.meta ? Math.round((s.votos / s.meta) * 100) : null;
          return `<tr style="${rowBg(p)}"><td>Sec. ${s.seccion_id}</td><td>${s.casillas}</td><td>${s.meta}</td><td>${s.votos}</td><td>${s.votos_favorito}</td>
          <td style="font-weight:600;color:${pctColor(p)}">${p == null ? 0 : p}%</td></tr>`;
        }).join('');
        const casRows = (votacion.por_casilla || []).map(c => {
          const p = c.meta_votos ? Math.round((c.votos / c.meta_votos) * 100) : null;
          return `<tr style="${rowBg(p)}"><td>Sec. ${c.seccion_id}</td><td><strong>${c.casilla}</strong></td><td>${c.meta_votos}</td><td>${c.votos}</td><td>${c.votos_favorito}</td>
          <td style="font-weight:600;color:${pctColor(p)}">${p == null ? 0 : p}%</td></tr>`;
        }).join('');
        const favoritoNombre = ((await API.getPartidos()).find(p => p.es_favorito) || {}).abreviatura || 'favorito';
        votacionHtml = `
          <table class="compact"><thead><tr><th>Sección</th><th>Casillas</th><th>Meta</th><th>Ya votaron</th><th>Votos ${favoritoNombre}</th><th>% avance</th></tr></thead>
          <tbody>${secRows || '<tr><td colspan="6" style="text-align:center;color:#999">Sin casillas registradas</td></tr>'}</tbody></table>
          <table class="compact" style="margin-top:8px"><thead><tr><th>Sección</th><th>Casilla</th><th>Meta</th><th>Ya votaron</th><th>Votos ${favoritoNombre}</th><th>% avance</th></tr></thead>
          <tbody>${casRows || '<tr><td colspan="6" style="text-align:center;color:#999">Sin casillas</td></tr>'}</tbody></table>`;
      } catch (e) { votacionHtml = '<p style="font-size:12px;color:#999">Métricas de votación no disponibles</p>'; }
      document.getElementById('rep-votacion').innerHTML = votacionHtml;

      // Barra del partido favorito vs meta (seccion / casilla / todas)
      const favPartido = partidos.find(p => p.es_favorito) || {};
      const favAbrev = favPartido.abreviatura || favPartido.nombre || 'favorito';
      const favColor = favPartido.color && favPartido.color[0] === '#' ? favPartido.color : '#' + (favPartido.color || '009639');
      let metaFav = 0, votosFav = 0, detalleFav = 'Todas las secciones (suma de metas)';
      if (votacion) {
        if (casId) {
          const ent = (votacion.por_casilla || []).find(c => c.casilla_id === casId);
          const casSel = casillasMostrar.find(c => c.id === casId);
          metaFav = ent?.meta_votos || 0;
          votosFav = ent?.votos_favorito || 0;
          detalleFav = `Casilla: ${casSel?.nombre || ''}`;
        } else {
          (votacion.por_seccion || []).forEach(s => { metaFav += s.meta || 0; votosFav += s.votos_favorito || 0; });
          if (secId) detalleFav = `Sección ${secId}`;
        }
      }
      const pctFav = metaFav > 0 ? Math.round((votosFav / metaFav) * 100) : 0;
      const barFav = document.getElementById('rep-meta-favorito');
      if (barFav) {
        barFav.innerHTML = `<div style="background:#fff;border:1px solid var(--border);border-radius:var(--radius);padding:10px 14px">
          <div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px">
            <strong style="font-size:13px">🎯 Partido favorito: ${favAbrev}</strong>
            <span style="font-size:12px;color:#555">${votosFav} de ${metaFav} votos <strong>(${pctFav}%)</strong></span>
          </div>
          <div style="height:16px;background:#eee;border-radius:8px;overflow:hidden">
            <div style="width:${Math.min(pctFav,100)}%;height:100%;background:${favColor};transition:width 0.6s"></div>
          </div>
          <div style="font-size:10px;color:#888;margin-top:4px">${detalleFav} · votos del partido preferido contra la meta ${metaFav > 0 ? '(100%)' : '(sin meta registrada)'}</div>
        </div>`;
      }

      const updTxt = document.getElementById('rep-ultima-actualizacion');
      if (updTxt) updTxt.textContent = '🔄 Actualizado ' + new Date().toLocaleTimeString();

      document.getElementById('rep-detalle').innerHTML = `
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px">
          <div class="stat-card"><div class="stat-value">${ciudadanosFiltrados.length}</div><div class="stat-label">Ciudadanos encuestados</div></div>
          <div class="stat-card"><div class="stat-value">${resTotalPres + resTotalDip}</div><div class="stat-label">Votos contabilizados</div></div>
          <div class="stat-card"><div class="stat-value">${casillasMostrar.length}</div><div class="stat-label">Casillas</div></div>
        </div>
        ${casillasHtml ? `<div style="display:flex;flex-direction:column;gap:8px">${casillasHtml}</div>` : ''}`;
    } catch (err) {
      console.error(err);
      var repDet = document.getElementById('rep-detalle');
      if (repDet) repDet.innerHTML = `<div style="color:var(--pri-red);font-size:13px;padding:12px;border:1px solid var(--pri-red);border-radius:8px">Error al cargar reportes: ${err?.message || err}</div>`;
    } finally {
      reportesCargando = false;
    }
  }

  function loadReportesEncuesta() {
    cargarSelectEncuestasReporte();
  }

  let reportesTimer = null;
  let reportesCargando = false;
  function iniciarReportes() {
    loadReportes();
    if (reportesTimer) clearInterval(reportesTimer);
    reportesTimer = setInterval(() => {
      if (!document.getElementById('view-reportes')?.classList.contains('active')) { clearInterval(reportesTimer); reportesTimer = null; return; }
      if (reportesCargando) return;
      loadReportes();
    }, 30000);
  }

  // ============ Pantalla Representante de Casilla (con modo offline) ============
  async function loadCasillaRep() {
    const secSel = document.getElementById('csa-filtro-seccion');
    const user = API.getUser();
    try {
      const [secciones, casillas] = await Promise.all([API.getSecciones(), API.getCasillas()]);
      let seccionesVisibles = secciones;
      if (user?.rol === 'enlace' || user?.rol === 'coordinador') {
        const me = await API.request('GET', '/api/auth/me').catch(() => null);
        if (me?.secciones?.length) seccionesVisibles = secciones.filter(s => me.secciones.includes(s.id));
        else if (user?.rol === 'coordinador' && me?.municipio_id) seccionesVisibles = secciones.filter(s => s.municipio_id === me.municipio_id);
      }
      secSel.innerHTML = '<option value="">Seleccionar sección</option>' + seccionesVisibles.map(s => `<option value="${s.id}">Sec. ${s.id} - ${s.municipio}</option>`).join('');
      window._casillasCache = casillas;
      const guardado = JSON.parse(localStorage.getItem('csa-seleccion') || 'null');
      if (guardado && seccionesVisibles.some(s => s.id == guardado.seccion)) {
        secSel.value = guardado.seccion;
        csaSeleccionarSeccion(true, guardado.casilla);
      }
      csaSyncOffline();
      window.addEventListener('online', csaSyncOffline);
    } catch (err) { console.error(err); }
  }

  window.csaSeleccionarSeccion = async function(restore, casillaId) {
    const secSel = document.getElementById('csa-filtro-seccion');
    const casSel = document.getElementById('csa-filtro-casilla');
    const secId = secSel.value;
    casSel.innerHTML = '<option value="">Seleccionar casilla</option>';
    if (!secId) { localStorage.removeItem('csa-seleccion'); return; }
    const casillas = (window._casillasCache || await API.getCasillas()).filter(c => c.seccion_id == secId);
    casSel.innerHTML = '<option value="">Seleccionar casilla</option>' + casillas.map(c => `<option value="${c.id}">${c.nombre}${c.meta_votos ? ' (meta ' + c.meta_votos + ')' : ''}</option>`).join('');
    if (casillaId && casillas.some(c => c.id == casillaId)) casSel.value = casillaId;
    localStorage.setItem('csa-seleccion', JSON.stringify({ seccion: secId, casilla: casSel.value }));
    csaCargarVotantes();
  };

  function csaLeerCola() {
    try { return JSON.parse(localStorage.getItem('csa-cola-votos') || '[]'); } catch { return []; }
  }
  function csaGuardarCola(cola) { localStorage.setItem('csa-cola-votos', JSON.stringify(cola)); }

  window.csaCargarVotantes = async function(force) {
    const casSel = document.getElementById('csa-filtro-casilla');
    const body = document.getElementById('csa-body');
    const resumen = document.getElementById('csa-resumen');
    const estado = document.getElementById('csa-estado');
    const casillaId = casSel.value;
    if (!casillaId) { body.innerHTML = '<p style="font-size:13px;color:#999;text-align:center">Selecciona una sección y casilla</p>'; resumen.innerHTML = ''; return; }
    localStorage.setItem('csa-seleccion', JSON.stringify({ seccion: document.getElementById('csa-filtro-seccion').value, casilla: casillaId }));
    body.innerHTML = '<p style="font-size:13px;color:#999;text-align:center">Cargando votantes...</p>';
    const cacheKey = 'csa-votantes-' + casillaId;
    let data = null;
    let online = true;
    try {
      data = await API.getVotantesCasilla(casillaId);
      localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data }));
      estado.textContent = 'En línea';
      estado.style.background = '#d4edda';
      estado.style.color = '#155724';
    } catch (e) {
      online = false;
      const cacheado = localStorage.getItem(cacheKey);
      if (cacheado) {
        data = JSON.parse(cacheado).data;
        estado.textContent = 'Sin conexión (datos guardados)';
        estado.style.background = '#fff3cd';
        estado.style.color = '#856404';
      } else {
        body.innerHTML = '<p style="font-size:13px;color:var(--pri-red);text-align:center">Sin conexión y sin datos guardados para esta casilla</p>';
        estado.textContent = 'Sin conexión';
        return;
      }
    }
    const cola = csaLeerCola();
    const votadosLocal = {};
    cola.forEach(op => { votadosLocal[op.tipo + ':' + op.id] = op.votado; });
    const votantes = data.votantes.map(v => {
      const k = v.tipo + ':' + v.id;
      if (k in votadosLocal) v.ya_voto = votadosLocal[k];
      return v;
    });
    const votados = votantes.filter(v => v.ya_voto).length;
    const fav = data.partido_favorito;
    const favCount = votantes.filter(v => v.ya_voto && v.partido_id === (fav ? fav.id : null)).length;
    const meta = data.casilla.meta_votos || 0;
    const ev = await obtenerEstadoVotacion();
    const bannerOff = ev && !ev.activa ? `<div style="padding:8px 14px;border-radius:8px;background:#fff3cd;font-size:12px;grid-column:1/-1">🔒 El registro de votos solo se activa el día de la elección${ev.fecha ? ` (${ev.fecha})` : ''}</div>` : '';
    resumen.innerHTML = `
      ${bannerOff}
      <div style="padding:8px 14px;border-radius:8px;background:#f0f4ff"><strong>${votantes.length}</strong> votantes esperados</div>
      <div style="padding:8px 14px;border-radius:8px;background:#e8f5e9"><strong>${votados}</strong> ya votaron${meta ? ` <span style="color:#666">/ meta ${meta}</span>` : ''}</div>
      <div style="padding:8px 14px;border-radius:8px;background:#fff3e0"><strong>${favCount}</strong> votos ${fav ? fav.abreviatura : ''}</div>
      ${cola.length ? `<div style="padding:8px 14px;border-radius:8px;background:#fff3cd;font-size:11px">${cola.length} cambio(s) pendiente(s) de sincronizar <button class="btn-small btn-secondary" onclick="csaSyncOffline()" style="font-size:10px">Sincronizar</button></div>` : ''}`;
    const votActiva = ev?.activa;
    body.innerHTML = votantes.length ? votantes.map(v => {
      const favTxt = (v.partido_id === (fav ? fav.id : null)) ? ' ⭐' : '';
      const extra = v.tipo === 'comprometido' && v.nivel_compromiso ? ` <span style="font-size:10px;color:#888">[${v.nivel_compromiso}]</span>` : '';
      const votoBtn = votActiva
        ? `<button class="btn-small" style="min-width:110px;${v.ya_voto ? 'background:var(--pri-green);color:#fff;border:none' : 'background:#eee'}" onclick="csaToggleVoto('${v.tipo}','${v.id}',${v.ya_voto})">${v.ya_voto ? '✓ Ya votó' : 'Aún no'}</button>`
        : `<button class="btn-small" style="min-width:110px;background:#f3f3f3;color:#bbb;border:none;cursor:not-allowed" disabled>${v.ya_voto ? '✓ Ya votó' : '🔒 Aún no'}</button>`;
      return `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;background:${v.ya_voto ? '#e8f5e9' : '#fff'}">
        ${votoBtn}
        <div style="flex:1"><strong>${v.nombre}</strong>${extra}<div style="font-size:11px;color:#666">${v.abreviatura ? 'Vota: ' + v.abreviatura + favTxt : 'Sin partido definido'}${v.telefono ? ' — ' + v.telefono : ''}</div></div>
      </div>`;
    }).join('') : '<p style="font-size:13px;color:#999;text-align:center">Sin votantes asignados a esta casilla</p>';
  };

  window.csaToggleVoto = async function(tipo, id, actualVotado) {
    const ev = await obtenerEstadoVotacion();
    if (!ev?.activa) {
      alert(ev?.fecha ? `La votación solo se registra el día de la elección (${ev.fecha})` : 'Configura el día de la elección para habilitar el registro de votos');
      return;
    }
    const nuevo = !actualVotado;
    const cola = csaLeerCola();
    const k = tipo + ':' + id;
    const idx = cola.findIndex(op => (op.tipo + ':' + op.id) === k);
    if (idx >= 0) cola.splice(idx, 1);
    cola.push({ tipo, id, votado: nuevo });
    csaGuardarCola(cola);
    csaCargarVotantes();
    try {
      if (nuevo) await API.marcarVoto(tipo === 'ciudadano' ? id : null, tipo === 'comprometido' ? id : null);
      else await API.quitarVoto(tipo, id);
      const sinPendiente = csaLeerCola().filter(op => !(op.tipo + ':' + op.id === k));
      csaGuardarCola(sinPendiente);
      csaCargarVotantes();
    } catch (e) {
      console.warn('Voto pendiente de sincronizar:', e);
    }
  };

  window.csaSyncOffline = async function() {
    if (!navigator.onLine) return;
    const cola = csaLeerCola();
    if (!cola.length) return;
    const pendientes = [];
    for (const op of cola) {
      try {
        if (op.votado) await API.marcarVoto(op.tipo === 'ciudadano' ? op.id : null, op.tipo === 'comprometido' ? op.id : null);
        else await API.quitarVoto(op.tipo, op.id);
      } catch (e) { pendientes.push(op); }
    }
    csaGuardarCola(pendientes);
    const secSel = document.getElementById('csa-filtro-seccion');
    if (secSel && secSel.value) csaCargarVotantes();
  };

  window.descargarPdfVotantes = async function() {
    const secId = document.getElementById('rep-filtro-seccion').value || null;
    const casId = document.getElementById('rep-filtro-casilla').value || null;
    if (!secId && !casId) { alert('Selecciona una sección o casilla para el PDF'); return; }
    try {
      const blob = await API.getPdfVotantes(secId, casId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'votantes-' + (casId ? 'casilla-' + casId : 'seccion-' + secId) + '.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) { alert('Error al generar PDF (solo admin): ' + (err?.message || err)); }
  };

  function descargarCsv(nombre, filas, columnas) {
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = '\ufeff' + [columnas.map(esc), ...filas.map(f => f.map(esc))].map(r => r.join(',')).join('\r\n');
    if (window.Capacitor?.isNativePlatform?.()) {
      navigator.clipboard?.writeText(csv).then(() => alert('CSV copiado al portapapeles: ' + nombre)).catch(() => alert('No se pudo copiar'));
      return;
    }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  window.exportarSeguimientoCsv = async function(tipo) {
    const secId = document.getElementById('rep-filtro-seccion').value || null;
    const filtroTexto = secId ? `-seccion-${secId}` : '';
    try {
      const v = await API.getReporteVotacion(secId);
      if (tipo === 'secciones') {
        const filas = (v.por_seccion || []).map(s => [s.seccion_id, s.casillas, s.meta, s.votos, s.votos_favorito, s.meta ? Math.round((s.votos / s.meta) * 100) : 0]);
        descargarCsv(`seguimiento-secciones${filtroTexto}.csv`, filas, ['Seccion', 'Casillas', 'Meta', 'Ya votaron', 'Votos favorito', '% avance']);
      } else {
        const filas = (v.por_casilla || []).map(c => [c.seccion_id, c.casilla, c.meta_votos, c.votos, c.votos_favorito, c.meta_votos ? Math.round((c.votos / c.meta_votos) * 100) : 0]);
        descargarCsv(`seguimiento-casillas${filtroTexto}.csv`, filas, ['Seccion', 'Casilla', 'Meta', 'Ya votaron', 'Votos favorito', '% avance']);
      }
    } catch (err) { alert('Error al exportar CSV: ' + (err?.message || err)); }
  };

  const INC_TIPOS = { material: 'Falta material', instalacion: 'No instaló / tardó', presencia: 'Presencia o provocaciones', larga_fila: 'Filas largas', seguridad: 'Problema de seguridad', otro: 'Otro' };
  const INC_ESTADOS = { abierta: { label: 'Abierta', color: '#c62828' }, en_proceso: { label: 'En proceso', color: '#b58900' }, resuelta: { label: 'Resuelta', color: '#1b8a3a' } };

  function incBadge(estado) {
    const e = INC_ESTADOS[estado] || INC_ESTADOS.abierta;
    return `<span style="font-size:11px;font-weight:600;color:#fff;background:${e.color};padding:2px 8px;border-radius:10px">${e.label}</span>`;
  }

  async function cargarCasillasInc() {
    const sel = document.getElementById('inc-casilla');
    const secSel = document.getElementById('inc-filtro-seccion').value;
    const casillas = await API.getCasillas();
    const grupos = {};
    casillas.forEach(c => { (grupos[c.seccion_id] = grupos[c.seccion_id] || []).push(c); });
    sel.innerHTML = Object.entries(grupos)
      .filter(([sid]) => !secSel || String(sid) === String(secSel))
      .map(([sid, cs]) => `<optgroup label="Sección ${sid}">${cs.map(c => `<option value="${c.id}">${c.nombre}</option>`).join('')}</optgroup>`)
      .join('');
  }

  window.abrirModalIncidencia = async function() {
    document.getElementById('inc-descripcion').value = '';
    document.getElementById('inc-tipo').value = 'material';
    await cargarCasillasInc();
    document.getElementById('inc-modal').classList.remove('hidden');
  };

  window.guardarIncidencia = async function() {
    const casillaId = document.getElementById('inc-casilla').value;
    const tipo = document.getElementById('inc-tipo').value;
    const descripcion = document.getElementById('inc-descripcion').value.trim();
    if (!casillaId) { alert('Selecciona una casilla'); return; }
    if (!descripcion) { alert('Describe la incidencia'); return; }
    try {
      await API.request('POST', '/api/incidencias', { casilla_id: casillaId, tipo, descripcion });
      document.getElementById('inc-modal').classList.add('hidden');
      alert('Incidencia registrada, ¡gracias!');
      loadIncidencias();
    } catch (err) { alert('Error: ' + (err?.message || err)); }
  };

  window.cambiarEstadoIncidencia = async function(id, estado) {
    try {
      await API.request('PATCH', '/api/incidencias/' + id, { estado });
      loadIncidencias();
    } catch (err) { alert('Error: ' + (err?.message || err)); }
  };

  async function loadIncidencias() {
    const cont = document.getElementById('inc-lista');
    cont.innerHTML = '<p style="text-align:center;color:#999;font-size:13px">Cargando...</p>';
    const secId = document.getElementById('inc-filtro-seccion').value || null;
    const estado = document.getElementById('inc-filtro-estado').value || null;
    const qs = new URLSearchParams();
    if (secId) qs.set('seccion_id', secId);
    if (estado) qs.set('estado', estado);
    try {
      const [incidencias, secciones] = await Promise.all([
        API.request('GET', '/api/incidencias' + (qs.toString() ? '?' + qs.toString() : '')),
        API.getSecciones()
      ]);
      const secSel = document.getElementById('inc-filtro-seccion');
      if (secSel.options.length <= 1) {
        secSel.innerHTML = '<option value="">Todas las secciones</option>' + secciones.map(s => `<option value="${s.id}">Sec. ${s.id} - ${s.municipio}</option>`).join('');
      }
      const puedeGestionar = ['admin', 'coordinador'].includes(API.getUser()?.rol);
      if (!incidencias.length) {
        cont.innerHTML = '<p style="text-align:center;color:#999;font-size:13px">No hay incidencias con esos filtros 🎉</p>';
        return;
      }
      cont.innerHTML = `<div class="table-container"><table class="compact">
        <thead><tr><th>Fecha</th><th>Sec.</th><th>Casilla</th><th>Tipo</th><th>Descripción</th><th>Reportó</th><th>Estado</th></tr></thead>
        <tbody>${incidencias.map(i => {
          const fecha = new Date(i.created_at).toLocaleString('es-MX', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
          const estadoSelect = `<select class="inc-estado" onchange="cambiarEstadoIncidencia(${i.id}, this.value)" style="font-size:11px;padding:3px;border-radius:6px;border:1px solid var(--border)">
            ${Object.entries(INC_ESTADOS).map(([k, e]) => `<option value="${k}" ${i.estado === k ? 'selected' : ''}>${e.label}</option>`).join('')}</select>`;
          return `<tr>
            <td style="white-space:nowrap">${fecha}</td>
            <td>${i.seccion_id}</td>
            <td><strong>${i.casilla_nombre}</strong></td>
            <td>${INC_TIPOS[i.tipo] || i.tipo}</td>
            <td style="max-width:300px">${i.descripcion}${i.respuesta ? `<div style="font-size:11px;color:#1b8a3a;margin-top:2px">↩ ${i.respuesta}</div>` : ''}</td>
            <td>${i.creado_por_nombre || '-'}</td>
            <td>${puedeGestionar ? estadoSelect : incBadge(i.estado)}</td>
          </tr>`;
        }).join('')}</tbody></table></div>`;
      document.getElementById('inc-version').textContent = `Total: ${incidencias.length}`;
    } catch (err) {
      cont.innerHTML = `<p style="text-align:center;color:#c62828;font-size:13px">Error: ${err?.message || err}</p>`;
    }
  }

  window.cargarReporteEncuesta = async function() {
    const campanaId = document.getElementById('rep-encuesta-campana').value;
    const cont = document.getElementById('rep-encuesta-detalle');
    if (!campanaId) { cont.innerHTML = ''; return; }
    cont.innerHTML = '<p style="font-size:13px;color:#999;text-align:center">Cargando reporte...</p>';
    try {
      const data = await API.request('GET', '/api/encuestas/reportes/' + campanaId);
      if (!data.preguntas || !data.preguntas.length) {
        cont.innerHTML = '<p style="font-size:13px;color:#999;text-align:center">Esta encuesta aún no tiene respuestas</p>';
        return;
      }
      cont.innerHTML = `
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          <div class="stat-card"><div class="stat-value">${data.total_respuestas || 0}</div><div class="stat-label">Respuestas totales</div></div>
          <div class="stat-card"><div class="stat-value">${data.preguntas.length}</div><div class="stat-label">Preguntas</div></div>
        </div>
        ${data.preguntas.map(p => {
          const total = p.respondidas || 0;
          const barras = (p.opciones || []).map(o => {
            const pct = total > 0 ? Math.round((o.count || 0) / total * 100) : 0;
            return `<div style="margin:8px 0">
              <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
                <span>${o.opcion}</span><span><strong>${o.count || 0}</strong> (${pct}%)</span>
              </div>
              <div style="height:12px;background:#f0f0f0;border-radius:4px;overflow:hidden">
                <div style="height:100%;width:${pct}%;background:${pct >= 50 ? 'var(--pri-green)' : pct >= 25 ? '#ffb74d' : '#e0e0e0'};border-radius:4px;transition:width 0.3s"></div>
              </div>
            </div>`;
          }).join('');
          return `<div style="background:#fff;border:1px solid #eee;border-radius:10px;padding:14px">
            <div style="font-size:14px;font-weight:600;margin-bottom:6px">${p.pregunta}</div>
            <div style="font-size:11px;color:#999;margin-bottom:4px">${p.tipo === 'si_no' ? 'Sí / No' : p.tipo === 'opciones' ? 'Opciones' : 'Respuesta libre'} · ${total} respuesta(s)</div>
            ${p.tipo === 'texto' ? (p.opciones || []).map(o => `<div style="font-size:12px;padding:4px 0;border-bottom:1px solid #f5f5f5">“${o.opcion}”</div>`).join('') : barras}
          </div>`;
        }).join('')}`;
    } catch (e) { cont.innerHTML = '<p style="font-size:13px;color:var(--pri-red);text-align:center">Error: ' + (e.message || e) + '</p>'; }
  };

  async function cargarSelectEncuestasReporte() {
    const sel = document.getElementById('rep-encuesta-campana');
    if (!sel) return;
    try {
      const campanas = await API.getCampanas();
      sel.innerHTML = '<option value="">Seleccionar encuesta...</option>' +
        (campanas || []).filter(c => c.tipo === 'encuesta').map(c => `<option value="${c.id}">${c.nombre}</option>`).join('');
    } catch (e) { console.warn(e); }
  }

  function validarTelefono(tel) {
    if (!tel) return null;
    const soloDigitos = tel.replace(/\D/g, '');
    if (soloDigitos.length !== 10) return 'El teléfono debe tener exactamente 10 dígitos';
    return null;
  }

  // Valida coherencia de la CURP con nombre y fecha de nacimiento.
  // Regla SEGOB: si el primer nombre es María/José y hay segundo nombre, se usa la inicial del segundo.
  function validarCurpSemanticaFront(curp, nombre, fechaNac) {
    if (!curp) return null;
    const palabras = String(nombre || '').toUpperCase()
      .replace(/[ÁÉÍÓÚ]/g, c => ({ 'Á': 'A', 'É': 'E', 'Í': 'I', 'Ó': 'O', 'Ú': 'U' }[c]))
      .replace(/Ñ/g, 'X')
      .replace(/[^A-Z0-9 ]/g, '')
      .split(/\s+/).filter(Boolean);
    if (palabras.length >= 2) {
      const curpInicial = curp[3];
      const primera = palabras[0];
      const esCompuesto = (primera === 'MARIA' || primera === 'JOSE');
      if (esCompuesto) {
        const inicialEsperada = palabras[1][0];
        if (curpInicial !== inicialEsperada && !palabras.some(p => p[0] === curpInicial && p !== 'MARIA' && p !== 'JOSE')) {
          return 'CURP no coincide con el nombre: con María/José como primer nombre se usa la inicial del segundo nombre';
        }
      } else if (curpInicial !== primera[0] && !palabras.some(p => p[0] === curpInicial)) {
        return 'CURP no coincide con el nombre capturado';
      }
    }
    if (fechaNac) {
      const partes = String(fechaNac).slice(0, 10).split('-').map(Number);
      if (partes.length === 3 && !partes.some(isNaN)) {
        const [y, m, d] = partes;
        const aa = String(y).slice(-2);
        const mm = String(m).padStart(2, '0');
        const dd = String(d).padStart(2, '0');
        const curpFecha = curp.slice(4, 10);
        if (curpFecha !== aa + mm + dd) {
          return 'CURP no coincide con la fecha de nacimiento (la CURP indica ' + curpFecha + ', la fecha capturada es ' + aa + mm + dd + ')';
        }
      }
    }
    return null;
  }

  let barridoActivo = false;
  let barridoMap = null;
  let barridoGeoLayer = null;
  let barridoHighlighted = null;
  let barridoClickMarker = null;
  let barridoGeometriasCache = {};
  let barridoWatchId = null;

  async function loadCiudadanos() {
    try {
      const container = document.getElementById('ciudadanos-body');
      if (!container) return;
      mostrarSyncStatus('Actualizando...', true);
      const [secciones, ciudadanos] = await Promise.all([API.getSecciones(), API.getCiudadanos()]);
      const filtro = document.getElementById('ciu-filtro-seccion');
      if (!filtro.value) {
        filtro.innerHTML = '<option value="">Todas las secciones</option>' + secciones.map(s => `<option value="${s.id}">Sec. ${s.id} - ${s.municipio}</option>`).join('');
        filtro.value = '';
      }
      const filtrados = filtro.value ? ciudadanos.filter(c => c.seccion_id == filtro.value) : ciudadanos;
      document.getElementById('ciudadanos-body').innerHTML = filtrados.length ? filtrados.map(c => {
        var fotoUrl = fotoUrlFromNotas(c.notas);
        return `<tr><td><strong>${c.nombre}</strong></td><td>${c.telefono || '-'}</td>
        <td>${[c.calle, c.numero].filter(Boolean).join(' ') || '-'}</td><td>${c.colonia || '-'}</td>
        <td>Sec. ${c.seccion_num}</td>
        <td><span class="badge ${c.simpatizante ? 'badge-yes' : 'badge-no'}">${c.simpatizante ? 'Sí' : 'No'}</span></td>
        <td>${c.prioridad || 0}</td>
        <td>${fotoUrl ? '<div style="position:relative;display:inline-block"><img src="'+fotoUrl+'" style="height:32px;width:32px;object-fit:cover;border-radius:4px;border:1px solid #ddd;cursor:pointer" onclick="window.open(\''+fotoUrl+'\',\'_blank\')"><span style="position:absolute;top:-4px;right:-4px;background:var(--pri-red);color:#fff;border-radius:50%;width:14px;height:14px;font-size:10px;line-height:14px;text-align:center;cursor:pointer" onclick="event.stopPropagation();eliminarFotoCiudadano(\''+c.id+'\',\''+c.nombre+'\',this)">×</span></div>' : '-'}</td>
        <td style="white-space:nowrap"><button class="btn-small btn-primary" onclick="abrirModal('ciudadano','${c.id}')">Editar</button> <button class="btn-small btn-secondary" onclick="mostrarHistorialCiudadano('${c.id}','${(c.nombre||'').replace(/'/g,"\\'")}')" title="Historial de visitas">Hist</button> <button class="btn-small btn-danger" onclick="eliminarItem('ciudadano','${c.id}','${c.nombre}')">X</button></td></tr>`;
      }).join('') : '<tr><td colspan="9" style="text-align:center;color:#999">No hay ciudadanos registrados</td></tr>';
      if (barridoActivo) actualizarMapaBarrido(ciudadanos);
      verificarDuplicados();
      finalizarStatus();
    } catch (err) { console.error(err); finalizarStatus(); }
  }

  let subTabCiudadanos = 'encuestados';
  window.cambiarSubTabCiudadanos = function(tab) {
    subTabCiudadanos = tab;
    document.querySelectorAll('#ciu-subtabs .ciu-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    const panE = document.getElementById('ciu-panel-encuestados');
    const panS = document.getElementById('ciu-panel-seguros');
    if (panE) panE.style.display = tab === 'encuestados' ? '' : 'none';
    if (panS) panS.style.display = tab === 'seguros' ? '' : 'none';
    if (tab === 'seguros') loadComprometidos();
  };
  window.mostrarSubTabSeguros = function(visible) {
    const tabBtn = document.getElementById('ciu-tab-seguros');
    if (tabBtn) tabBtn.style.display = visible ? '' : 'none';
    if (!visible && subTabCiudadanos === 'seguros') window.cambiarSubTabCiudadanos('encuestados');
  };

  async function loadComprometidos() {
    try {
      const container = document.getElementById('comprometidos-body');
      if (!container) return;
      mostrarSyncStatus('Actualizando...', true);
      const [secciones, comprometidos] = await Promise.all([API.getSecciones(), API.getComprometidos()]);
      const filtro = document.getElementById('cpr-filtro-seccion');
      if (!filtro.value) {
        filtro.innerHTML = '<option value="">Todas las secciones</option>' + secciones.map(s => `<option value="${s.id}">Sec. ${s.id} - ${s.municipio}</option>`).join('');
        filtro.value = '';
      }
      const buscaEl = document.getElementById('cpr-buscar');
      const busqueda = (buscaEl ? buscaEl.value : '').trim().toLowerCase();
      let filtrados = filtro.value ? comprometidos.filter(c => c.seccion_id == filtro.value) : comprometidos;
      if (busqueda) {
        filtrados = filtrados.filter(c =>
          (c.nombre || '').toLowerCase().includes(busqueda) ||
          (c.curp || '').toLowerCase().includes(busqueda) ||
          (c.ine || '').toLowerCase().includes(busqueda) ||
          (c.telefono || '').toLowerCase().includes(busqueda) ||
          (c.correo || '').toLowerCase().includes(busqueda) ||
          (c.calle || '').toLowerCase().includes(busqueda) ||
          (c.colonia || '').toLowerCase().includes(busqueda)
        );
      }
      document.getElementById('comprometidos-body').innerHTML = filtrados.length ? filtrados.map(c => {
        const nac = c.fecha_nacimiento ? String(c.fecha_nacimiento).slice(0, 10) : '';
        const nivelColor = c.nivel_compromiso === 'seguro' ? 'badge-yes' : c.nivel_compromiso === 'probable' ? '' : c.nivel_compromiso === 'dudoso' ? 'badge-no' : '';
        return `<tr><td><strong>${c.nombre}</strong>${c.edad ? ` <span style="color:#999;font-size:11px">(${c.edad}${nac ? ', ' + nac : ''})</span>` : nac ? ` <span style="color:#999;font-size:11px">(${nac})</span>` : ''}</td>
        <td>${c.telefono || '-'}</td><td>${c.correo || '-'}</td><td>${c.curp || '-'}</td><td>${c.ine || '-'}</td>
        <td>Sec. ${c.seccion_num}</td>
        <td><span class="badge ${nivelColor}">${c.nivel_compromiso || '-'}</span></td>
        <td>${c.partido_presidente?.abreviatura || '-'}</td>
        <td style="white-space:nowrap"><button class="btn-small btn-primary" onclick="abrirModal('comprometido','${c.id}')">Editar</button> <button class="btn-small btn-danger" onclick="eliminarItem('comprometido','${c.id}','${(c.nombre||'').replace(/'/g,"\\'")}')">X</button></td></tr>`;
      }).join('') : `<tr><td colspan="9" style="text-align:center;color:#999">${busqueda || filtro.value ? 'Sin resultados para la búsqueda' : 'No hay ciudadanos seguros registrados'}</td></tr>`;
      finalizarStatus();
    } catch (err) { console.error(err); finalizarStatus(); }
  }
  window.loadComprometidos = loadComprometidos;

  window.cprDebounceBuscar = function(valor) {
    debounce('cpr-buscar', loadComprometidos, 350);
  };

  window.cargarExcelComprometidos = async function(input) {
    const file = input?.files?.[0];
    if (!file) return;
    const status = document.getElementById('cpr-status');
    if (!status) return;
    status.textContent = 'Procesando ' + file.name + '...';
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const res = await API.requestWithTimeout('POST', '/api/comprometidos/importar', { base64: String(reader.result).split(',')[1] }, 60000);
        status.textContent = `Importación: ${res.creados} creados, ${res.omitidos} omitidos.${res.errores && res.errores.length ? ' Errores: ' + res.errores.slice(0, 3).join('; ') : ''}`;
        status.style.color = res.errores && res.errores.length ? 'var(--pri-red)' : 'var(--color-secondary)';
        loadComprometidos();
      } catch (e) { status.textContent = 'Error: ' + (e.message || 'No se pudo importar'); status.style.color = 'var(--pri-red)'; }
      input.value = '';
    };
    reader.onerror = () => { status.textContent = 'No se pudo leer el archivo'; status.style.color = 'var(--pri-red)'; };
    reader.readAsDataURL(file);
  };

  window.descargarPlantillaExcel = function() {
    const csv = 'nombre,telefono,fecha_nacimiento,calle,numero,colonia,cp,seccion,correo,curp,ine,nivel_compromiso,partido\nJuan Perez,5551234567,1985-05-12,Av Juarez,12,Centro,38000,2616,juan@correo.com,GOPJ850512HTSRRN02,1234567890,seguro,PRI';
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'plantilla_ciudadanos_seguros.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  async function verificarDuplicados() {
    try {
      var user = API.getUser(); var rol = user?.rol;
      if (rol !== 'admin' && rol !== 'coordinador') return;
      var groups = await API.request('GET', '/api/ciudadanos/duplicados');
      if (!groups || !groups.length) return;
      var modal = document.getElementById('duplicados-modal');
      var body = document.getElementById('duplicados-body');
      if (!modal || !body) return;
      body.innerHTML = groups.map(function(g) {
        return '<div class="dup-group" style="margin-bottom:16px;border:1px solid var(--border-color);border-radius:8px;padding:8px;background:var(--bg-card,#f9f9f9)">' +
          '<div style="font-weight:bold;font-size:13px;margin-bottom:8px;color:var(--pri-red)">⚠ ' + g.registros.length + ' registros similares</div>' +
          g.registros.map(function(r, i) {
            var foto = r.notas && !r.notas.startsWith('📷 data:') ? fotoUrlFromNotas(r.notas) : null;
            return '<div style="display:flex;justify-content:space-between;align-items:flex-start;padding:6px 0;border-bottom:'+(i<g.registros.length-1?'1px solid var(--border-color)':'none')+'">' +
              '<div style="flex:1;font-size:12px">' +
              '<strong>' + (r.nombre||'?') + '</strong>' + (r.edad?' ('+r.edad+')':'') + '<br>' +
              '<span style="color:#666">' + [r.calle, r.numero].filter(Boolean).join(' ') + (r.colonia?', '+r.colonia:'') + '</span><br>' +
              '<span style="color:#666">Tel: ' + (r.telefono||'-') + ' | Sec: ' + (r.seccion_id||'?') + ' | Prio: ' + (r.prioridad||0) + '</span>' +
              (r.timestamp ? '<br><span style="color:#999;font-size:11px">' + new Date(r.timestamp).toLocaleString() + '</span>' : '') +
              '</div>' +
              (foto ? '<img src="'+foto+'" style="height:32px;width:32px;object-fit:cover;border-radius:4px;margin-right:8px;flex-shrink:0">' : '') +
              '<button class="btn-small btn-danger" style="flex-shrink:0;font-size:10px;padding:2px 6px" onclick="eliminarDuplicado(\''+r.id+'\',\''+(r.nombre||'').replace(/'/g,"\\'")+'\')">Eliminar</button>' +
              '</div>';
          }).join('') + '</div>';
      }).join('');
      modal.classList.remove('hidden');
    } catch (e) { /* silent */ }
  }

  window.eliminarDuplicado = async function(id, nombre) {
    if (!(await confirmAsync('¿Eliminar a ' + nombre + '?'))) return;
    try {
      await API.request('DELETE', '/api/ciudadanos/' + id);
      notify('Registro eliminado', 'success');
      await verificarDuplicados();
      loadCiudadanos();
    } catch (e) { notify('Error al eliminar', 'error'); }
  };

  window.eliminarFotoCiudadano = async function(id, nombre, el) {
    if (!(await confirmAsync('¿Eliminar foto de ' + nombre + '?'))) return;
    try {
      await API.request('DELETE', '/api/ciudadanos/' + id + '/foto');
      if (el) { var div = el.closest('div'); if (div) div.outerHTML = '-'; }
      loadCiudadanos();
    } catch (e) { notify(e.message, 'error'); }
  };

  function resaltarSeccionBarrido(secId) {
    if (!barridoMap || !barridoActivo) return;
    if (barridoGeoLayer) { barridoMap.removeLayer(barridoGeoLayer); barridoGeoLayer = null; }
    if (!secId) return;
    API.getSecciones().then(secciones => {
      const sec = secciones.find(s => s.id == secId);
      if (sec?.municipio_id) {
        API.getGeometrias(sec.municipio_id).then(data => {
          const feat = data.features?.find(f => Math.round(f.properties.seccion) == secId);
          if (feat && barridoMap) {
            barridoGeoLayer = L.geoJSON(feat, {
              style: { fillColor: '#f5d0d0', fillOpacity: 0.12, color: '#e8a0a0', weight: 2, opacity: 0.8 }
            }).addTo(barridoMap);
            setTimeout(() => { try { barridoMap.fitBounds(barridoGeoLayer.getBounds(), { padding: [40,40], maxZoom: 16 }); } catch (e) { console.warn(e); } }, 200);
          }
        }).catch(e => console.warn(e));
      }
    }).catch(e => console.warn(e));
  }

  document.getElementById('bf-seccion')?.addEventListener('change', function() {
    resaltarSeccionBarrido(this.value);
  });

  function limpiarFormularioBarrido() {
    const bfVc = document.getElementById('bf-votantes_casa'); if (bfVc) bfVc.value = '0';
    window._vcListBf = [];
    actualizarBtnVotantesCasa();
    document.getElementById('bf-nombre').value = '';
    document.getElementById('bf-telefono').value = '';
    document.getElementById('bf-calle').value = '';
    document.getElementById('bf-numero').value = '';
    document.getElementById('bf-colonia').value = '';
    document.getElementById('bf-cp').value = '';
    document.getElementById('bf-edad').value = '';
    document.getElementById('bf-simpatizante').checked = false;
    document.getElementById('bf-partido-presidente').selectedIndex = 0;
    document.getElementById('bf-partido-diputado').selectedIndex = 0;
    document.getElementById('bf-lat').value = '';
    document.getElementById('bf-lng').value = '';
    limpiarEvidenciaBarrido();
    actualizarEstadoGuardarBarrido();
  }

  function toggleBarrido() {
    barridoActivo = !barridoActivo;
    document.getElementById('ciu-barrido').classList.toggle('hidden', !barridoActivo);
    document.getElementById('ciu-tabla-container').classList.toggle('hidden', barridoActivo);
    document.getElementById('btn-barrido').classList.toggle('btn-primary', barridoActivo);
    document.getElementById('btn-barrido').classList.toggle('btn-secondary', !barridoActivo);
    document.getElementById('btn-barrido').textContent = barridoActivo ? 'Ver tabla' : 'Modo Barrido';
    if (barridoActivo) {
      const sel = document.getElementById('bf-seccion');
      API.getSecciones().then(secs => { sel.innerHTML = '<option value="">Seccion</option>' + secs.map(s => `<option value="${s.id}">Sec. ${s.id}</option>`).join(''); });
      API.getPartidos().then(partidos => {
        const opts = '<option value="">-</option>' + partidos.map(p => `<option value="${p.id}">${p.abreviatura}</option>`).join('');
        document.getElementById('bf-partido-presidente').innerHTML = opts;
        document.getElementById('bf-partido-diputado').innerHTML = opts;
      });
      _gpsUsed = false;
      _gpsFixObtained = false;
      document.getElementById('bf-lat').value = '';
      document.getElementById('bf-lng').value = '';
      actualizarEstadoGuardarBarrido();
      // Attempt GPS acquisition on barrido activation (with fallback to low accuracy)
      (async () => {
        const pos = await tryGetPosition();
        if (pos) {
          const glat = pos.coords.latitude, glng = pos.coords.longitude;
          document.getElementById('bf-lat').value = glat;
          document.getElementById('bf-lng').value = glng;
          _gpsUsed = true;
          const gi = document.getElementById('bf-gps-indicator');
          const gt = document.getElementById('bf-gps-text');
          if (gi) { gi.style.background = '#e8f5e9'; gi.style.color = 'var(--pri-green)'; gi.style.animation = ''; }
          if (gt) gt.textContent = 'GPS OK';
          autoDetectarSeccion(glat, glng);
          reverseGeocode(glat, glng);
          actualizarEstadoGuardarBarrido();
          API.enviarUbicacion(glat, glng, pos.coords.accuracy || 0).catch(e => console.warn(e));
        }
      })();
      // Start continuous GPS tracking while barrido is active (enables admin to see enlace on dashboard)
      if (navigator.geolocation) {
        barridoWatchId = navigator.geolocation.watchPosition(pos => {
          const glat = pos.coords.latitude, glng = pos.coords.longitude;
          _gpsFixObtained = true;
          if (!document.getElementById('bf-lat').value) {
            document.getElementById('bf-lat').value = glat;
            document.getElementById('bf-lng').value = glng;
            actualizarEstadoGuardarBarrido();
          }
          API.enviarUbicacion(glat, glng, pos.coords.accuracy || 0).catch(e => console.warn(e));
        }, () => {}, { enableHighAccuracy: true, timeout: 15000 });
      }
      if (!barridoMap) {
        barridoMap = L.map('ciu-barrido-mapa', { maxZoom: 19 }).setView([20.6434, -100.9929], 14);
        crearTileLayer({ maxNativeZoom: 19 }).addTo(barridoMap);
        activarPrefetchMapa(barridoMap);
        setTimeout(() => barridoMap.invalidateSize(), 300);
        barridoMap.on('click', function(e) {
          if (!_gpsFixObtained) return;
          // Remove previous click marker
          if (barridoClickMarker) barridoMap.removeLayer(barridoClickMarker);
          barridoClickMarker = L.circleMarker([e.latlng.lat, e.latlng.lng], {
            radius: 8, fillColor: '#CC0000', color: '#fff', weight: 2, fillOpacity: 0.8
          }).addTo(barridoMap);
          _gpsUsed = true;
          document.getElementById('bf-lat').value = e.latlng.lat.toFixed(6);
          document.getElementById('bf-lng').value = e.latlng.lng.toFixed(6);
          // Update GPS indicator
          const gpsIndicator = document.getElementById('bf-gps-indicator');
          const gpsText = document.getElementById('bf-gps-text');
          if (gpsIndicator) {
            gpsIndicator.style.background = '#e8f5e9';
            gpsIndicator.style.color = 'var(--pri-green)';
            gpsIndicator.style.animation = '';
            gpsText.textContent = 'GPS OK';
            gpsIndicator.title = 'Ubicación del mapa';
          }
          autoDetectarSeccion(e.latlng.lat, e.latlng.lng);
          reverseGeocode(e.latlng.lat, e.latlng.lng);
          actualizarEstadoGuardarBarrido();
        });
      }
      API.getCiudadanos().then(ciudadanos => actualizarMapaBarrido(ciudadanos));
    } else {
      if (barridoWatchId !== null) { navigator.geolocation.clearWatch(barridoWatchId); barridoWatchId = null; }
      if (barridoMap) { barridoMap.remove(); barridoMap = null; }
      if (barridoClusterGroup) { barridoClusterGroup = null; }
    }
  }

  let coloresPartidos = {};
  async function cargarColoresPartidos() {
    try { const p = await API.getPartidos(); if (Array.isArray(p)) p.forEach(pp => coloresPartidos[pp.nombre] = pp.color); } catch (e) { console.warn(e); }
  }
  cargarColoresPartidos();

  async function autoDetectarSeccion(lat, lng) {
    try {
      const res = await API.detectarSeccion(lat, lng);
      if (res.seccion) {
        document.getElementById('bf-seccion').value = res.seccion;
        resaltarSeccionBarrido(res.seccion);
        const status = document.getElementById('bf-status');
        status.textContent = 'Sección ' + res.seccion + ' detectada';
        status.style.color = 'var(--pri-green)';
        setTimeout(() => status.textContent = '', 3000);
      }
    } catch (e) { console.warn(e); }
  }

  function pointInPolygon(point, vs) {
    const x = point[0], y = point[1];
    let inside = false;
    function flattenCoords(arr) {
      const result = [];
      arr.forEach(item => {
        if (item.lat != null && item.lng != null) result.push([item.lng, item.lat]);
        else if (Array.isArray(item)) {
          if (item.length >= 2 && typeof item[0] === 'number') result.push(item);
          else flattenCoords(item).forEach(c => result.push(c));
        }
      });
      return result;
    }
    const rings = flattenCoords(vs);
    for (let i = 0, j = rings.length - 1; i < rings.length; j = i++) {
      const xi = rings[i][0], yi = rings[i][1];
      const xj = rings[j][0], yj = rings[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function getUbicacionUsuario() {
    const user = API.getUser();
    if (!user) return { estado: 'Guanajuato', municipio: '' };
    let muniNombre = '';
    if (user.municipio_id && window.todosMunicipios) {
      const m = window.todosMunicipios.find(m => m.id === user.municipio_id);
      if (m) muniNombre = m.nombre;
    }
    if (!muniNombre && user.secciones?.length && window.todosMunicipios) {
      const seccion = window._seccionesList?.find(s => s.id === user.secciones[0]);
      if (seccion?.municipio_id) {
        const m = window.todosMunicipios.find(m => m.id === seccion.municipio_id);
        if (m) muniNombre = m.nombre;
      }
    }
    // Fallback: use dashboard municipio filter if available
    if (!muniNombre) {
      const muniSel = document.getElementById('dash-municipio');
      if (muniSel && muniSel.value && window.todosMunicipios) {
        const m = window.todosMunicipios.find(m => m.id === parseInt(muniSel.value));
        if (m) muniNombre = m.nombre;
      }
    }
    return { estado: 'Guanajuato', municipio: muniNombre };
  }

  window.buscarDireccionBarrido = async function() {
    const calle = document.getElementById('bf-calle').value.trim();
    const numero = document.getElementById('bf-numero').value.trim();
    const colonia = document.getElementById('bf-colonia').value.trim();
    if (!calle) { document.getElementById('bf-status').textContent = 'Escriba una calle'; document.getElementById('bf-status').style.color = 'var(--pri-red)'; return; }
    const ubic = getUbicacionUsuario();
    const status = document.getElementById('bf-status');

    // Try GPS first (with fallback to low accuracy)
    let lat, lng;
    let gpsOk = false;
    status.textContent = 'Obteniendo GPS...'; status.style.color = '#999';
    const pos = await tryGetPosition();
    if (pos) {
      lat = pos.coords.latitude;
      lng = pos.coords.longitude;
      gpsOk = true;
      _gpsUsed = true;
    }

    if (gpsOk) {
      const gi = document.getElementById('bf-gps-indicator');
      const gt = document.getElementById('bf-gps-text');
      if (gi) { gi.style.background = '#e8f5e9'; gi.style.color = 'var(--pri-green)'; gi.style.animation = ''; }
      if (gt) gt.textContent = 'GPS OK';
    }
    if (!gpsOk) {
      // Fallback to Nominatim address search
      const params = new URLSearchParams();
      params.set('format', 'json');
      params.set('limit', '3');
      params.set('countrycodes', 'MX');
      const street = [calle, numero].filter(Boolean).join(' ');
      params.set('street', street);
      if (colonia) params.set('city', colonia);
      if (ubic.municipio) params.set('county', ubic.municipio);
      params.set('state', ubic.estado);
      status.textContent = 'Buscando dirección...'; status.style.color = '#999';
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
        const data = await res.json();
        if (!data.length) { status.textContent = 'Dirección no encontrada'; status.style.color = 'var(--pri-red)'; return; }
        lat = parseFloat(data[0].lat);
        lng = parseFloat(data[0].lon);
      } catch (err) { status.textContent = 'Error al buscar'; status.style.color = 'var(--pri-red)'; return; }
    }

    document.getElementById('bf-lat').value = lat;
    document.getElementById('bf-lng').value = lng;
    await autoDetectarSeccion(lat, lng);
    if (gpsOk) await reverseGeocode(lat, lng);
    if (barridoMap) {
      if (barridoClickMarker) barridoMap.removeLayer(barridoClickMarker);
      barridoClickMarker = L.circleMarker([lat, lng], {
        radius: 8, fillColor: '#CC0000', color: '#fff', weight: 2, fillOpacity: 0.8
      }).addTo(barridoMap);
      barridoMap.setView([lat, lng], 16);
      // Load seccion polygon and zoom
      const secId = document.getElementById('bf-seccion').value;
      if (secId) {
        try {
          const secciones = await API.getSecciones();
          const sec = secciones.find(s => s.id == secId);
          if (sec?.municipio_id) {
            const geoData = await API.getGeometrias(sec.municipio_id);
            const feat = geoData.features?.find(f => Math.round(f.properties.seccion) == secId);
            if (feat) {
              if (barridoGeoLayer) { barridoMap.removeLayer(barridoGeoLayer); barridoGeoLayer = null; }
              barridoGeoLayer = L.geoJSON(feat, {
                style: { fillColor: '#f5d0d0', fillOpacity: 0.12, color: '#e8a0a0', weight: 2, opacity: 0.8 }
              }).addTo(barridoMap);
              try { barridoMap.fitBounds(barridoGeoLayer.getBounds(), { padding: [40,40], maxZoom: 16 }); } catch (e) { console.warn(e); }
            }
          }
        } catch (e) { console.warn(e); }
      }
    }
    actualizarEstadoGuardarBarrido();
    status.textContent = gpsOk ? 'Ubicación GPS ✓' : 'Ubicación encontrada ✓';
    status.style.color = 'var(--pri-green)';
    setTimeout(() => status.textContent = '', 3000);
  };

  async function reverseGeocode(lat, lng) {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&addressdetails=1`);
      const data = await res.json();
      if (!data?.address) return;
      const addr = data.address;
      const calle = document.getElementById('bf-calle');
      if (!calle.value.trim()) calle.value = addr.road || addr.pedestrian || addr.street || '';
      const num = document.getElementById('bf-numero');
      if (!num.value.trim()) num.value = addr.house_number || '';
      const coloniaVal = addr.suburb || addr.neighbourhood || addr.hamlet || addr.village || addr.town || '';
      const col = document.getElementById('bf-colonia');
      if (coloniaVal && !col.value.trim()) col.value = coloniaVal;
    } catch (e) { console.warn(e); }
  }

  function actualizarMapaBarrido(ciudadanos) {
    if (!barridoMap) return;
    if (!barridoClusterGroup) { barridoClusterGroup = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 50 }); barridoMap.addLayer(barridoClusterGroup); }
    barridoClusterGroup.clearLayers();

    // Add seccion polygon if a specific seccion is selected
    const filtroSec = document.getElementById('ciu-filtro-seccion').value;
    if (barridoGeoLayer) { barridoMap.removeLayer(barridoGeoLayer); barridoGeoLayer = null; }
    if (filtroSec) {
      API.getSecciones().then(secciones => {
        const sec = secciones.find(s => s.id == filtroSec);
        if (sec?.municipio_id) {
          API.getGeometrias(sec.municipio_id).then(data => {
            const feat = data.features?.find(f => Math.round(f.properties.seccion) == filtroSec);
            if (feat && barridoMap) {
              barridoGeoLayer = L.geoJSON(feat, {
                style: { fillColor: '#f5d0d0', fillOpacity: 0.12, color: '#e8a0a0', weight: 2, opacity: 0.8 }
              }).addTo(barridoMap);
              setTimeout(() => { try { barridoMap.fitBounds(barridoGeoLayer.getBounds(), { padding: [40,40], maxZoom: 16 }); } catch (e) { console.warn(e); } }, 200);
            }
          }).catch(e => console.warn(e));
        }
      });
    }

    ciudadanos.forEach(c => {
      if (c.ubicacion?.lat && c.ubicacion?.lng) {
        const color = c.partido_presidente?.color || coloresPartidos[c.partido_presidente?.nombre] || (c.simpatizante ? C_SECONDARY : '#000');
        barridoClusterGroup.addLayer(L.circleMarker([c.ubicacion.lat, c.ubicacion.lng], {
          radius: 7, fillColor: color, color: '#fff', weight: 2, fillOpacity: 0.8
        }).bindPopup(`<b>${c.nombre}</b><br>${[c.calle,c.numero].filter(Boolean).join(' ')}<br>${c.telefono||''}${c.partido_presidente?.abreviatura ? '<br>Pres: '+c.partido_presidente.abreviatura : ''}${c.partido_diputado?.abreviatura ? '<br>Dip: '+c.partido_diputado.abreviatura : ''}`));
      }
    });
  }
  document.getElementById('btn-barrido')?.addEventListener('click', toggleBarrido);
  document.getElementById('bf-telefono')?.addEventListener('input', function() { this.value = this.value.replace(/\D/g, '').slice(0, 10); });
  document.getElementById('bf-edad')?.addEventListener('input', function() { this.value = this.value.replace(/\D/g, '').slice(0, 3); });

  // 🔍 Auto-buscar dirección en barrido al escribir calle (debounce 800ms)
  document.getElementById('bf-calle')?.addEventListener('input', function() {
    var calleVal = this.value.trim();
    if (calleVal.length < 3) return;
    debounce('geo-barrido', function() {
      var fn = window.buscarDireccionBarrido;
      if (fn) fn();
    }, 800);
  });

  document.getElementById('btn-guardar-barrido')?.addEventListener('click', async () => {
    const nombre = document.getElementById('bf-nombre').value.trim();
    if (!nombre) { document.getElementById('bf-status').textContent = 'Nombre requerido'; document.getElementById('bf-status').style.color = 'var(--pri-red)'; return; }
    const telefono = document.getElementById('bf-telefono').value.trim();
    const errTel = validarTelefono(telefono);
    if (errTel) { document.getElementById('bf-status').textContent = errTel; document.getElementById('bf-status').style.color = 'var(--pri-red)'; return; }
    const calle = document.getElementById('bf-calle').value.trim();
    const numero = document.getElementById('bf-numero').value.trim();
    const colonia = document.getElementById('bf-colonia').value.trim();
    const cp = document.getElementById('bf-cp').value.trim();
    const seccionId = parseInt(document.getElementById('bf-seccion').value);
    if (!seccionId) { document.getElementById('bf-status').textContent = 'Seleccione seccion'; document.getElementById('bf-status').style.color = 'var(--pri-red)'; return; }
    const edad = parseInt(document.getElementById('bf-edad').value);
    if (document.getElementById('bf-edad').value && (isNaN(edad) || edad < 18 || edad > 130)) { document.getElementById('bf-status').textContent = 'Edad invalida (18-130)'; document.getElementById('bf-status').style.color = 'var(--pri-red)'; return; }
    const simpatizante = document.getElementById('bf-simpatizante').checked;
    const intencionVotoPresidente = parseInt(document.getElementById('bf-partido-presidente').value) || null;
    const intencionVotoDiputado = parseInt(document.getElementById('bf-partido-diputado').value) || null;
    const gpsIndicator = document.getElementById('bf-gps-indicator');
    const gpsText = document.getElementById('bf-gps-text');
    const status = document.getElementById('bf-status');
    const data = { nombre, telefono, edad: parseInt(document.getElementById('bf-edad').value) || null, calle, numero, colonia, cp, seccion_id: seccionId, simpatizante, intencion_voto_presidente: intencionVotoPresidente, intencion_voto_diputado: intencionVotoDiputado };
    const bfExtras = parseInt(document.getElementById('bf-votantes_casa').value) || 0;
    if (bfExtras > 0) data.votantes_casa = bfExtras + 1;
    const bfVcDef = Array.isArray(window._vcListBf) ? window._vcListBf.filter(v => v.nombre || v.partido_id || v.partido_diputado_id) : [];
    if (bfVcDef.length) data.votantes_casa_list = bfVcDef.map(v => ({ ...v, pendiente: !v.partido_id && !v.partido_diputado_id }));
    // Capture photo evidence (base64) and GPS first, without API calls
    const evidenciaImg = document.getElementById('bf-evidencia-img');
    const tieneFoto = evidenciaImg.src && evidenciaImg.src.startsWith('data:');
    if (tieneFoto) data.notas = '📷 ' + evidenciaImg.src;
    let gpsOk = false;
    let lat = parseFloat(document.getElementById('bf-lat').value);
    let lng = parseFloat(document.getElementById('bf-lng').value);
    if (!isNaN(lat) && !isNaN(lng)) {
      data.lat = lat; data.lng = lng;
      gpsOk = true;
    } else if (!tieneFoto) {
      const pos = await tryGetPosition();
      if (pos) {
        data.lat = pos.coords.latitude; data.lng = pos.coords.longitude;
        gpsOk = true;
        _gpsFixObtained = true;
        autoDetectarSeccion(data.lat, data.lng);
      }
      if (!gpsOk) {
        var geo = await geocodeAddress(calle, numero, colonia, seccionId);
        if (geo) { data.lat = geo.lat; data.lng = geo.lng; gpsOk = true; }
      }
    }
    // Require GPS or photo to save
    if (!gpsOk && !data.notas?.startsWith('📷')) {
      status.textContent = 'Requiere GPS o foto de evidencia'; status.style.color = 'var(--pri-red)'; return;
    }
    // Generate idempotency key before first attempt (survives queue retries)
    data.idempotency_key = crypto.randomUUID();
    if (window._guardandoBarrido) return;
    window._guardandoBarrido = true;
    const btnGuardar = document.getElementById('btn-guardar-barrido');
    if (btnGuardar) btnGuardar.disabled = true;
    status.textContent = 'Guardando...'; status.style.color = '#999';
    try {
      // Upload photo to server (compress) and remove base64 from data
      var finalNotas = data.notas;
      if (finalNotas && finalNotas.startsWith('📷 data:')) {
        var uploadRes = await API.uploadImage(finalNotas.replace('📷 ', ''));
        if (uploadRes?.url) data.notas = '📷 ' + uploadRes.url;
      }
      // Update GPS indicator
      gpsIndicator.style.background = gpsOk ? '#e8f5e9' : '#fff3e0';
      gpsIndicator.style.color = gpsOk ? 'var(--pri-green)' : '#e65100';
      gpsText.textContent = gpsOk ? 'GPS OK' : 'Sin GPS';
      gpsIndicator.title = gpsOk ? 'Ubicación obtenida' : 'GPS no disponible - capture evidencia';
      if (!gpsOk) gpsIndicator.style.animation = 'pulse 1.5s infinite';
      else gpsIndicator.style.animation = '';
      await API.crearCiudadano(data);
      _gpsUsed = false;
      limpiarFormularioBarrido();
      status.textContent = 'Guardado!'; status.style.color = 'var(--pri-green)';
      setTimeout(() => status.textContent = '', 2000);
      loadCiudadanos();
      window._guardandoBarrido = false;
      if (btnGuardar) btnGuardar.disabled = false;
    } catch (err) {
      _gpsUsed = false;
      var qData = { ...data };
      var evidenciaSrc = document.getElementById('bf-evidencia-img').src;
      if (evidenciaSrc && evidenciaSrc.startsWith('data:') && !qData.notas) qData.notas = '📷 ' + evidenciaSrc;
      limpiarFormularioBarrido();
      (async function() {
        if (qData.notas && qData.notas.startsWith('📷 data:')) {
          try { qData.notas = '📷 ' + await comprimirBase64(qData.notas.replace('📷 ', ''), 800, 0.6); } catch (e) { console.warn('Compress failed:', e); }
        }
        try { await agregarAOfflineQueue({ type: 'crearCiudadano', data: qData }); } catch (e) { console.warn('Queue failed:', e); status.textContent = 'Error al guardar offline'; status.style.color = 'var(--pri-red)'; window._guardandoBarrido = false; if (btnGuardar) btnGuardar.disabled = false; return; }
        status.textContent = 'Guardado (offline)'; status.style.color = '#e65100';
        setTimeout(() => status.textContent = '', 2000);
        loadCiudadanos();
        window._guardandoBarrido = false;
        if (btnGuardar) btnGuardar.disabled = false;
      })();
    }
  });

  window.capturarEvidenciaBarrido = function() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.capture = 'environment';
    input.onchange = function(e) {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function(ev) {
        document.getElementById('bf-evidencia-img').src = ev.target.result;
        document.getElementById('bf-evidencia-preview').style.display = 'block';
        actualizarEstadoGuardarBarrido();
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  function actualizarEstadoGuardarBarrido() {
    const btn = document.getElementById('btn-guardar-barrido');
    const lat = parseFloat(document.getElementById('bf-lat').value);
    const lng = parseFloat(document.getElementById('bf-lng').value);
    const gpsOk = !isNaN(lat) && !isNaN(lng) && _gpsUsed;
    const fotoTomada = document.getElementById('bf-evidencia-img').src?.startsWith('data:');
    const habilitado = gpsOk || fotoTomada;
    btn.disabled = !habilitado;
    btn.style.opacity = habilitado ? '1' : '0.4';
    btn.style.cursor = habilitado ? 'pointer' : 'not-allowed';
    const fotoReq = document.getElementById('bf-foto-requerido');
    const camBtn = document.getElementById('bf-btn-camara');
    if (camBtn) camBtn.style.display = gpsOk ? 'none' : '';
    if (!gpsOk) {
      if (!fotoReq) {
        const el = document.createElement('span');
        el.id = 'bf-foto-requerido';
        el.style.cssText = 'font-size:11px;color:var(--pri-red);margin-left:4px';
        el.textContent = '📸 Requiere foto';
        document.getElementById('bf-btn-camara')?.parentNode?.insertBefore(el, document.getElementById('bf-btn-camara').nextSibling);
      }
    } else if (fotoReq) fotoReq.remove();
  }

  window.limpiarEvidenciaBarrido = function() {
    document.getElementById('bf-evidencia-img').src = '';
    document.getElementById('bf-evidencia-preview').style.display = 'none';
    actualizarEstadoGuardarBarrido();
  };

  window.buscarColoniasPorCP = function(cp) {
    cp = cp.trim();
    const sug = document.getElementById('bf-colonia-sug');
    const colInput = document.getElementById('bf-colonia');
    if (cp.length !== 5 || !/^\d{5}$/.test(cp)) { sug.style.display = 'none'; return; }
    if (colInput.dataset.lastCp === cp) return;
    colInput.dataset.lastCp = cp;
    sug.innerHTML = '<div style="padding:6px;color:#999;font-size:12px">Buscando...</div>';
    sug.style.display = 'block';
    API.request('GET', `/api/cp/${cp}`).then(data => {
      const colonias = data?.colonias;
      if (colonias?.length) {
        mostrarSugerenciasColonia(colonias, sug, colInput);
        if (data.municipio && window.todosMunicipios) {
          const m = window.todosMunicipios.find(m => m.nombre?.toLowerCase() === data.municipio?.toLowerCase());
          if (m) {
            const muniSel = document.getElementById('dash-municipio');
            if (muniSel && !muniSel.value) {
              const match = [...muniSel.options].find(o => o.text?.toLowerCase() === data.municipio?.toLowerCase());
              if (match) muniSel.value = match.value;
            }
          }
        }
      } else {
        sug.style.display = 'none';
      }
    }).catch(() => { sug.style.display = 'none'; });
  };

  function mostrarSugerenciasColonia(colonias, sug, colInput) {
    sug.innerHTML = colonias.map(c =>
      `<div style="padding:6px 10px;cursor:pointer;font-size:12px;border-bottom:1px solid #f0f0f0" onmousedown="event.preventDefault();document.getElementById('bf-colonia').value='${c.replace(/'/g, "\\'")}';document.getElementById('bf-colonia-sug').style.display='none';setTimeout(function(){if(window.buscarDireccionBarrido)window.buscarDireccionBarrido();},100)">${c}</div>`
    ).join('');
    if (colonias.length === 1) { colInput.value = colonias[0]; sug.style.display = 'none'; if (window.buscarDireccionBarrido) setTimeout(function() { window.buscarDireccionBarrido(); }, 100); }
  }

  // Close suggestions on outside click
  document.addEventListener('click', function(e) {
    const sug = document.getElementById('bf-colonia-sug');
    if (sug && !e.target.closest('#bf-colonia') && !e.target.closest('#bf-cp') && !e.target.closest('#bf-colonia-sug')) {
      sug.style.display = 'none';
    }
    const sug2 = document.getElementById('f-colonia-sug');
    if (sug2 && !e.target.closest('#f-colonia') && !e.target.closest('#f-cp') && !e.target.closest('#f-colonia-sug')) {
      sug2.style.display = 'none';
    }
  });

  // Delegate click on modal colonia suggestion items
  document.getElementById('modal-overlay').addEventListener('mousedown', function(e) {
    const item = e.target.closest('.f-colonia-sug-item');
    if (item) {
      e.preventDefault();
      document.getElementById('f-colonia').value = item.dataset.val;
      document.getElementById('f-colonia-sug').style.display = 'none';
      if (window._geocodificarModal) setTimeout(window._geocodificarModal, 100);
    }
  });

  async function loadEventos() {
    try {
      const eventos = await API.getEventos();
      const ahora = Date.now();
      const activos = eventos.filter(e => new Date(e.fecha_fin).getTime() >= ahora);
      const culminados = eventos.filter(e => new Date(e.fecha_fin).getTime() < ahora);
      document.getElementById('eventos-list').innerHTML = activos.length ? (await Promise.all(activos.map(async e => {
        const tieneProg = Array.isArray(e.alertar_config) && e.alertar_config.length > 0;
        let badge = '';
        if (tieneProg) {
          const countRes = await API.getCiudadanosEnRadio(e.id).catch(() => []);
          const count = Array.isArray(countRes) ? countRes.length : 0;
          badge = `<span style="display:inline-block;font-size:10px;background:var(--pri-green);color:#fff;padding:1px 6px;border-radius:8px;margin-left:6px">📅 ${e.alertar_config.length} prog</span><span style="font-size:10px;color:var(--text-muted);margin-left:4px">${count} ciudadanos</span>`;
        }
        return `<div class="card"><h3>${e.nombre}${badge}</h3>
        <p><strong>Radio:</strong> ${e.radio_geocerca || 500}m | <strong>Inicio:</strong> ${new Date(e.fecha_inicio).toLocaleDateString()} | <strong>Fin:</strong> ${new Date(e.fecha_fin).toLocaleDateString()}</p>
        <div class="card-actions"><button class="btn-small btn-primary" onclick="abrirModal('evento','${e.id}')">Editar</button>
        <button class="btn-small btn-secondary" onclick="dispararAlertasEvento('${e.id}')">📨 Enviar ahora</button>
        <button class="btn-small btn-danger" onclick="eliminarItem('evento','${e.id}','${e.nombre}')">X</button></div></div>`;
      }))).join('') : '<p style="color:var(--text-muted)">No hay eventos activos</p>';
      document.getElementById('eventos-culminados-list').innerHTML = culminados.length ? culminados.map(e => `
        <div class="card evt-culminado"><h3>${e.nombre}<span style="display:inline-block;font-size:10px;background:#888;color:#fff;padding:1px 6px;border-radius:8px;margin-left:6px">✅ Culminado</span></h3>
        <p><strong>Inicio:</strong> ${new Date(e.fecha_inicio).toLocaleString()} | <strong>Fin:</strong> ${new Date(e.fecha_fin).toLocaleString()}</p>
        <div class="card-actions"><button class="btn-small btn-danger" onclick="eliminarItem('evento','${e.id}','${e.nombre}')" title="Eliminar evento culminado">🗑 Eliminar</button></div></div>
      `).join('') : '<p style="color:var(--text-muted)">No hay eventos culminados</p>';
    } catch (err) { console.error(err); }
  }

  window.dispararAlertasEvento = async function(id) {
    if (!confirm('¿Enviar recordatorio WhatsApp a todos los ciudadanos en la geocerca de este evento?')) return;
    try {
      const r = await API.dispararAlertasEvento(id);
      notify('Recordatorio enviado a ' + r.enviados + ' ciudadanos', 'success');
    } catch (e) { notify('Error: ' + e.message, 'error'); }
  };

  async function loadGeocercas() {
    try {
      API.getAlertasStats().then(s => {
        document.getElementById('stat-pendientes').textContent = s.pendientes;
        document.getElementById('stat-enviados').textContent = s.enviados;
        document.getElementById('stat-fallaron').textContent = s.fallaron;
      }).catch(e => console.warn(e));
      API.getAlertasUltimas().then(alerts => {
        document.getElementById('alertas-table-container').innerHTML = alerts.length ? `<table style="width:100%;border-collapse:collapse"><thead><tr style="background:#f5f5f5"><th style="padding:6px 8px;text-align:left">Ciudadano</th><th style="padding:6px 8px;text-align:left">Evento</th><th style="padding:6px 8px;text-align:left">Teléfono</th><th style="padding:6px 8px;text-align:left">Estado</th><th style="padding:6px 8px;text-align:left">Fecha</th></tr></thead><tbody>${alerts.map(a => `<tr style="border-bottom:1px solid #eee"><td style="padding:6px 8px">${a.ciudadano_nombre || '-'}</td><td style="padding:6px 8px">${a.evento_nombre || '-'}</td><td style="padding:6px 8px">${a.telefono_ciudadano || '-'}</td><td style="padding:6px 8px">${a.enviado ? '✅ Enviado' : a.retry_count >= 3 ? '❌ Falló' : '⏳ Pendiente'}</td><td style="padding:6px 8px">${a.timestamp_envio ? new Date(a.timestamp_envio).toLocaleString() : new Date(a.timestamp_deteccion).toLocaleString()}</td></tr>`).join('')}</tbody></table>` : '<p style="color:var(--text-muted);font-size:13px">No hay alertas registradas</p>';
      }).catch(e => console.warn(e));
      const filtroSec = parseInt(document.getElementById('geo-filtro-seccion').value) || 0;
      const seccionParam = filtroSec || undefined;
      const [geocercas, ciudadanos, estados, secciones, partidos, eventos] = await Promise.all([
        API.getGeocercas(seccionParam), API.getCiudadanos(), API.getEstados(), API.getSecciones(), API.getPartidos(), API.getEventos()
      ]);
      const estadoSel = document.getElementById('geo-filtro-estado');
      const muniSel = document.getElementById('geo-filtro-municipio');
      const evtSel = document.getElementById('geo-filtro-evento');
      const intencionTipo = document.getElementById('geo-intencion-tipo')?.value || 'presidente';
      const partidoField = intencionTipo === 'diputado' ? 'partido_diputado' : 'partido_presidente';
      if (!evtSel.value) {
        const ahora = Date.now();
        evtSel.innerHTML = '<option value="">Todos los eventos</option>' + eventos.filter(e => new Date(e.fecha_fin).getTime() >= ahora).map(e => `<option value="${e.id}">${e.nombre}</option>`).join('');
      }
      const filtroMuni = parseInt(muniSel.value) || 0;
      const secIds = new Set(filtroSec ? [filtroSec] : filtroMuni ? secciones.filter(s => s.municipio_id === filtroMuni).map(s => s.id) : []);
      let filtrados = secIds.size ? ciudadanos.filter(c => secIds.has(c.seccion_id)) : ciudadanos;

      const activeTab = document.querySelector('.geo-tab.active')?.dataset?.filter || 'all';
      const partidoFiltro = document.getElementById('geo-filtro-partido').value;
      if (activeTab === 'simpatizantes') filtrados = filtrados.filter(c => c.simpatizante);
      else if (activeTab === 'nosimp') filtrados = filtrados.filter(c => !c.simpatizante);
      else if (activeTab === 'partido' && partidoFiltro) {
        if (intencionTipo === 'presidente') filtrados = filtrados.filter(c => c.partido_presidente?.nombre === partidoFiltro);
        else if (intencionTipo === 'diputado') filtrados = filtrados.filter(c => c.partido_diputado?.nombre === partidoFiltro);
        else filtrados = filtrados.filter(c => c.partido_presidente?.nombre === partidoFiltro || c.partido_diputado?.nombre === partidoFiltro);
      }

      const partidoSel = document.getElementById('geo-filtro-partido');
      if (!partidoSel.value || partidoSel.options.length <= 1) {
        partidoSel.innerHTML = '<option value="">Partido...</option>' + partidos.map(p => `<option value="${p.nombre}">${p.abreviatura}</option>`).join('');
      }

      const filtroEvento = evtSel.value;
      let geosAMostrar = geocercas;
      if (filtroEvento) {
        geosAMostrar = geocercas.filter(g => g.evento_id == filtroEvento || g.id == filtroEvento);
      }

      document.getElementById('geocercas-list').innerHTML = geosAMostrar.length ? geosAMostrar.map(g => `
        <div class="card"><h3>${g.nombre}</h3>
        <p><strong>Radio:</strong> ${g.radio_metros}m</p>
        <p><strong>Ubicación:</strong> ${g.ubicacion.lat.toFixed(4)}, ${g.ubicacion.lng.toFixed(4)}</p>
        <p><span class="badge badge-yes">${g.activo ? 'Activa' : 'Inactiva'}</span></p></div>
      `).join('') : '<p style="color:var(--text-muted)">No hay geocercas activas</p>';

      if (!geocercasMap) {
        geocercasMap = L.map('geocercas-map', { maxZoom: 19 }).setView([20.6434, -100.9929], 13);
        crearTileLayer({ attribution: '&copy; <a href="https://www.esri.com/">Esri</a>', maxNativeZoom: 19 }).addTo(geocercasMap);
        activarPrefetchMapa(geocercasMap);
        setTimeout(() => geocercasMap.invalidateSize(), 200);
      } else {
        geocercasMap.eachLayer(l => { if (l instanceof L.Circle || l instanceof L.CircleMarker || l instanceof L.Marker || l === geocercasGeoLayer) geocercasMap.removeLayer(l); });
      }

      // Add seccion polygons
      if (geocercasGeoLayer) { geocercasMap.removeLayer(geocercasGeoLayer); geocercasGeoLayer = null; }
      let muniForGeo = filtroMuni;
      let secFilter = 0;
      if (filtroEvento) {
        try {
          const resp = await API.getSeccionesAlcanzadas(filtroEvento);
          if (resp?.secciones?.length) {
            const secData = secciones.find(s => s.id == resp.secciones[0]);
            if (secData) muniForGeo = secData.municipio_id;
            secFilter = new Set(resp.secciones.map(Number));
          }
        } catch (e) { console.warn(e); }
      }
      if (!muniForGeo && filtroSec) {
        const secData = secciones.find(s => s.id === filtroSec);
        muniForGeo = secData?.municipio_id || 0;
      }
      if (!filtroEvento && filtroSec) secFilter = new Set([filtroSec]);
      if (muniForGeo) {
        try {
          const data = await API.getGeometrias(muniForGeo);
          if (data?.features?.length && geocercasMap) {
            const secPartyCounts = {};
            filtrados.forEach(c => {
              const p = partidoField === 'partido_diputado' ? c.partido_diputado : c.partido_presidente;
              if (p?.nombre) {
                if (!secPartyCounts[c.seccion_id]) secPartyCounts[c.seccion_id] = {};
                secPartyCounts[c.seccion_id][p.nombre] = (secPartyCounts[c.seccion_id][p.nombre] || 0) + 1;
              }
            });
            const secDominantColor = {};
            Object.keys(secPartyCounts).forEach(secId => {
              const counts = secPartyCounts[secId];
              const top = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b);
              const partido = partidos.find(p => p.nombre === top);
              secDominantColor[secId] = partido?.color || '#f5d0d0';
            });
            const featuresToShow = secFilter instanceof Set ? data.features.filter(f => secFilter.has(Math.round(f.properties.seccion))) : data.features;
            if (featuresToShow.length) {
              geocercasGeoLayer = L.geoJSON({ type: 'FeatureCollection', features: featuresToShow }, {
                style: feature => {
                  const sec = Math.round(feature.properties.seccion);
                  const hasData = secDominantColor[sec];
                  const fill = hasData || '#f5d0d0';
                  const border = hasData || '#e8a0a0';
                  return { fillColor: fill, fillOpacity: 0.12, color: border, weight: 2, opacity: 0.8 };
                },
                onEachFeature: (feature, layer) => {
                  const sec = Math.round(feature.properties.seccion);
                  const ciudadanosSec = filtrados.filter(c => c.seccion_id === sec);
                  layer.bindTooltip(String(sec), { permanent: true, direction: 'center', className: 'sec-label', offset: [0, 0] });
                  layer.bindPopup(`<b>Sección ${sec}</b><br>Ciudadanos: ${ciudadanosSec.length}`);
                  layer.on('mouseover', function() {
                    this.setStyle({ weight: 3, opacity: 1, fillOpacity: 0.25 });
                  });
                  layer.on('mouseout', function() {
                    if (geocercasGeoLayer) geocercasGeoLayer.resetStyle(this);
                  });
                }
              }).addTo(geocercasMap);
            }
          }
        } catch (e) { console.warn(e); }
      }
      const showGeoContent = !filtroMuni || geocercasGeoLayer;
      if (showGeoContent) {
        geosAMostrar.forEach(g => {
          L.circle([g.ubicacion.lat, g.ubicacion.lng], {
            radius: g.radio_metros, color: C_PRIMARY, fillColor: C_PRIMARY, fillOpacity: 0.1, weight: 2
          }).addTo(geocercasMap).bindPopup(`<b>${g.nombre}</b><br>Radio: ${g.radio_metros}m`);
        });
        if (!geocercasClusterGroup) { geocercasClusterGroup = L.markerClusterGroup({ chunkedLoading: true, maxClusterRadius: 50 }); geocercasMap.addLayer(geocercasClusterGroup); }
        geocercasClusterGroup.clearLayers();
        const colores = {}; partidos.forEach(p => colores[p.nombre] = p.color);
        filtrados.forEach(c => {
          if (c.ubicacion?.lat && c.ubicacion?.lng) {
            const partido = partidoField === 'partido_diputado' ? c.partido_diputado : c.partido_presidente;
            geocercasClusterGroup.addLayer(L.circleMarker([c.ubicacion.lat, c.ubicacion.lng], {
              radius: 6, fillColor: partido?.color || (c.simpatizante ? C_SECONDARY : '#000'), color: '#fff', weight: 2, fillOpacity: 0.8
            }).bindPopup(`<b>${c.nombre}</b><br>Tel: ${c.telefono || '-'}<br>${c.simpatizante ? 'Simpatizante' : 'No simpatizante'}${c.partido_presidente?.abreviatura ? '<br>Pres: '+c.partido_presidente.abreviatura : ''}${c.partido_diputado?.abreviatura ? '<br>Dip: '+c.partido_diputado.abreviatura : ''}`));
          }
        });
      }
    } catch (err) { console.error(err); }
  }

  let rutaData = null;
  let rutaVisitados = new Set();
  let rutaVotados = new Set();
  let rutaIndiceActual = -1;
  let rutaMarkers = [];
  let rutaFlechas = [];
  let rutaTramos = [];
  let rutaPolylineLayer = null;
  let rutaOrigen = 'admin';

  async function loadRutas() {
    rutaOrigen = 'admin';
    const user = API.getUser();
    const puedeCrear = user?.rol === 'admin' || user?.rol === 'coordinador';
    document.getElementById('ruta-admin-section').classList.toggle('hidden', !puedeCrear);
    document.getElementById('ruta-enlace-section').classList.toggle('hidden', user?.rol !== 'enlace');
    document.getElementById('btn-volver-admin').classList.add('hidden');
    if (puedeCrear) await loadRutasAdmin();
    if (user?.rol === 'enlace') await loadRutasEnlace();
  }

  async function loadMiRuta() {
    detenerSeguimientoUbicacion();
    rutaOrigen = 'mi-ruta';
    document.getElementById('ruta-admin-section').classList.add('hidden');
    document.getElementById('ruta-enlace-section').classList.remove('hidden');
    document.getElementById('btn-volver-admin').classList.add('hidden');
    document.getElementById('ruta-enlace-detalle').classList.add('hidden');
    document.querySelectorAll('.ruta-enlace-tab-btn')[0]?.click();
    if (rutaPollTimer) { clearInterval(rutaPollTimer); rutaPollTimer = null; }
    await loadRutasEnlace();
  }

  let enlaceTipoFiltro = 'todos';

  async function loadRutasEnlace() {
    try {
      const rutas = await API.request('GET', '/api/rutas');
      const filtradas = enlaceTipoFiltro === 'todos' ? rutas : rutas.filter(r => r.tipo === enlaceTipoFiltro);
      const pendientes = filtradas.filter(r => r.estado !== 'completada');
      const completadas = filtradas.filter(r => r.estado === 'completada');

      const pendCont = document.getElementById('ruta-enlace-list');
      const compCont = document.getElementById('ruta-enlace-completadas-list');

      if (!rutas.length) {
        pendCont.innerHTML = '<p style="font-size:12px;color:#999;text-align:center">No tienes rutas asignadas aun</p>';
        compCont.innerHTML = '';
        document.getElementById('ruta-enlace-detalle').classList.add('hidden');
        return;
      }
      const filtroMsg = enlaceTipoFiltro !== 'todos' ? ` de ${tipoRutaLabel(enlaceTipoFiltro)}` : '';

      if (pendientes.length) {
        const activa = pendientes.find(r => r.estado === 'en_progreso') || pendientes[0];
        rutaActivaId = activa.id;
        pendCont.innerHTML = '';
        document.getElementById('ruta-enlace-detalle').classList.remove('hidden');
        mostrarDetalleRuta(activa, false, 'ruta');
      } else {
        pendCont.innerHTML = `<p style="font-size:12px;color:#999;text-align:center">No hay rutas pendientes${filtroMsg}</p>`;
        document.getElementById('ruta-enlace-detalle').classList.add('hidden');
        if (rutaMap) { rutaMap.remove(); rutaMap = null; }
      }

      if (completadas.length) {
        compCont.innerHTML = completadas.map(r => `<div onclick="verDetalleRuta('${r.id}')" style="cursor:pointer;background:#fff;border-radius:8px;padding:10px;box-shadow:var(--shadow);font-size:12px;transition:background 0.2s" onmouseenter="this.style.background='#f5f5f5'" onmouseleave="this.style.background='#fff'">
          <div style="display:flex;justify-content:space-between;align-items:center"><strong>Seccion ${r.seccion_num}</strong><span style="display:flex;gap:4px"><span class="badge" style="background:#eee;color:#333;font-size:10px">${tipoRutaLabel(r.tipo)}</span><span class="badge badge-yes" style="font-size:10px">Completada</span></span></div>
          <div style="color:#999;font-size:10px">${r.distancia_total_km} km · ${r.tiempo_total_minutos} min · ${new Date(r.creado_en).toLocaleDateString()}</div>
          <div style="color:var(--pri-green);font-size:10px">Completada: ${r.completado_en ? new Date(r.completado_en).toLocaleDateString() : ''}</div>
        </div>`).join('');

      } else {
        compCont.innerHTML = `<p style="font-size:12px;color:#999;text-align:center">No hay rutas completadas${filtroMsg}</p>`;
      }

      if (!rutaPollTimer) {
        rutaPollTimer = setInterval(async () => {
          try {
            const nuevas = await API.request('GET', '/api/rutas');
            const pend = nuevas.find(r => r.estado !== 'completada');
            if (pend && pend.id !== rutaActivaId) {
              rutaActivaId = pend.id;
              document.getElementById('ruta-enlace-detalle').classList.remove('hidden');
              mostrarDetalleRuta(pend, false, 'ruta');
              document.getElementById('ruta-enlace-list').innerHTML = '';
            }
          } catch (e) { console.warn(e); }
        }, 30000);
      }
    } catch (err) { console.error(err); }
  }

  let rutaCreandoSeccion = null;
  let rutaModalTipo = 'seguros';

  function tipoRutaLabel(t) { return t === 'encuesta' ? '📋 Encuesta' : '🛡 Seguros'; }

  window.setRutaModalTipo = function(tipo) {
    rutaModalTipo = tipo === 'encuesta' ? 'encuesta' : 'seguros';
    const bS = document.getElementById('ruta-modal-tipo-seguros');
    const bE = document.getElementById('ruta-modal-tipo-encuesta');
    if (!bS) return;
    bS.classList.toggle('btn-primary', rutaModalTipo === 'seguros');
    bS.classList.toggle('btn-secondary', rutaModalTipo !== 'seguros');
    bE.classList.toggle('btn-primary', rutaModalTipo === 'encuesta');
    bE.classList.toggle('btn-secondary', rutaModalTipo !== 'encuesta');
    const ayuda = document.getElementById('ruta-modal-tipo-ayuda');
    ayuda.textContent = rutaModalTipo === 'seguros'
      ? 'Visitar a los seguros (voto seguro) de la sección para confirmar sus datos y su voto.'
      : 'Visitar a todos los ciudadanos de la sección (sean simpatizantes o no) para aplicar la encuesta.';
    document.getElementById('ruta-modal-encuesta-opts').classList.toggle('hidden', rutaModalTipo !== 'encuesta');
  };

  async function loadRutasAdmin() {
    try {
      const secciones = await API.getSecciones();
      const enlaces = (await API.request('GET', '/api/usuarios')).filter(u => u.rol === 'enlace');
      const seccionesEnlaces = {};
      enlaces.forEach(e => { (e.secciones || []).forEach(s => { if (!seccionesEnlaces[s]) seccionesEnlaces[s] = []; seccionesEnlaces[s].push(e); }); });
      const container = document.getElementById('ruta-admin-secciones');
      const rutasExistentes = await API.request('GET', '/api/rutas');
      const rutasPorSec = {};
      rutasExistentes.forEach(r => { if (!rutasPorSec[r.seccion_num]) rutasPorSec[r.seccion_num] = []; rutasPorSec[r.seccion_num].push(r); });
      container.innerHTML = secciones.map(s => {
        const enl = seccionesEnlaces[s.id] || [];
        const secRutas = rutasPorSec[s.id] || [];
        const filaTipo = (tipo) => {
          const activas = secRutas.filter(r => r.tipo === tipo && r.estado !== 'completada');
          const completadas = secRutas.filter(r => r.tipo === tipo && r.estado === 'completada');
          return `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;background:#fafafa;border-radius:6px;padding:6px 8px">
            <div style="font-size:11px"><strong>${tipoRutaLabel(tipo)}</strong>
              ${activas.length ? `<span style="color:var(--pri-red)"> · ${activas.length} activa(s)</span>` : ''}
              ${completadas.length ? `<span style="color:var(--pri-green)"> · ${completadas.length} completada(s)</span>` : ''}
            </div>
            <button class="btn-small btn-primary" onclick="abrirModalRuta(${s.id},'${tipo}')" style="font-size:10px">+ Crear</button>
          </div>`;
        };
        return `<div style="background:#fff;border-radius:8px;padding:12px;box-shadow:var(--shadow);margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
            <div><strong style="font-size:14px">Seccion ${s.id}</strong> <span style="color:#999;font-size:11px">${s.municipio || ''}</span></div>
          </div>
          ${enl.length ? `<div style="font-size:11px;color:#666;margin-bottom:4px">Enlaces disponibles: ${enl.map(e => e.nombre).join(', ')}</div>` : '<div style="font-size:11px;color:#999">Sin enlaces asignados</div>'}
          ${enl.length ? filaTipo('encuesta') + filaTipo('seguros') : ''}
        </div>`;
      }).join('');
    } catch (err) { console.error(err); }
  }

  window.abrirModalRuta = function(seccionId, tipoPreset) {
    rutaCreandoSeccion = seccionId;
    document.getElementById('ruta-modal-sec').textContent = seccionId;
    setRutaModalTipo(tipoPreset || 'seguros');
    document.getElementById('ruta-modal-status').textContent = '';
    document.getElementById('ruta-modal-status').style.color = '';
    const cont = document.getElementById('ruta-modal-enlaces');
    cont.innerHTML = '<p style="font-size:11px;color:#999">Cargando enlaces...</p>';
    document.getElementById('ruta-modal-crear').classList.remove('hidden');
    API.request('GET', '/api/usuarios').then(usuarios => {
      const enlaces = usuarios.filter(u => u.rol === 'enlace' && (u.secciones || []).includes(seccionId));
      cont.innerHTML = enlaces.length ? enlaces.map(e => `<label style="display:inline-flex;align-items:center;gap:4px;padding:4px 8px;margin:2px;font-size:12px;cursor:pointer;border:1px solid #ddd;border-radius:4px;background:#f5f5f5;white-space:nowrap"><input type="checkbox" class="ruta-enlace-cb" value="${e.id}"> ${e.nombre}</label>`).join('')
        : '<p style="font-size:11px;color:#999">No hay enlaces con esta seccion</p>';
    }).catch(() => { cont.innerHTML = '<p style="font-size:11px;color:var(--pri-red)">Error al cargar</p>'; });
    const selEnc = document.getElementById('ruta-modal-encuesta');
    selEnc.innerHTML = '<option value="">Sin encuesta</option>';
    API.getCampanas().then(campanas => {
      (campanas || []).filter(c => c.tipo === 'encuesta' && c.encuesta_lanzada)
        .forEach(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.nombre + ' (lanzada)'; selEnc.appendChild(o); });
      (campanas || []).filter(c => c.tipo === 'encuesta' && !c.encuesta_lanzada)
        .forEach(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.nombre; selEnc.appendChild(o); });
    }).catch(() => {});
    document.getElementById('btn-crear-ruta-confirmar').onclick = async () => {
      const selected = [...document.querySelectorAll('.ruta-enlace-cb:checked')].map(cb => cb.value);
      if (!selected.length) { document.getElementById('ruta-modal-status').textContent = 'Selecciona al menos un enlace'; return; }
      const encuestaId = rutaModalTipo === 'encuesta' ? (document.getElementById('ruta-modal-encuesta').value || null) : null;
      const status = document.getElementById('ruta-modal-status');
      try {
        status.textContent = 'Creando rutas...';
        await API.request('POST', '/api/rutas', { enlace_ids: selected, seccion_id: seccionId, tipo: rutaModalTipo, encuesta_campana_id: encuestaId });
        status.textContent = `Ruta ${tipoRutaLabel(rutaModalTipo)} creada para ${selected.length} enlace(s)`;
        status.style.color = 'var(--pri-green)';
        setTimeout(() => { document.getElementById('ruta-modal-crear').classList.add('hidden'); loadRutasAdmin(); }, 1000);
      } catch (e) { status.textContent = 'Error: ' + e.message; status.style.color = 'var(--pri-red)'; }
    };
  };

  async function renderRutasAdmin(rutas) {
    try {
      if (!rutas) rutas = await API.request('GET', '/api/rutas');
      const completadas = rutas.filter(r => r.estado === 'completada');
      const cont = document.getElementById('ruta-admin-list');
      if (!completadas.length) { cont.innerHTML = '<p style="font-size:12px;color:#999;text-align:center">No hay rutas completadas</p>'; return; }
      cont.innerHTML = completadas.map(r => `<div style="display:flex;align-items:center;gap:4px;margin-bottom:4px">
        <div onclick="verDetalleRuta('${r.id}')" style="cursor:pointer;flex:1;background:#fff;border-radius:8px;padding:10px;box-shadow:var(--shadow);font-size:12px;transition:background 0.2s" onmouseenter="this.style.background='#f5f5f5'" onmouseleave="this.style.background='#fff'">
          <div style="display:flex;justify-content:space-between;align-items:center"><strong>${r.enlace_nombre}</strong><span style="display:flex;gap:4px"><span class="badge" style="background:#eee;color:#333;font-size:10px">${tipoRutaLabel(r.tipo)}</span><span class="badge badge-yes" style="font-size:10px">Completada</span></span></div>
          <div style="color:#666">Seccion ${r.seccion_num}</div>
          <div style="color:#999;font-size:10px">${r.distancia_total_km} km · ${r.tiempo_total_minutos} min · ${new Date(r.creado_en).toLocaleDateString()}</div>
          <div style="color:var(--pri-green);font-size:10px;margin-top:2px">Completada: ${r.completado_en ? new Date(r.completado_en).toLocaleDateString() : ''}</div>
        </div>
        <button class="btn-small" style="font-size:16px;color:var(--pri-red);padding:4px 8px;flex-shrink:0" onclick="confirmAsync('Eliminar esta ruta?').then(yes=>{if(yes){API.request('DELETE','/api/rutas/${r.id}').then(()=>loadRutasAdmin()).catch(e=>notify('Error:'+e.message,'error'))}})">×</button>
      </div>`).join('');
    } catch (err) { console.error(err); }
  }
  window.verDetalleRuta = async function(rutaId) {
    try {
      const ruta = await API.request('GET', '/api/rutas/' + rutaId);
      document.getElementById('ruta-admin-section').classList.add('hidden');
      document.getElementById('ruta-enlace-section').classList.remove('hidden');
      document.getElementById('ruta-enlace-detalle').classList.remove('hidden');
      if (rutaOrigen !== 'mi-ruta') document.getElementById('btn-volver-admin').classList.remove('hidden');
      mostrarDetalleRuta(ruta, true, 'ruta');
    } catch (err) { console.error(err); }
  };

  let rutaPollTimer = null;
  let rutaActivaId = null;
  let rutaReadOnly = false;
  let rutaFull = null;
  let votacionEstado = null;

  async function obtenerEstadoVotacion() {
    if (!window._votacionEstado || Date.now() - (window._votacionEstado_t || 0) > 60000) {
      window._votacionEstado = await API.request('GET', '/api/reportes/votacion-estado').catch(() => ({ fecha: null, activa: false }));
      window._votacionEstado_t = Date.now();
    }
    return window._votacionEstado;
  }

  let rutaPrefix = 'ruta';

  async function mostrarDetalleRuta(ruta, readOnly, prefix) {
    rutaReadOnly = readOnly;
    rutaPrefix = prefix || 'ruta';
    rutaFull = ruta;
    rutaData = { paradas: ruta.paradas || [], distancia_total_km: ruta.distancia_total_km, tiempo_total_minutos: ruta.tiempo_total_minutos };
    votacionEstado = await obtenerEstadoVotacion();
    if (ruta.estado === 'completada' && !(ruta.paradas || []).some(p => p.visitado)) {
      (ruta.paradas || []).forEach(p => p.visitado = true);
    }
    rutaVisitados = new Set((ruta.paradas || []).filter(p => p.visitado).map(p => p.id));
    rutaVotados = new Set((ruta.paradas || []).filter(p => p.ya_voto).map(p => p.id));
    rutaIndiceActual = -1;
    if (!readOnly) {
      try {
        await API.request('PATCH', '/api/rutas/' + ruta.id + '/estado', { estado: 'en_progreso' });
      } catch (e) { console.warn(e); }
    }
    const total = rutaData.paradas.length;
    document.getElementById(rutaPrefix + '-info').innerHTML = `
      <div style="background:#fff;border-radius:8px;padding:8px;text-align:center;box-shadow:var(--shadow)">
        <div style="font-size:12px;font-weight:700;color:${ruta.tipo === 'encuesta' ? '#0066cc' : '#8a6d00'}">${tipoRutaLabel(ruta.tipo)}</div>
        <div style="font-size:11px;color:#999">Tipo</div>
      </div>
      <div style="background:#fff;border-radius:8px;padding:8px;text-align:center;box-shadow:var(--shadow)">
        <div style="font-size:20px;font-weight:700;color:var(--pri-red)">${ruta.distancia_total_km} km</div>
        <div style="font-size:11px;color:#999">Distancia</div>
      </div>
      <div style="background:#fff;border-radius:8px;padding:8px;text-align:center;box-shadow:var(--shadow)">
        <div style="font-size:20px;font-weight:700;color:var(--pri-red)">${ruta.tiempo_total_minutos} min</div>
        <div style="font-size:11px;color:#999">Tiempo</div>
      </div>
      <div style="background:#fff;border-radius:8px;padding:8px;text-align:center;box-shadow:var(--shadow)">
        <div style="font-size:20px;font-weight:700;color:var(--pri-red)" id="${rutaPrefix}-total-paradas">${total}</div>
        <div style="font-size:11px;color:#999">Paradas</div>
      </div>`;
    rutaMarkers = [];
    rutaTramos = [];
    rutaPolylineLayer = null;
    rutaFlechas.forEach(f => { try { if (rutaMap) rutaMap.removeLayer(f); } catch (e) {} });
    rutaFlechas = [];
    const mapId = rutaPrefix + '-map';
    if (rutaMap) rutaMap.remove();
    rutaMap = L.map(mapId, { maxZoom: 19 }).setView([20.6434, -100.9929], 13);
    crearTileLayer({ maxNativeZoom: 19 }).addTo(rutaMap);
    activarPrefetchMapa(rutaMap);

    // Add seccion polygon if available
    if (ruta.seccion_num || ruta.seccion_id) {
      const secId = ruta.seccion_num || ruta.seccion_id;
      API.getSecciones().then(secciones => {
        const sec = secciones.find(s => s.id === secId);
        if (sec?.municipio_id) {
          API.getGeometrias(sec.municipio_id).then(data => {
            const feat = data.features?.find(f => Math.round(f.properties.seccion) === secId);
            if (feat && rutaMap) {
              L.geoJSON(feat, {
                style: { fillColor: '#3388ff', fillOpacity: 0.06, color: '#3388ff', weight: 1, dashArray: '4 4' }
              }).addTo(rutaMap);
            }
          }).catch(e => console.warn(e));
        }
      });
    }
    rutaData.paradas.forEach((p, i) => {
      const dir = [p.direccion, p.colonia].filter(Boolean).join(', ') || 'Sin direccion';
      const visitadoLabel = rutaVisitados.has(p.id) ? '✓ Visitado' : 'No visitado';
      const tieneEncuesta = rutaFull && rutaFull.encuesta_campana_id && rutaFull.encuesta_lanzada;
      const encBtn = tieneEncuesta ? `<button class="btn-small btn-secondary" style="margin-top:4px;width:100%;font-size:11px" onclick="abrirEncuestaCiudadano('${p.id}','${(p.nombre||'').replace(/'/g,"\\'")}','${rutaFull.encuesta_campana_id}')">📋 Encuesta</button>` : '';
      const marker = L.circleMarker([p.ubicacion.lat, p.ubicacion.lng], {
        radius: 10, fillColor: p.es_simpatizante ? C_SECONDARY : C_PRIMARY, color: '#fff', weight: 3, fillOpacity: 0.9
      }).addTo(rutaMap).bindPopup(`
        <div style="min-width:160px">
          <b>#${i+1} ${p.nombre}</b>
          <div style="font-size:11px;color:#555;margin:3px 0">${dir}</div>
          <div style="font-size:11px;color:#555">Tel: ${p.telefono || '-'}</div>
          <div style="margin-top:3px;display:flex;gap:3px;flex-wrap:wrap">
            <span class="badge ${p.es_simpatizante?'badge-yes':'badge-no'}" style="font-size:10px">${p.es_simpatizante?'Simp':'No simp'}</span>
            <span class="badge" style="background:#eee;color:#333;font-size:10px">Prioridad: ${p.prioridad||0}</span>
          </div>
          <div style="font-size:11px;color:#666;margin-top:3px">${visitadoLabel} ${p.gps_confirmado ? '· GPS ✓' : p.evidencia ? '· Foto ✓' : ''}</div>
          <button class="btn-small ${rutaVisitados.has(p.id)?'btn-primary':'btn-secondary'}" style="margin-top:4px;width:100%;font-size:11px" onclick="toggleVisitado('${p.id}',${i})">
            ${rutaVisitados.has(p.id) ? '✓ Visitado' : 'Marcar visitado'}
          </button>
          ${encBtn}
        </div>`);
      marker.bindTooltip(`#${i+1}`, {permanent:true,direction:'center',className:'ruta-marker-label'});
      const activarTooltipParada = () => {
        const tooltipEl = marker.getTooltip()?.getElement();
        if (!tooltipEl || tooltipEl.__rutaParadaClick) return;
        tooltipEl.__rutaParadaClick = true;
        tooltipEl.style.pointerEvents = 'auto';
        tooltipEl.style.cursor = 'pointer';
        tooltipEl.style.zIndex = '1000';
        const abrir = function(ev) { if (ev) ev.stopPropagation(); marker.openPopup(); };
        tooltipEl.addEventListener('click', abrir);
        tooltipEl.addEventListener('touchend', abrir);
      };
      activarTooltipParada();
      marker.on('tooltipopen', activarTooltipParada);
      rutaMarkers.push(marker);
    });

    // Línea de ruta por tramos con flechas de dirección (OSRM)
    if (rutaData.paradas.length > 1) {
      const polyGuardado = Array.isArray(ruta.polyline) && ruta.polyline.length > 1 ? ruta.polyline : null;
      if (polyGuardado) {
        rutaTramos = dividirTramos(polyGuardado, rutaData.paradas);
      } else {
        const puntos = rutaData.paradas.map(p => [p.ubicacion.lat, p.ubicacion.lng]);
        rutaTramos = [];
        for (let j = 0; j < puntos.length - 1; j++) rutaTramos.push([puntos[j], puntos[j + 1]]);
      }
      dibujarTramoActual();
    }
    if (rutaReadOnly) {
      document.getElementById('ruta-siguiente-parada').classList.add('hidden');
      document.getElementById('ruta-progress').classList.add('hidden');
      document.getElementById('btn-cerrar-ruta').classList.add('hidden');
    } else {
      document.getElementById('btn-cerrar-ruta').classList.remove('hidden');
    }
    if (rutaData.paradas.length) {
      const grupo = L.featureGroup(rutaMarkers);
      const bounds = grupo.getBounds();
      if (Array.isArray(ruta.polyline) && ruta.polyline.length > 1) {
        ruta.polyline.forEach(c => { bounds.extend([c[0], c[1]]); });
      }
      rutaMap.fitBounds(bounds.pad(0.15));
    }
    setTimeout(() => { if (rutaMap) rutaMap.invalidateSize(); }, 300);
    renderParadas();
    if (!readOnly) iniciarSeguimientoUbicacion();
  }

  function dividirTramos(geo, paradas) {
    const cortes = paradas.map(p => indiceMasCercano(geo, p.ubicacion.lat, p.ubicacion.lng));
    const tramos = [];
    for (let j = 0; j < paradas.length - 1; j++) {
      const ini = cortes[j], fin = cortes[j + 1];
      const tramo = ini <= fin ? geo.slice(ini, fin + 1) : geo.slice(fin, ini + 1).reverse();
      if (tramo.length >= 2) tramos.push(tramo.map(c => [c[0], c[1]]));
    }
    return tramos;
  }

  function indiceMasCercano(geo, lat, lng) {
    let best = 0, bestDist = Infinity;
    for (let i = 0; i < geo.length; i++) {
      const dLat = geo[i][0] - lat, dLng = geo[i][1] - lng;
      const d = dLat * dLat + dLng * dLng;
      if (d < bestDist) { bestDist = d; best = i; }
    }
    return best;
  }

  function dibujarTramoActual() {
    if (!rutaMap) return;
    rutaPolylineLayer?.remove();
    rutaPolylineLayer = null;
    rutaFlechas.forEach(f => { try { if (rutaMap) rutaMap.removeLayer(f); } catch (e) {} });
    rutaFlechas = [];
    if (!rutaTramos.length) return;
    let ultimaVisitada = -1;
    rutaData.paradas.forEach((p, i) => { if (rutaVisitados.has(p.id)) ultimaVisitada = i; });
    const idxTramo = Math.max(0, ultimaVisitada);
    const tramo = rutaTramos[idxTramo];
    if (!tramo) return;
    rutaPolylineLayer = L.polyline(tramo, { color: '#009639', weight: 4, opacity: 0.8 }).addTo(rutaMap);
    const nFlechas = Math.min(4, Math.max(1, Math.floor(tramo.length / 6)));
    for (let i = 0; i < nFlechas; i++) {
      const idx = Math.floor((i + 0.5) * (tramo.length - 1) / nFlechas);
      const a = tramo[Math.max(0, idx - 1)], b = tramo[Math.min(tramo.length - 1, idx + 1)];
      const ang = Math.atan2(-(b[0] - a[0]), b[1] - a[1]) * 180 / Math.PI;
      rutaFlechas.push(crearFlechaRuta(tramo[idx][0], tramo[idx][1], ang));
    }
  }

  function crearFlechaRuta(lat, lng, ang) {
    return L.marker([lat, lng], {
      interactive: false,
      icon: L.divIcon({
        className: 'ruta-flecha-icon',
        html: `<div style="transform:rotate(${ang}deg)">➤</div>`,
        iconSize: [22, 22], iconAnchor: [11, 11]
      })
    }).addTo(rutaMap);
  }

  function distanciaGPS(lat1, lon1, lat2, lon2) {
    const R = 6371e3; const dLat = (lat2-lat1)*Math.PI/180; const dLon = (lon2-lon1)*Math.PI/180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  }

  async function tomarFoto() {
    return new Promise(resolve => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment';
      inp.onchange = async e => {
        const f = e.target.files?.[0];
        if (!f) { resolve(null); return; }
        const r = new FileReader();
        r.onload = async () => {
          try {
            const res = await API.uploadImage(r.result);
            resolve(res?.url || null);
          } catch {
            resolve(r.result);
          }
        };
        r.readAsDataURL(f);
      };
      inp.click();
    });
  }

  async function persistirParada(idx, visitado, gps_confirmado, evidencia) {
    if (!rutaActivaId) return;
    const body = { visitado, gps_confirmado };
    if (evidencia !== undefined) body.evidencia = evidencia;
    try { await API.request('PATCH', `/api/rutas/${rutaActivaId}/parada/${idx}`, body); } catch (e) {
      console.warn(e);
      await agregarAOfflineQueue({ type: 'marcarVisita', data: { rutaId: rutaActivaId, idx, body } });
    }
  }

  window.toggleVisitado = async function(id, idx) {
    if (!rutaData) return;
    const p = rutaData.paradas[idx]; if (!p) return;
    if (rutaVisitados.has(id)) {
      rutaVisitados.delete(id); renderParadas(); actualizarMarkerPopup(idx);
      persistirParada(idx, false, false, null); p.evidencia = null; dibujarTramoActual(); return;
    }

    async function tomarEvidenciaForzada() {
      while (true) {
        const foto = await tomarFoto();
        if (foto) return foto;
        alert('Debe tomar una foto como evidencia para marcar la visita.');
      }
    }

    async function marcar(gpsOk) {
      let evidencia = null;
      if (!gpsOk) {
        evidencia = await tomarEvidenciaForzada();
      }
      if (evidencia) p.evidencia = evidencia;
      rutaVisitados.add(id);
      persistirParada(idx, true, gpsOk, evidencia);
      renderParadas();
      actualizarMarkerPopup(idx);
      dibujarTramoActual();
      if (rutaActivaId && rutaData.paradas.every(x => rutaVisitados.has(x.id))) completarRuta();
    }

    if (!navigator.geolocation) {
      alert('GPS no disponible. Debe tomar una foto como evidencia.');
      marcar(false); return;
    }
    navigator.geolocation.getCurrentPosition(
      pos => {
        const dist = distanciaGPS(pos.coords.latitude, pos.coords.longitude, p.ubicacion.lat, p.ubicacion.lng);
        if (dist <= 100) marcar(true);
        else if (confirm('Estas a ' + Math.round(dist) + 'm del domicilio. ¿Marcar como visitado de todas formas? Debera tomar foto como evidencia.')) marcar(false);
      },
      async () => {
        alert('No se pudo obtener la ubicacion GPS. Debe tomar una foto como evidencia.');
        await marcar(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  window.marcarParadaVoto = async function(id) {
    if (!rutaFull) return;
    if (!(votacionEstado?.activa)) {
      const msg = votacionEstado?.fecha ? `Solo se registran votos el día de la elección (${votacionEstado.fecha})` : 'Configura el día de la elección para habilitar este botón';
      alert(msg); return;
    }
    if (rutaVotados.has(id)) { alert('Esta persona ya está registrada como votante. Si fue un error, quita el toque en Casilla (Representante).'); return; }
    const tipo = rutaFull.tipo === 'seguros' ? 'comprometido' : 'ciudadano';
    try {
      if (tipo === 'seguros') await API.marcarVoto(null, id);
      else await API.marcarVoto(id, null);
      rutaVotados.add(id);
      renderParadas();
    } catch (err) { alert('Error al registrar el voto: ' + (err?.message || err)); }
  };

  async function completarRuta() {
    if (!rutaActivaId) return;
    try { await API.request('PATCH', '/api/rutas/' + rutaActivaId + '/estado', { estado: 'completada' }); } catch (e) {
      console.warn(e);
      await agregarAOfflineQueue({ type: 'completarRuta', data: { rutaId: rutaActivaId } });
    }
    detenerSeguimientoUbicacion();
  }

  function iniciarSeguimientoUbicacion() {
    detenerSeguimientoUbicacion();
    if (!navigator.geolocation) return;
    const onPosition = pos => {
      const lat = pos.coords.latitude, lng = pos.coords.longitude;
      API.enviarUbicacion(lat, lng, pos.coords.accuracy).catch(e => console.warn(e));
      if (!rutaMap) return;
      if (rutaGpsMarker) {
        rutaGpsMarker.setLatLng([lat, lng]);
      } else {
        rutaGpsMarker = L.circleMarker([lat, lng], {
          radius: 8, fillColor: '#2196F3', color: '#fff', weight: 3, fillOpacity: 0.9
        }).addTo(rutaMap).bindPopup('Tu ubicacion');
      }
    };
    rutaWatchId = navigator.geolocation.watchPosition(
      onPosition,
      () => {},
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
  }

  function detenerSeguimientoUbicacion() {
    if (rutaWatchId !== null) { navigator.geolocation.clearWatch(rutaWatchId); rutaWatchId = null; }
    if (rutaGpsMarker) {
      if (rutaMap && rutaGpsMarker._map === rutaMap) rutaMap.removeLayer(rutaGpsMarker);
      rutaGpsMarker = null;
    }
  }

  function actualizarMarkerPopup(idx) {
    const p = rutaData.paradas[idx]; if (!p) return;
    const id = p.id;
    rutaMarkers[idx]?.closePopup();
    const dir = [p.direccion, p.colonia].filter(Boolean).join(', ') || 'Sin direccion';
    const evidenciaHtml = p.evidencia ? `<div style="margin:4px 0"><img src="${fullUrl(p.evidencia)}" style="width:100%;max-height:100px;object-fit:cover;border-radius:4px;border:1px solid #ddd"></div>` : '';
    const visitadoLabel = rutaVisitados.has(id) ? '✓ Visitado' : 'No visitado';
    const tieneEncuesta = rutaFull && rutaFull.encuesta_campana_id && rutaFull.encuesta_lanzada;
    const encBtn = tieneEncuesta ? `<button class="btn-small btn-secondary" style="margin-top:4px;width:100%;font-size:11px" onclick="abrirEncuestaCiudadano('${id}','${(p.nombre||'').replace(/'/g,"\\'")}','${rutaFull.encuesta_campana_id}')">📋 Encuesta</button>` : '';
    rutaMarkers[idx]?.setPopupContent(`
      <div style="min-width:160px">
        <b>#${idx+1} ${p.nombre}</b>
        <div style="font-size:11px;color:#555;margin:3px 0">${dir}</div>
        <div style="font-size:11px;color:#555">Tel: ${p.telefono || '-'}</div>
        <div style="margin-top:3px;display:flex;gap:3px;flex-wrap:wrap">
          <span class="badge ${p.es_simpatizante?'badge-yes':'badge-no'}" style="font-size:10px">${p.es_simpatizante?'Simp':'No simp'}</span>
          <span class="badge" style="background:#eee;color:#333;font-size:10px">Prioridad: ${p.prioridad||0}</span>
        </div>
        <div style="font-size:11px;color:#666;margin-top:3px">${visitadoLabel} ${p.gps_confirmado ? '· GPS ✓' : p.evidencia ? '· Foto ✓' : ''}</div>
        ${evidenciaHtml}
        <button class="btn-small ${rutaVisitados.has(id)?'btn-primary':'btn-secondary'}" style="margin-top:4px;width:100%;font-size:11px" onclick="toggleVisitado('${id}',${idx})">
          ${rutaVisitados.has(id) ? '✓ Visitado' : 'Marcar visitado'}
        </button>
        ${encBtn}
      </div>`);
  }

  function renderParadas() {
    if (!rutaData) return;
    const p = rutaData.paradas;
    const visitados = p.filter(x => rutaVisitados.has(x.id)).length;
    const total = p.length;
    document.getElementById('ruta-progress').classList.remove('hidden');
    const pct = total > 0 ? Math.round(visitados/total*100) : 0;
    document.getElementById('ruta-progress').innerHTML = `Progreso: <strong>${visitados}</strong> de <strong>${total}</strong> visitados (${pct}%)`;
    document.getElementById('ruta-total-paradas').textContent = total;
    const noVisitado = p.findIndex(x => !rutaVisitados.has(x.id));
    const sigDiv = document.getElementById('ruta-siguiente-parada');
    if (noVisitado >= 0) {
      sigDiv.classList.remove('hidden');
      document.getElementById('ruta-actual-label').textContent = `Siguiente: #${noVisitado+1} ${p[noVisitado].nombre}`;
    } else { sigDiv.classList.add('hidden'); }
    document.getElementById('ruta-paradas').innerHTML = `<div style="display:flex;flex-direction:column;gap:3px;padding:4px">${
      p.map((s, i) => {
        const visit = rutaVisitados.has(s.id);
        const dir = [s.direccion, s.colonia].filter(Boolean).join(', ') || 'Sin direccion';
        const evThumb = s.evidencia ? `<div style="margin-top:4px"><img src="${fullUrl(s.evidencia)}" style="height:36px;width:36px;object-fit:cover;border-radius:4px;border:1px solid #ddd;cursor:pointer" onclick="event.stopPropagation();window.open('${fullUrl(s.evidencia)}','_blank')"></div>` : '';
        const gpsBadge = s.gps_confirmado ? '<span style="font-size:9px;color:var(--pri-green)">GPS ✓</span>' : s.evidencia ? '<span style="font-size:9px;color:#999">Foto</span>' : '';
        const simpLabel = s.es_simpatizante ? 'Simp' : 'No simp';
        const visitLabel = visit ? 'Visitado' : 'Pendiente';
        const tieneEncuesta = rutaFull && rutaFull.encuesta_campana_id && rutaFull.encuesta_lanzada;
        const encBtn = tieneEncuesta ? `<button class="btn-small btn-secondary" style="padding:2px 6px;font-size:9px;margin-top:2px" onclick="event.stopPropagation();abrirEncuestaCiudadano('${s.id}','${(s.nombre||'').replace(/'/g,"\\'")}','${rutaFull.encuesta_campana_id}')" title="Responder encuesta de esta parada">📋 Encuesta</button>` : '';
        const yaVoto = s.ya_voto || rutaVotados.has(s.id);
        const votoTxt = yaVoto ? '🗳 Ya votó' : '🗳 Ya votó?';
        let votoBtn = '';
        if (!rutaReadOnly) {
          if (votacionEstado?.activa) {
            votoBtn = `<button class="btn-small" style="padding:2px 6px;font-size:9px;margin-top:2px;background:${yaVoto?'var(--pri-green)':'#eee'};color:${yaVoto?'#fff':'#333'};border:none" onclick="event.stopPropagation();marcarParadaVoto('${s.id}')" title="Registrar voto en tiempo real">${votoTxt}</button>`;
          } else if (votacionEstado?.fecha) {
            votoBtn = `<button class="btn-small" style="padding:2px 6px;font-size:9px;margin-top:2px;background:#f3f3f3;color:#bbb;border:none;cursor:not-allowed" onclick="event.stopPropagation()" title="Solo se registran votos el día de la elección (${votacionEstado.fecha})">🗳 Elección ${votacionEstado.fecha.slice(5)}</button>`;
          }
        }
        return `<div class="ruta-parada-card ${visit?'ruta-parada-visitada':''}" onclick="irAParada(${i})">
          <div style="display:flex;align-items:center;gap:6px">
            <div style="width:24px;height:24px;border-radius:50%;background:${s.es_simpatizante?C_SECONDARY:C_PRIMARY};color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;flex-shrink:0">${i+1}</div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:13px">${s.nombre}</div>
              <div style="font-size:11px;color:#666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${dir} · ${s.telefono||'-'}</div>
              ${evThumb}
              ${encBtn}
              ${votoBtn}
            </div>
            <div style="display:flex;flex-direction:column;align-items:center;gap:2px">
              <span class="badge ${s.es_simpatizante?'badge-yes':'badge-no'}" style="font-size:9px">${simpLabel}</span>
              ${gpsBadge}
              <button class="btn-small ${visit?'btn-primary':'btn-secondary'}" data-id="${s.id}" style="padding:2px 6px;font-size:9px" onclick="event.stopPropagation();toggleVisitado('${s.id}',${i})" title="${visitLabel}">${visit?'✓':'○'}</button>
            </div>
          </div>
        </div>`;
      }).join('')}</div>`;
    const reporteDiv = document.getElementById('ruta-reporte');
    if (visitados === total && total > 0) {
      reporteDiv.classList.remove('hidden');
      const simp = p.filter(x => x.es_simpatizante && rutaVisitados.has(x.id)).length;
      const totalSimp = p.filter(x => x.es_simpatizante).length;
      const conGPS = p.filter(x => rutaVisitados.has(x.id) && x.gps_confirmado).length;
      const sinGPS = visitados - conGPS;
      const conEvidencia = p.filter(x => rutaVisitados.has(x.id) && x.evidencia);
      const fotosHtml = conEvidencia.length ? `<div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap;justify-content:center">${conEvidencia.map(x => `<img src="${fullUrl(x.evidencia)}" style="height:48px;width:48px;object-fit:cover;border-radius:4px;border:1px solid #ddd;cursor:pointer" onclick="window.open('${fullUrl(x.evidencia)}','_blank')">`).join('')}</div>` : '';
      reporteDiv.innerHTML = `<h3 style="margin:0 0 4px;color:var(--pri-green);font-size:14px">Recorrido completado</h3>
        <p style="font-size:13px;margin:0">Visitaste <strong>${visitados}</strong> de <strong>${total}</strong> domicilios</p>
        <p style="font-size:12px;color:#555;margin:2px 0">Simpatizantes: <strong>${simp}</strong> de <strong>${totalSimp}</strong></p>
        <p style="font-size:11px;color:#999;margin:2px 0">GPS confirmado: <strong style="color:var(--pri-green)">${conGPS}</strong> · Sin GPS: <strong style="color:var(--pri-red)">${sinGPS}</strong></p>
        <p style="font-size:11px;color:#999;margin:2px 0 0">${rutaData.distancia_total_km} km · ${rutaData.tiempo_total_minutos} min</p>
        ${fotosHtml}
        ${API.getUser()?.rol === 'enlace' ? '' : `<button class="btn-small btn-primary" onclick="abrirReporteDetallado()" style="margin-top:8px;font-size:11px">Ver reporte detallado</button>`}`;
    } else reporteDiv.classList.add('hidden');
  }

  window.abrirReporteDetallado = function() {
    const ruta = rutaFull;
    if (!ruta) return;
    const p = rutaData.paradas;
    const visitados = p.filter(x => rutaVisitados.has(x.id)).length;
    const total = p.length;
    const simp = p.filter(x => x.es_simpatizante && rutaVisitados.has(x.id)).length;
    const totalSimp = p.filter(x => x.es_simpatizante).length;
    const conGPS = p.filter(x => rutaVisitados.has(x.id) && x.gps_confirmado).length;
    const sinGPS = visitados - conGPS;
    const conEvidencia = p.filter(x => rutaVisitados.has(x.id) && x.evidencia);

    const filas = p.map((s, i) => {
      const visit = rutaVisitados.has(s.id);
      const simpLabel = s.es_simpatizante ? 'Si' : 'No';
      const gpsLabel = s.gps_confirmado ? 'Si' : (s.evidencia ? 'Foto' : 'No');
      const evThumb = s.evidencia ? `<img src="${fullUrl(s.evidencia)}" style="height:40px;width:40px;object-fit:cover;border-radius:4px;border:1px solid #ddd;cursor:pointer" onclick="window.open('${fullUrl(s.evidencia)}','_blank')">` : '-';
      return `<tr style="border-bottom:1px solid #eee;font-size:12px">
        <td style="padding:6px 4px;text-align:center"><strong>${i+1}</strong></td>
        <td style="padding:6px 4px">${s.nombre}</td>
        <td style="padding:6px 4px">${s.telefono || '-'}</td>
        <td style="padding:6px 4px">${[s.direccion, s.colonia].filter(Boolean).join(', ') || '-'}</td>
        <td style="padding:6px 4px;text-align:center">${simpLabel}</td>
        <td style="padding:6px 4px;text-align:center">${visit ? '✓' : '✗'}</td>
        <td style="padding:6px 4px;text-align:center">${gpsLabel}</td>
        <td style="padding:6px 4px;text-align:center">${evThumb}</td>
      </tr>`;
    }).join('');

    document.getElementById('reporte-detallado-body').innerHTML = `
      <div style="margin-bottom:12px;padding:10px;background:#f9f9f9;border-radius:8px;font-size:12px">
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          <span><strong>Enlace:</strong> ${ruta.enlace_nombre || '-'}</span>
          <span><strong>Seccion:</strong> ${ruta.seccion_num || '-'}</span>
          <span><strong>Fecha:</strong> ${ruta.creado_en ? new Date(ruta.creado_en).toLocaleDateString() : '-'}</span>
          <span><strong>Completada:</strong> ${ruta.completado_en ? new Date(ruta.completado_en).toLocaleDateString() : '-'}</span>
          <span><strong>Distancia:</strong> ${ruta.distancia_total_km} km</span>
          <span><strong>Tiempo:</strong> ${ruta.tiempo_total_minutos} min</span>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:11px">
          <thead><tr style="background:#f0f0f0;font-weight:600">
            <th style="padding:6px 4px;text-align:center">#</th>
            <th style="padding:6px 4px;text-align:left">Nombre</th>
            <th style="padding:6px 4px;text-align:left">Telefono</th>
            <th style="padding:6px 4px;text-align:left">Direccion</th>
            <th style="padding:6px 4px;text-align:center">Simp</th>
            <th style="padding:6px 4px;text-align:center">Visitado</th>
            <th style="padding:6px 4px;text-align:center">GPS</th>
            <th style="padding:6px 4px;text-align:center">Evidencia</th>
          </tr></thead>
          <tbody>${filas}</tbody>
        </table>
      </div>
      <div style="margin-top:12px;padding:10px;background:#f0faf0;border-radius:8px;font-size:12px;display:flex;gap:16px;flex-wrap:wrap">
        <span><strong>Visitados:</strong> ${visitados}/${total}</span>
        <span><strong>Simpatizantes:</strong> ${simp}/${totalSimp}</span>
        <span><strong>GPS OK:</strong> ${conGPS}</span>
        <span style="color:var(--pri-red)"><strong>Sin GPS:</strong> ${sinGPS}</span>
        <span><strong>Fotos:</strong> ${conEvidencia.length}</span>
      </div>`;
    document.getElementById('reporte-detallado-modal').classList.remove('hidden');

    document.getElementById('btn-exp-pdf').onclick = exportarPDF;
    document.getElementById('btn-exp-csv').onclick = exportarCSV;
  }

  window.exportarPDF = function() {
    const body = document.getElementById('reporte-detallado-body');
    const ancho = body.offsetWidth;
    const alto = body.scrollHeight;
    const ventana = window.open('', '_blank');
    ventana.document.write(`
      <html><head><title>Reporte de ruta</title>
      <style>
        body{font-family:Arial,sans-serif;margin:20px;font-size:12px}
        table{width:100%;border-collapse:collapse;margin:10px 0}
        th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;font-size:11px}
        th{background:#f0f0f0}
        .header{background:#f9f9f9;padding:10px;border-radius:6px;margin-bottom:10px}
        .header span{display:inline-block;margin-right:16px}
        .footer{background:#f0faf0;padding:10px;border-radius:6px}
        img{width:36px;height:36px;object-fit:cover;border-radius:3px}
      </style></head><body>
      <h2 style="margin:0 0 10px;font-size:16px">Reporte detallado de ruta</h2>
      ${body.innerHTML}
      <p style="margin-top:20px;color:#999;font-size:10px">Generado por Colmena - ${new Date().toLocaleString()}</p>
      <script>window.onload=function(){window.print();window.close()}<\/script>
    </body></html>`);
    ventana.document.close();
  }

  window.exportarCSV = function() {
    const ruta = rutaFull;
    if (!ruta || !rutaData) return;
    const p = rutaData.paradas;
    const BOM = '\uFEFF';
    const encabezados = ['#','Nombre','Telefono','Direccion','Colonia','Simpatizante','Visitado','GPS Confirmado','Evidencia'];
    const filas = p.map((s, i) => {
      const visit = rutaVisitados.has(s.id);
      const dir = (s.direccion || '').replace(/,/g, ';');
      const col = (s.colonia || '').replace(/,/g, ';');
      const nom = (s.nombre || '').replace(/,/g, ';');
      const tel = s.telefono || '';
      const simp = s.es_simpatizante ? 'Si' : 'No';
      const visitStr = visit ? 'Si' : 'No';
      const gpsStr = s.gps_confirmado ? 'Si' : (s.evidencia ? 'Foto' : 'No');
      const evidencia = s.evidencia ? 'Si' : 'No';
      return [i+1, nom, tel, dir, col, simp, visitStr, gpsStr, evidencia].join(',');
    }).join('\n');
    const csv = BOM + encabezados.join(',') + '\n' + filas;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `reporte_ruta_${ruta.seccion_num || 'desconocida'}_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function irAParada(idx) {
    if (!rutaData || !rutaMap || idx < 0 || idx >= rutaData.paradas.length) return;
    const p = rutaData.paradas[idx];
    rutaMap.setView([p.ubicacion.lat, p.ubicacion.lng], 18);
    if (rutaMarkers[idx]) rutaMarkers[idx].openPopup();
  }

  document.getElementById('btn-ir-siguiente')?.addEventListener('click', () => {
    if (!rutaData) return;
    const idx = rutaData.paradas.findIndex((x, i) => !rutaVisitados.has(x.id));
    if (idx >= 0) irAParada(idx);
  });

  document.getElementById('btn-volver-admin')?.addEventListener('click', () => {
    document.getElementById('btn-volver-admin').classList.add('hidden');
    document.getElementById('ruta-enlace-detalle').classList.add('hidden');
    if (rutaMap) { rutaMap.remove(); rutaMap = null; }
    document.getElementById('ruta-enlace-section').classList.add('hidden');
    if (rutaPollTimer) { clearInterval(rutaPollTimer); rutaPollTimer = null; }
    if (rutaOrigen === 'mi-ruta') {
      document.getElementById('ruta-admin-section').classList.add('hidden');
      document.getElementById('ruta-enlace-section').classList.remove('hidden');
      loadRutasEnlace();
    } else {
      document.getElementById('ruta-admin-section').classList.remove('hidden');
      document.querySelectorAll('.ruta-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.ruta-tab-content').forEach(c => c.classList.remove('active'));
      const secBtn = document.querySelector('.ruta-tab-btn[data-ruta-tab="secciones"]');
      if (secBtn) { secBtn.classList.add('active'); document.getElementById('ruta-tab-secciones')?.classList.add('active'); }
      loadRutasAdmin();
    }
  });

  document.getElementById('btn-cerrar-ruta')?.addEventListener('click', () => {
    rutaActivaId = null; rutaData = null; rutaVisitados = new Set(); rutaVotados = new Set();
    if (rutaMap) rutaMap.remove();
    document.getElementById('ruta-enlace-detalle').classList.add('hidden');
    loadRutasEnlace();
  });

  document.querySelectorAll('.ruta-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ruta-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.ruta-tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const tab = document.getElementById('ruta-tab-' + btn.dataset.rutaTab);
      if (tab) tab.classList.add('active');
    });
  });

  document.querySelectorAll('.ruta-enlace-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ruta-enlace-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.ruta-enlace-tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const tab = document.getElementById('ruta-enlace-tab-' + btn.dataset.enlaceTab);
      if (tab) tab.classList.add('active');
      const detalle = document.getElementById('ruta-enlace-detalle');
      if (btn.dataset.enlaceTab === 'pendientes') {
        if (!rutaActivaId) { detalle.classList.add('hidden'); }
      } else {
        detalle.classList.add('hidden');
      }
    });
  });

  document.querySelectorAll('#ruta-enlace-tipo-filtro .ruta-tipo-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      enlaceTipoFiltro = btn.dataset.tipoFiltro || 'todos';
      document.querySelectorAll('#ruta-enlace-tipo-filtro .ruta-tipo-btn').forEach(b => b.classList.toggle('active', b === btn));
      loadRutasEnlace();
    });
  });

  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => { if (rutaMap) rutaMap.invalidateSize(); }, 300);
  });

  window._vcList = [];
  window._vcListBf = [];
  let _vcPrefix = 'f';

  function actualizarBtnVotantesCasa() {
    const nf = Array.isArray(window._vcList) ? window._vcList.length : 0;
    const nb = Array.isArray(window._vcListBf) ? window._vcListBf.length : 0;
    const fb = document.getElementById('f-btn-vc'); if (fb) fb.textContent = `👥 Votantes de la casa${nf ? ` (${nf})` : ''}`;
    const bb = document.getElementById('bf-btn-vc'); if (bb) bb.textContent = `👥 Votantes de la casa${nb ? ` (${nb})` : ''}`;
  }

  function initVotantesCasaModal(list, extras) {
    const l = Array.isArray(list) ? list : [];
    window._vcList = l.length
      ? l.map(v => ({ nombre: v.nombre || '', partido_id: v.partido_id || null, partido_diputado_id: v.partido_diputado_id || null }))
      : Array.from({ length: extras }, () => ({ nombre: '', partido_id: null, partido_diputado_id: null }));
    actualizarBtnVotantesCasa();
  }

  window.abrirModalVotantesCasa = async function(prefix) {
    _vcPrefix = prefix || 'f';
    const cur = _vcPrefix === 'bf' ? (Array.isArray(window._vcListBf) ? window._vcListBf : []) : (Array.isArray(window._vcList) ? window._vcList : []);
    const input = document.getElementById(prefix + '-votantes_casa');
    const extras = Math.max(0, parseInt(input.value) || 0);
    const rowsArr = Array.from({ length: extras }, (_, i) => cur[i] || { nombre: '', partido_id: null, partido_diputado_id: null });
    if (_vcPrefix === 'bf') window._vcListBf = rowsArr; else window._vcList = rowsArr;
    const partidos = await API.getPartidos();
    const rows = rowsArr.map((v, i) => `
      <div class="vc-row" style="display:flex;gap:6px;align-items:center;padding:8px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;flex-wrap:wrap">
        <span style="font-size:12px;font-weight:bold;width:64px;flex:none">Votante ${i + 1}</span>
        <input class="vc-nombre" placeholder="Nombre (opcional)" value="${(v.nombre || '').replace(/"/g, '&quot;')}" style="flex:1;min-width:90px;font-size:12px">
        <select class="vc-p" style="flex:1;min-width:80px;font-size:12px"><option value="">Presidente: Sin definir</option>${partidos.map(p => `<option value="${p.id}" ${v.partido_id == p.id ? 'selected' : ''}>${p.abreviatura}</option>`).join('')}</select>
        <select class="vc-d" style="flex:1;min-width:80px;font-size:12px"><option value="">Diputado: Sin definir</option>${partidos.map(p => `<option value="${p.id}" ${v.partido_diputado_id == p.id ? 'selected' : ''}>${p.abreviatura}</option>`).join('')}</select>
      </div>`).join('');
    document.getElementById('vc-body').innerHTML = rows.length ? rows : '<p style="font-size:12px;color:#999;text-align:center">Aumenta "Votantes extra" para registrar a las demás personas de la casa</p>';
    document.getElementById('vc-casa-modal').classList.remove('hidden');
  };

  window.guardarVotantesCasa = function() {
    const arr = [...document.querySelectorAll('#vc-body .vc-row')].map(r => ({
      nombre: (r.querySelector('.vc-nombre').value || '').trim(),
      partido_id: r.querySelector('.vc-p').value ? parseInt(r.querySelector('.vc-p').value) : null,
      partido_diputado_id: r.querySelector('.vc-d').value ? parseInt(r.querySelector('.vc-d').value) : null
    }));
    if (_vcPrefix === 'bf') window._vcListBf = arr; else window._vcList = arr;
    actualizarBtnVotantesCasa();
    cerrarModal('vc');
  };

  window.abrirModal = async function(tipo, id) {
    if (tipo === 'ciudadano' || tipo === 'comprometido') _gpsUsed = false;
    const overlay = document.getElementById('modal-overlay');
    const title = document.getElementById('modal-title');
    const fields = document.getElementById('modal-fields');
    const submitBtn = document.getElementById('modal-submit');
    overlay.classList.remove('hidden');
    let data = {};

    if (id) {
      try {
        if (tipo === 'usuario') data = (await API.request('GET', '/api/usuarios')).find(u => u.id == id);
        else if (tipo === 'ciudadano') data = await API.getCiudadano(id);
        else if (tipo === 'comprometido') data = await API.getComprometido(id);
        else if (tipo === 'estado') data = (await API.getEstados()).find(e => e.id == id);
        else if (tipo === 'municipio') data = (await API.getMunicipios()).find(m => m.id == id);
        else if (tipo === 'seccion') data = (await API.getSecciones()).find(s => s.id == id);
        else if (tipo === 'evento') data = (await API.getEventos()).find(e => e.id == id);
        else if (tipo === 'partido') data = (await API.getPartidos()).find(p => p.id == id);
        else if (tipo === 'casilla') data = (await API.getCasillas()).find(c => c.id == id);
        else if (tipo === 'resultado') data = (await API.getResultados()).find(r => r.id == id);
      } catch (e) { console.warn('Error cargando ' + tipo + ':', e); }
      title.textContent = `Editar ${tipo}`;
    } else {
      title.textContent = `Nuevo ${tipo}`;
    }
    submitBtn.textContent = id ? 'Actualizar' : 'Guardar';
    submitBtn.dataset.editId = id || '';
    submitBtn.dataset.tipo = tipo;
    document.getElementById('modal-msg').textContent = '';
    fields.innerHTML = renderForm(tipo, data);
    await populateFormSelects(tipo, data);
    const telField = document.getElementById('f-telefono');
    if (telField) telField.addEventListener('input', function() { this.value = this.value.replace(/\D/g, '').slice(0, 10); });
    if (telField && tipo === 'ciudadano') {
      const warnDiv = document.createElement('div');
      warnDiv.id = 'dup-alerta';
      warnDiv.style.cssText = 'font-size:12px;color:var(--pri-red);min-height:16px;margin-top:2px;padding:0 2px';
      telField.parentElement.appendChild(warnDiv);
      let dupTimer = null;
      telField.addEventListener('input', function() {
        clearTimeout(dupTimer);
        warnDiv.textContent = '';
        const tel = this.value.trim();
        if (tel.length < 7) return;
        dupTimer = setTimeout(async () => {
          try {
            const r = await API.request('GET', '/api/ciudadanos/verificar-duplicado?telefono=' + encodeURIComponent(tel) + '&ignorar_id=' + (submitBtn.dataset.editId || ''));
            if (r.duplicado) {
              const co = (r.coincidencias || []).map(x => `${x.nombre} (Sec. ${x.seccion_id})`).join(', ');
              warnDiv.textContent = '⚠ Teléfono ya registrado: ' + co;
            }
          } catch (e) { console.warn(e); }
        }, 700);
      });
    }
    const edadField = document.getElementById('f-edad');
    if (edadField) edadField.addEventListener('input', function() { this.value = this.value.replace(/\D/g, '').slice(0, 3); });
    // Draggable map for citizen, comprometido, evento and casilla modals
    if (tipo === 'ciudadano' || tipo === 'comprometido' || tipo === 'evento' || tipo === 'casilla') {
      let mapaAjuste = null, marcadorAjuste = null;
      const btnMapa = document.getElementById('btn-mapa-modal');
      const contMapa = document.getElementById('f-mapa-container');
      const latField = document.getElementById('f-lat');
      const lngField = document.getElementById('f-lng');
      function secField() { return document.getElementById(tipo === 'casilla' ? 'f-seccion_id' : 'f-seccion'); }
      function initMapaAjuste() {
        if (mapaAjuste) return;
        const lat = parseFloat(latField?.value) || 20.6434;
        const lng = parseFloat(lngField?.value) || -100.9929;
        mapaAjuste = L.map(contMapa, { maxZoom: 19, zoomAnimation: false }).setView([lat, lng], 16);
        crearTileLayer({ maxNativeZoom: 19 }).addTo(mapaAjuste);
        activarPrefetchMapa(mapaAjuste);
        marcadorAjuste = L.marker([lat, lng], { draggable: true }).addTo(mapaAjuste);
        marcadorAjuste.on('dragend', function() {
          const p = marcadorAjuste.getLatLng();
          latField.value = p.lat.toFixed(6);
          lngField.value = p.lng.toFixed(6);
          if (tipo === 'evento') detectarSeccionEvento(p.lat, p.lng);
          if (tipo === 'casilla') detectarSeccionCasilla(p.lat, p.lng);
        });
        setTimeout(() => mapaAjuste.invalidateSize(), 100);
        resaltarSeccionEnMapaAjuste();
      }
      function detectarSeccionCasilla(lat, lng) {
        API.detectarSeccion(lat, lng).then(function(res) {
          const sel = secField();
          if (res.seccion && sel && [...sel.options].some(o => o.value == res.seccion)) {
            sel.value = res.seccion;
            resaltarSeccionEnMapaAjuste();
          }
        }).catch(function() {});
      }
      function detectarSeccionEvento(lat, lng) {
        const secAuto = document.getElementById('f-sec-auto');
        if (!secAuto) return;
        secAuto.textContent = 'Detectando sección...';
        secAuto.style.color = '#999';
        API.detectarSeccion(lat, lng).then(function(res) {
          const sel = document.getElementById('f-seccion');
          if (res.seccion && sel && [...sel.options].some(o => o.value == res.seccion)) {
            sel.value = res.seccion;
            secAuto.textContent = 'Sección detectada: ' + res.seccion;
            secAuto.style.color = 'var(--pri-green)';
            resaltarSeccionEnMapaAjuste();
          } else if (res.seccion) {
            secAuto.textContent = 'La sección ' + res.seccion + ' no está en la lista';
            secAuto.style.color = 'var(--pri-red)';
          } else {
            secAuto.textContent = 'No se encontró sección para estas coordenadas';
            secAuto.style.color = 'var(--pri-red)';
          }
        }).catch(function() {
          secAuto.textContent = 'Error al detectar sección';
          secAuto.style.color = 'var(--pri-red)';
        });
      }
      function resaltarSeccionEnMapaAjuste() {
        if (!mapaAjuste) return;
        if (window._mapaAjusteGeoLayer) { mapaAjuste.removeLayer(window._mapaAjusteGeoLayer); window._mapaAjusteGeoLayer = null; }
        var secId = secField()?.value;
        if (!secId) return;
        API.getSecciones().then(function(secciones) {
          var sec = secciones.find(function(s) { return s.id == secId; });
          if (sec?.municipio_id) {
            API.getGeometrias(sec.municipio_id).then(function(data) {
              var feat = data.features?.find(function(f) { return Math.round(f.properties.seccion) == secId; });
              if (feat && mapaAjuste) {
                window._mapaAjusteGeoLayer = L.geoJSON(feat, {
                  style: { fillColor: '#f5d0d0', fillOpacity: 0.12, color: '#e8a0a0', weight: 2, opacity: 0.8 }
                }).addTo(mapaAjuste);
                try { mapaAjuste.fitBounds(window._mapaAjusteGeoLayer.getBounds(), { padding: [40,40], maxZoom: 16, animate: false }); } catch (e) { console.warn(e); }
              }
            }).catch(function(e) { console.warn(e); });
          }
        }).catch(function(e) { console.warn(e); });
      }
      function onLatLngChange() {
        if (!mapaAjuste || !marcadorAjuste) return;
        const lat = parseFloat(latField?.value);
        const lng = parseFloat(lngField?.value);
        if (!isNaN(lat) && !isNaN(lng)) marcadorAjuste.setLatLng([lat, lng]);
      }
      latField?.addEventListener('input', onLatLngChange);
      latField?.addEventListener('change', onLatLngChange);
      lngField?.addEventListener('input', onLatLngChange);
      lngField?.addEventListener('change', onLatLngChange);
      btnMapa?.addEventListener('click', function() {
        const vis = contMapa.style.display;
        contMapa.style.display = vis === 'none' ? 'block' : 'none';
        if (vis === 'none') initMapaAjuste();
      });
      document.getElementById('f-seccion')?.addEventListener('change', function() {
        if (contMapa.style.display !== 'none') resaltarSeccionEnMapaAjuste();
      });
      document.getElementById('f-seccion_id')?.addEventListener('change', function() {
        if (contMapa.style.display !== 'none') resaltarSeccionEnMapaAjuste();
      });
      document.querySelector('#modal-form .gps-btn')?.addEventListener('click', function() {
        setTimeout(function() {
          if (mapaAjuste && marcadorAjuste) {
            const lt = parseFloat(latField?.value), ln = parseFloat(lngField?.value);
            if (!isNaN(lt) && !isNaN(ln)) {
              marcadorAjuste.setLatLng([lt, ln]);
              mapaAjuste.panTo([lt, ln]);
              if (tipo === 'casilla') detectarSeccionCasilla(lt, ln);
            }
          }
        }, 300);
      });
    }
  };

  window.cerrarModal = function(tipo) {
    if (tipo === 'plantilla') {
      document.getElementById('plantilla-modal')?.classList.add('hidden');
      document.getElementById('plantilla-id').value = '';
      document.getElementById('plantilla-nombre').value = '';
      document.getElementById('plantilla-cuerpo').value = '';
      document.getElementById('plantilla-modal-title').textContent = 'Nueva plantilla';
      _plantillaArchivos = [];
      renderArchivos();
    } else if (tipo === 'campana') {
      document.getElementById('campana-modal')?.classList.add('hidden');
      document.getElementById('campana-id').value = '';
      document.getElementById('campana-nombre').value = '';
      document.getElementById('campana-plantilla').value = '';
      document.getElementById('campana-preview-msg').textContent = '';
      document.getElementById('campana-fecha').value = '';
      document.getElementById('campana-enviar').checked = true;
      document.getElementById('campana-modal-title').textContent = 'Nueva campaña';
      window._campanaFiltrosCarrito = [];
      renderCarritoCampana();
    } else if (tipo === 'filtro') {
      document.getElementById('filtro-modal')?.classList.add('hidden');
    } else if (tipo === 'inc') {
      document.getElementById('inc-modal')?.classList.add('hidden');
    } else if (tipo === 'vc') {
      document.getElementById('vc-casa-modal')?.classList.add('hidden');
    } else {
      document.getElementById('modal-overlay')?.classList.add('hidden');
      // Cleanup draggable map in ciudadano modal
      const contMapa = document.getElementById('f-mapa-container');
      if (contMapa) contMapa.style.display = 'none';
    }
  };

  async function populateFormSelects(tipo, data) {
    if (tipo === 'usuario') {
      const estados = await API.getEstados();
      const eSel = document.getElementById('f-estado');
      const muniSel = document.getElementById('f-municipio_id');
      eSel.innerHTML = '<option value="">Seleccionar estado</option>' + estados.map(e => `<option value="${e.id}">${e.nombre}</option>`).join('');
      const secIds = new Set(data.secciones || []);
      async function cargarSecciones(muniId) {
        const cont = document.getElementById('f-secciones-container');
        cont.innerHTML = '<p style="color:#999;font-size:12px">Cargando secciones...</p>';
        const editId = document.getElementById('modal-submit').dataset.editId;
        const rol = document.getElementById('f-rol').value;
        const excluir = rol === 'coordinador' && editId ? editId : undefined;
        const url = `/api/secciones/${muniId}${excluir?'?excluir_usuario='+excluir:''}${rol === 'coordinador' ? (excluir?'&':'?')+'rol=coordinador' : ''}`;
        const secs = await API.request('GET', url);
        cont.innerHTML = secs.map(s => {
          const asignada = rol === 'coordinador' && s.asignada_a && s.asignada_a !== (editId || null);
          return `<label style="display:inline-flex;align-items:center;gap:3px;padding:3px 7px;margin:2px;font-size:12px;cursor:${asignada?'not-allowed':'pointer'};border:1px solid ${asignada?'#ffccc':'#ddd'};border-radius:4px;background:${asignada?'#fff0f0':'#f5f5f5'};white-space:nowrap;opacity:${asignada?'0.5':'1'}"><input type="checkbox" value="${s.id}" ${secIds.has(s.id)?'checked':''} ${asignada?'disabled':''}> ${s.id}${asignada?' (asignada)':''}</label>`;
        }).join('');
      }
      async function cargarMunicipios(estadoId) {
        muniSel.innerHTML = '<option value="">Sin municipio</option>';
        document.getElementById('f-secciones-container').innerHTML = '';
        if (!estadoId) return;
        const municipios = await API.getMunicipios(estadoId);
        muniSel.innerHTML = '<option value="">Sin municipio</option>' + municipios.map(m => `<option value="${m.id}">${m.nombre}</option>`).join('');
        if (data.municipio_id && municipios.some(m => m.id == data.municipio_id)) {
          muniSel.value = data.municipio_id;
          cargarSecciones(data.municipio_id);
        }
      }
      eSel.addEventListener('change', () => cargarMunicipios(eSel.value));
      if (data.municipio_id) {
        const sec = data.secciones?.[0];
        const munis = await API.getMunicipios();
        const muni = munis.find(m => m.id == data.municipio_id);
        if (muni) { eSel.value = muni.estado_id; await cargarMunicipios(muni.estado_id); }
      }
      muniSel.addEventListener('change', () => { if (muniSel.value) cargarSecciones(muniSel.value); else document.getElementById('f-secciones-container').innerHTML = ''; });
      document.getElementById('f-rol').addEventListener('change', function() {
        const muniReq = document.getElementById('muni-required');
        const secReq = document.getElementById('sec-required');
        if (this.value === 'admin') { muniReq.style.display = 'none'; secReq.style.display = 'none'; }
        else if (this.value === 'coordinador') { muniReq.style.display = 'inline'; secReq.style.display = 'none'; }
        else { muniReq.style.display = 'inline'; secReq.style.display = 'inline'; }
        const muniVal = document.getElementById('f-municipio_id').value;
        if (muniVal) cargarSecciones(parseInt(muniVal));
      });
    }
    if (tipo === 'municipio') {
      const sel = document.getElementById('f-estado_id');
      const estados = await API.getEstados();
      sel.innerHTML = estados.map(e => `<option value="${e.id}" ${e.id == (data.estado_id || 11) ? 'selected' : ''}>${e.nombre}</option>`).join('');
    }
    if (tipo === 'seccion') {
      const sel = document.getElementById('f-municipio_id');
      const municipios = await API.getMunicipios();
      sel.innerHTML = municipios.map(m => `<option value="${m.id}" ${m.id == (data.municipio_id || 11035) ? 'selected' : ''}>${m.nombre}</option>`).join('');
    }
    if (tipo === 'ciudadano' || tipo === 'comprometido') {
      const estados = await API.getEstados();
      const eSel = document.getElementById('f-estado');
      const muniSel = document.getElementById('f-municipio');
      const secSel = document.getElementById('f-seccion');
      eSel.innerHTML = estados.map(e => `<option value="${e.id}">${e.nombre}</option>`).join('');
      eSel.addEventListener('change', async () => {
        muniSel.innerHTML = '<option value="">Municipio</option>';
        secSel.innerHTML = '<option value="">Sección (auto-detectada)</option>';
        if (eSel.value) {
          const municipios = await API.getMunicipios(eSel.value);
          muniSel.innerHTML = '<option value="">Municipio</option>' + municipios.map(m => `<option value="${m.id}">${m.nombre}</option>`).join('');
        }
      });
      muniSel.addEventListener('change', async () => {
        secSel.innerHTML = '<option value="">Sección (auto-detectada)</option>';
        if (muniSel.value) {
          const secciones = await API.getSeccionesPorMunicipio(muniSel.value);
          secSel.innerHTML = '<option value="">Sección</option>' + secciones.map(s => `<option value="${s.id}">Sec. ${s.id}</option>`).join('');
        }
      });
      if (data.seccion_id) {
        const secciones = await API.getSecciones();
        const sec = secciones.find(s => s.id == data.seccion_id);
        const muniId = sec?.municipio_id;
        if (muniId) {
          const muni = (await API.getMunicipios()).find(m => m.id == muniId);
          const est = (await API.getEstados()).find(e => e.id == (muni?.estado_id || 11));
          if (est) eSel.value = est.id;
          eSel.dispatchEvent(new Event('change'));
          setTimeout(() => {
            muniSel.value = muniId;
            secSel.innerHTML = '<option value="">Sección</option>' + secciones.filter(s => s.municipio_id == muniId).map(s => `<option value="${s.id}" ${s.id == data.seccion_id ? 'selected' : ''}>Sec. ${s.id}</option>`).join('');
            secSel.value = data.seccion_id;
          }, 300);
        }
      } else {
        const estDefault = await API.getEstadoDefault();
        if (estDefault) {
          eSel.value = estDefault.id;
          eSel.dispatchEvent(new Event('change'));
          setTimeout(async () => {
            const muniDefault = await API.getMunicipioDefault();
            if (muniDefault && [...muniSel.options].some(o => o.value == muniDefault.id)) {
              muniSel.value = muniDefault.id;
              muniSel.dispatchEvent(new Event('change'));
            }
          }, 300);
        }
      }

      const partidos = await API.getPartidos();
      const favorito = partidos.find(p => p.es_favorito) || partidos[0] || null;
      const opts = '<option value="">Indeciso / Sin definir</option>' + partidos.map(p => `<option value="${p.id}">${p.abreviatura}${p.es_favorito ? ' ⭐' : ''}</option>`).join('');
      document.getElementById('f-intencion_voto_presidente').innerHTML = opts.replace('value=""', `value="" ${!data.intencion_voto_presidente && !favorito ? 'selected' : ''}`).replaceAll(`value="${data.intencion_voto_presidente}"`, `value="${data.intencion_voto_presidente}" selected`);
      document.getElementById('f-intencion_voto_diputado').innerHTML = opts.replace('value=""', `value="" ${!data.intencion_voto_diputado && !favorito ? 'selected' : ''}`).replaceAll(`value="${data.intencion_voto_diputado}"`, `value="${data.intencion_voto_diputado}" selected`);
      if (!data.intencion_voto_presidente && favorito) document.getElementById('f-intencion_voto_presidente').value = favorito.id;
      const simpatizanteEl = document.getElementById('f-simpatizante');
      if (simpatizanteEl) simpatizanteEl.addEventListener('change', function() {
        [document.getElementById('f-intencion_voto_presidente'), document.getElementById('f-intencion_voto_diputado')].forEach(s => {
          if (this.checked && favorito && !s.value) s.value = favorito.id;
        });
      });

      // Casilla: auto por cercanía con ajuste manual
      let casillasCache = [];
      try { casillasCache = await API.getCasillas(); } catch (e) { console.error(e); }
      async function cargarCasillasModal() {
        const casSel = document.getElementById('f-casilla');
        if (!casSel) return;
        const secSel = document.getElementById('f-seccion');
        const secId = secSel.value ? parseInt(secSel.value) : (data.seccion_id ? parseInt(data.seccion_id) : null);
        const deSec = secId ? casillasCache.filter(c => c.seccion_id === secId) : [];
        casSel.innerHTML = '<option value="">Auto-detectar</option>' + deSec.map(c => `<option value="${c.id}">${c.nombre}${c.meta_votos ? ' (meta ' + c.meta_votos + ')' : ''}</option>`).join('');
        const lat = parseFloat(document.getElementById('f-lat').value);
        const lng = parseFloat(document.getElementById('f-lng').value);
        if (data.casilla_id && deSec.some(c => c.id == data.casilla_id)) { casSel.value = data.casilla_id; }
        else if (deSec.length === 1) { casSel.value = deSec[0].id; }
        else if (deSec.length > 1 && !Number.isNaN(lat) && !Number.isNaN(lng)) {
          let mejor = null, mejorD = Infinity;
          deSec.forEach(c => {
            if (c.lat == null || c.lng == null) return;
            const d = Math.hypot(c.lat - lat, c.lng - lng);
            if (d < mejorD) { mejorD = d; mejor = c.id; }
          });
          if (mejor) casSel.value = mejor;
        }
      }
      document.getElementById('f-seccion').addEventListener('change', cargarCasillasModal);
      const casLat = document.getElementById('f-lat'), casLng = document.getElementById('f-lng');
      if (casLat) casLat.addEventListener('change', cargarCasillasModal);
      if (casLng) casLng.addEventListener('change', cargarCasillasModal);
      cargarCasillasModal();

      // Votantes extra en la casa: se capturan en modal dedicado (además del entrevistado)
      const vcInput = document.getElementById('f-votantes_casa');
      if (vcInput) {
        const extras = Math.max(0, parseInt(vcInput.value) || 0);
        initVotantesCasaModal(data.votantes_casa_list, extras);
      }

      // CP → colonia auto-suggest
      document.getElementById('f-cp').addEventListener('input', function() {
        const cp = this.value;
        const sug = document.getElementById('f-colonia-sug');
        const colInput = document.getElementById('f-colonia');
        if (cp.length !== 5 || !/^\d{5}$/.test(cp)) { sug.style.display = 'none'; return; }
        if (colInput.dataset.lastCp === cp) return;
        colInput.dataset.lastCp = cp;
        sug.innerHTML = '<div style="padding:6px;color:#999;font-size:12px">Buscando...</div>';
        sug.style.display = 'block';
        API.request('GET', '/api/cp/' + cp).then(d => {
          if (d.colonias?.length) {
            sug.innerHTML = d.colonias.map(c => '<div class="f-colonia-sug-item" data-val="' + c.replace(/"/g,'&quot;') + '" style="padding:6px 10px;cursor:pointer;border-bottom:1px solid #f0f0f0;font-size:13px">' + c + '</div>').join('');
          } else { sug.style.display = 'none'; }
        }).catch(() => { sug.style.display = 'none'; });
      });

      // 🔍 Auto-buscar dirección al escribir (debounce 800ms)
      window._geocodificarModal = async function() {
        const calle = document.getElementById('f-calle').value.trim();
        const numero = document.getElementById('f-numero').value.trim();
        const colonia = document.getElementById('f-colonia').value.trim();
        const cp = document.getElementById('f-cp').value.trim();
        const muniSel2 = document.getElementById('f-municipio');
        const estadoSel = document.getElementById('f-estado');
        const statusEl = document.getElementById('f-sec-auto');
        if (!calle) { statusEl.textContent = 'Escriba una calle'; statusEl.style.color = 'var(--pri-red)'; return; }
        const params = new URLSearchParams();
        params.set('format', 'json'); params.set('limit', '3'); params.set('countrycodes', 'MX');
        params.set('street', [calle, numero].filter(Boolean).join(' '));
        if (colonia) params.set('city', colonia);
        const muniNombre = muniSel2.options[muniSel2.selectedIndex]?.text;
        if (muniNombre && muniNombre !== 'Municipio') params.set('county', muniNombre);
        const estNombre = estadoSel.options[estadoSel.selectedIndex]?.text;
        if (estNombre) params.set('state', estNombre);
        statusEl.textContent = 'Buscando dirección...'; statusEl.style.color = '#999';
        try {
          const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`);
          const data = await res.json();
          if (!data.length) { statusEl.textContent = 'Dirección no encontrada'; statusEl.style.color = 'var(--pri-red)'; return; }
          const lat = parseFloat(data[0].lat), lng = parseFloat(data[0].lon);
          // Populate address from first result
          if (data[0].address) {
            const addr = data[0].address;
            if (addr.road) document.getElementById('f-calle').value = addr.road;
            if (addr.house_number) document.getElementById('f-numero').value = addr.house_number;
            const colVal = addr.suburb || addr.neighbourhood || addr.hamlet || addr.village || addr.town || '';
            if (colVal) document.getElementById('f-colonia').value = colVal;
          }
          if (!_gpsUsed) {
            document.getElementById('f-lat').value = lat;
            document.getElementById('f-lng').value = lng;
            detectarSeccionModal(lat, lng);
          }
          statusEl.textContent = 'Ubicación encontrada ✓';
          statusEl.style.color = 'var(--pri-green)';
        } catch { statusEl.textContent = 'Error al buscar'; statusEl.style.color = 'var(--pri-red)'; }
      };
      ['f-calle', 'f-numero', 'f-colonia'].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('input', function() {
          var calleVal = document.getElementById('f-calle').value.trim();
          if (calleVal.length < 3) return;
          debounce('geo-modal', window._geocodificarModal, 800);
        });
      });

      // GPS + auto-detect sección
      async function detectarSeccionModal(lat, lng) {
        const secSel2 = document.getElementById('f-seccion');
        const secAuto = document.getElementById('f-sec-auto');
        secAuto.textContent = 'Detectando sección...';
        try {
          const res = await API.detectarSeccion(lat, lng);
          const secciones = await API.getSecciones();
          if (res.seccion) {
            secSel2.value = res.seccion;
            secAuto.textContent = 'Sección detectada: ' + res.seccion;
            secAuto.style.color = 'var(--pri-green)';
            const secInfo = secciones.find(s => s.id === res.seccion);
            const muni = res.municipio_id || secInfo?.municipio_id;
            if (muni) {
              const muniSel3 = document.getElementById('f-municipio');
              muniSel3.value = muni;
              secSel2.innerHTML = '<option value="">Sección</option>' + secciones.filter(s => s.municipio_id == muni).map(s => `<option value="${s.id}" ${s.id == res.seccion ? 'selected' : ''}>Sec. ${s.id}</option>`).join('');
            }
          } else {
            secAuto.textContent = 'No se encontró sección para estas coordenadas';
            secAuto.style.color = 'var(--pri-red)';
          }
        } catch { secAuto.textContent = 'Error al detectar sección'; secAuto.style.color = 'var(--pri-red)'; }
      }

      const latInput = document.getElementById('f-lat');
      const lngInput = document.getElementById('f-lng');
      function onCoordsChange() {
        const lat = parseFloat(latInput.value);
        const lng = parseFloat(lngInput.value);
        if (lat && lng && (lat !== 20.6434 || lng !== -100.9929)) { _gpsUsed = true; detectarSeccionModal(lat, lng); }
      }
      latInput.addEventListener('change', onCoordsChange);
      lngInput.addEventListener('change', onCoordsChange);
      document.querySelector('#modal-form .gps-btn')?.addEventListener('click', function() {
        if ('geolocation' in navigator) {
          navigator.geolocation.getCurrentPosition(pos => {
          _gpsUsed = true;
          _gpsFixObtained = true;
            latInput.value = pos.coords.latitude.toFixed(6);
            lngInput.value = pos.coords.longitude.toFixed(6);
            onCoordsChange();
          }, () => {}, { enableHighAccuracy: true, timeout: 10000 });
        }
      });
    }
    if (tipo === 'evento') {
      const secciones = await API.getSecciones();
      const sel = document.getElementById('f-seccion');
      sel.innerHTML = secciones.map(s => `<option value="${s.id}">Sec. ${s.id} - ${s.municipio}</option>`).join('');
      const plantillas = await API.getPlantillasWhatsapp();
      const plantillaSel = document.getElementById('f-plantilla_id');
      plantillaSel.innerHTML = '<option value="">Sin plantilla</option>' + plantillas.map(p =>
        `<option value="${p.id}" ${p.id == (data.plantilla_id || '') ? 'selected' : ''}>${p.nombre}</option>`
      ).join('');
    }
    if (tipo === 'casilla' || tipo === 'resultado') {
      const secSel = document.getElementById('f-seccion_id');
      const secciones = await API.getSecciones();
      secSel.innerHTML = secciones.map(s => `<option value="${s.id}" ${s.id == (data.seccion_id || '') ? 'selected' : ''}>Sec. ${s.id} - ${s.municipio}</option>`).join('');
    }
    if (tipo === 'resultado') {
      const parSel = document.getElementById('f-partido_id');
      const partidos = await API.getPartidos();
      parSel.innerHTML = partidos.map(p => `<option value="${p.id}" ${p.id == (data.partido_id || '') ? 'selected' : ''}>${p.abreviatura}</option>`).join('');
    }
  }

  function renderForm(tipo, data) {
    if (tipo === 'usuario') return `
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <div style="flex:1;min-width:220px">
          <input type="text" id="f-nombre" placeholder="Nombre completo" value="${data.nombre || ''}" required>
          <input type="email" id="f-email" placeholder="Correo electronico" value="${data.email || ''}" required>
          <input type="text" id="f-username" placeholder="Usuario (apodo para login)" value="${data.username || ''}">
          <div class="form-row"><input type="tel" id="f-telefono" placeholder="Telefono (para notificaciones)" value="${data.telefono || ''}" style="flex:2">
          <input type="password" id="f-password" placeholder="${data.id ? 'Nueva (dejar vacio si no cambia)' : 'Contrasena'}" ${data.id ? '' : 'required'} style="flex:2"></div>
          <div class="form-row"><label style="flex:1">Rol<select id="f-rol" style="width:100%"><option value="enlace" ${data.rol==='enlace'?'selected':''}>Enlace de Campo</option><option value="coordinador" ${data.rol==='coordinador'?'selected':''}>Coordinador</option><option value="admin" ${data.rol==='admin'?'selected':''}>Administrador</option></select></label>
          <label style="flex:1">Estado<select id="f-estado" style="width:100%"><option value="">Seleccionar estado</option></select></label></div>
          <label>Municipio <span id="muni-required" style="color:var(--pri-red);display:${!data.rol||data.rol==='admin'?'none':'inline'}">*</span></label><select id="f-municipio_id"><option value="">Sin municipio</option></select>
        </div>
        <div style="flex:0 0 260px">
          <label>Secciones asignadas <span id="sec-required" style="color:var(--pri-red);display:${data.rol==='enlace'?'inline':'none'}">*</span></label><div id="f-secciones-container" style="max-height:280px;overflow-y:auto;border:1px solid #ddd;border-radius:6px;padding:6px;display:flex;flex-wrap:wrap;gap:2px;align-content:flex-start"></div>
        </div>
      </div>
      <p style="font-size:11px;color:#999;margin:4px 0 0">Selecciona el municipio primero para ver las secciones disponibles</p>`;
    if (tipo === 'estado') return `
      <label>ID</label><input type="number" id="f-id" value="${data.id || ''}" ${data.id ? 'readonly' : 'required'}>
      <label>Nombre</label><input type="text" id="f-nombre" value="${data.nombre || ''}" required>
      <label>Abreviatura</label><input type="text" id="f-abreviatura" value="${data.abreviatura || ''}" maxlength="10">
      <label class="checkbox-line"><input type="checkbox" id="f-es_default" ${data.es_default ? 'checked' : ''}> Default (seleccionado por defecto)</label>`;
    if (tipo === 'municipio') return `
      <label>ID</label><input type="number" id="f-id" value="${data.id || ''}" ${data.id ? 'readonly' : 'required'}>
      <label>Nombre</label><input type="text" id="f-nombre" value="${data.nombre || ''}" required>
      <label>Estado</label><select id="f-estado_id"></select>
      <div class="form-row"><input type="number" id="f-lat" placeholder="Latitud" step="any" value="${data.lat || ''}">
      <input type="number" id="f-lng" placeholder="Longitud" step="any" value="${data.lng || ''}">
      <button type="button" class="btn-small btn-primary gps-btn">GPS</button></div>
      <label class="checkbox-line"><input type="checkbox" id="f-es_default" ${data.es_default ? 'checked' : ''}> Default (seleccionado por defecto)</label>`;
    if (tipo === 'seccion') return `
      <label>ID (número de sección)</label><input type="number" id="f-id" value="${data.id || ''}" ${data.id ? 'readonly' : 'required'}>
      <label>Municipio</label><select id="f-municipio_id"></select>
      <label>Tipo</label><select id="f-tipo"><option value="urbana" ${data.tipo==='urbana'?'selected':''}>Urbana</option><option value="rural" ${data.tipo==='rural'?'selected':''}>Rural</option></select>`;
    if (tipo === 'ciudadano') return `
      <div class="form-row"><input type="text" id="f-nombre" placeholder="Nombre completo" value="${data.nombre || ''}" required style="flex:2">
      <input type="text" id="f-telefono" placeholder="Teléfono" value="${data.telefono || ''}" style="flex:1">
      <input type="number" id="f-edad" placeholder="Edad" value="${data.edad || ''}" min="0" max="150" style="flex:0.3"></div>
      <div class="form-row"><select id="f-estado" required style="flex:1"></select><select id="f-municipio" required style="flex:1"></select>
      <input type="text" id="f-cp" placeholder="CP" value="${data.cp || ''}" style="flex:0.5"></div>
      <div class="form-row" style="position:relative"><input type="text" id="f-calle" placeholder="Calle" value="${data.calle || ''}" style="flex:2">
      <input type="text" id="f-numero" placeholder="N°" value="${data.numero || ''}" style="flex:0.5">
      <input type="text" id="f-colonia" placeholder="Colonia" value="${data.colonia || ''}" style="flex:1.5" autocomplete="off">
      <div id="f-colonia-sug" style="position:absolute;top:100%;left:0;right:0;z-index:999;background:#fff;border:1px solid #ddd;border-radius:4px;max-height:150px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,0.15);display:none;font-size:13px"></div></div>
      <div class="form-row" style="align-items:center"><select id="f-seccion" style="flex:1;box-sizing:border-box"><option value="">Sección (auto-detectada)</option></select>
      <input type="number" id="f-lat" placeholder="Lat" step="any" value="${data.ubicacion?.lat || 20.6434}" style="flex:1;box-sizing:border-box">
      <input type="number" id="f-lng" placeholder="Lng" step="any" value="${data.ubicacion?.lng || -100.9929}" style="flex:1;box-sizing:border-box">
      <button type="button" class="btn-small btn-primary gps-btn" style="flex:none;height:40px;min-width:40px;width:40px;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;padding:0;margin:0;font-size:18px;border:none;line-height:1" title="Obtener GPS">📍</button>
      <button type="button" class="btn-small btn-secondary" id="btn-mapa-modal" style="flex:none;height:40px;min-width:40px;width:40px;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;padding:0;margin:0;font-size:18px;border:none;line-height:1" title="Ajustar en mapa">🗺️</button></div>
      <div id="f-mapa-container" style="display:none;height:250px;margin-top:6px;border-radius:8px;border:1px solid #ddd"></div>
      <div id="f-sec-auto" style="font-size:12px;color:#666;min-height:18px"></div>
      <div class="form-row" style="align-items:center;gap:8px;flex-wrap:wrap">
        <label style="flex:2;min-width:110px;display:flex;flex-direction:column;gap:2px;font-size:11px"><span>Casilla</span>
        <select id="f-casilla" style="width:100%;box-sizing:border-box;height:32px;padding:0 8px"><option value="">Auto-detectar</option></select></label>
        <label class="checkbox-line" style="font-size:11px;flex:none;margin:0;display:flex;flex-direction:column;align-items:center;gap:5px;justify-content:flex-end"><span>No abrió</span><input type="checkbox" id="f-no_abrio" ${data.no_abrio?'checked':''} style="margin:-4px 0 0 0;width:18px;height:18px;flex:none"></label>
        <label style="flex:none;display:flex;flex-direction:column;gap:2px;font-size:11px"><span>Votantes extra</span>
        <input type="number" id="f-votantes_casa" min="0" max="20" value="${Math.max(0, (data.votantes_casa || 1) - 1)}" style="width:55px;height:32px;box-sizing:border-box;text-align:center"></label>
        <button type="button" class="btn-small btn-secondary" id="f-btn-vc" style="flex:none;font-size:11px;height:32px;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;margin-top:12px" onclick="abrirModalVotantesCasa('f')">👥 Votantes de la casa</button>
      </div>
      <div class="form-row" style="align-items:stretch"><label style="flex:0.3;display:flex;flex-direction:column;align-items:center;gap:4px;font-size:11px;cursor:pointer;text-align:center"><span>Simpatizante</span><input type="checkbox" id="f-simpatizante" ${data.simpatizante?'checked':''} style="margin:0;width:auto"></label>
      <label style="flex:0.4;display:flex;flex-direction:column;gap:2px;font-size:11px"><span>Prioridad</span><select id="f-prioridad" style="width:100%"><option value="0" ${data.prioridad==0?'selected':''}>Baja</option><option value="1" ${data.prioridad==1?'selected':''}>Media</option><option value="2" ${data.prioridad==2?'selected':''}>Alta</option><option value="3" ${data.prioridad==3?'selected':''}>Máxima</option></select></label>
      <label style="flex:1;display:flex;flex-direction:column;gap:2px;font-size:11px"><span>Presidente Municipal</span><select id="f-intencion_voto_presidente" style="width:100%"></select></label>
      <label style="flex:1;display:flex;flex-direction:column;gap:2px;font-size:11px"><span>Diputado Local</span><select id="f-intencion_voto_diputado" style="width:100%"></select></label></div>
      <input type="hidden" id="f-hogar" value="${data.numero_hogar || ''}">`;
    if (tipo === 'comprometido') return `
      <div class="form-row"><input type="text" id="f-nombre" placeholder="Nombre completo" value="${data.nombre || ''}" required style="flex:2">
      <input type="text" id="f-telefono" placeholder="Teléfono" value="${data.telefono || ''}" style="flex:1"></div>
      <div class="form-row"><input type="date" id="f-fecha_nacimiento" placeholder="Fecha de nacimiento" value="${data.fecha_nacimiento ? String(data.fecha_nacimiento).slice(0,10) : ''}" max="${new Date().toISOString().slice(0,10)}" style="flex:1">
      <input type="number" id="f-edad" placeholder="Edad (auto si dejas vacío)" value="${data.edad || ''}" min="0" max="150" style="flex:1"></div>
      <div class="form-row"><input type="email" id="f-correo" placeholder="Correo electronico" value="${data.correo || ''}" style="flex:1">
      <input type="text" id="f-curp" placeholder="CURP (18 caracteres)" value="${data.curp || ''}" maxlength="18" style="flex:1" autocomplete="off">
      <input type="text" id="f-ine" placeholder="INE / Credencial" value="${data.ine || ''}" style="flex:1"></div>
      <div class="form-row"><select id="f-estado" required style="flex:1"></select><select id="f-municipio" required style="flex:1"></select>
      <input type="text" id="f-cp" placeholder="CP" value="${data.cp || ''}" style="flex:0.5"></div>
      <div class="form-row" style="position:relative"><input type="text" id="f-calle" placeholder="Calle" value="${data.calle || ''}" style="flex:2">
      <input type="text" id="f-numero" placeholder="N°" value="${data.numero || ''}" style="flex:0.5">
      <input type="text" id="f-colonia" placeholder="Colonia" value="${data.colonia || ''}" style="flex:1.5" autocomplete="off">
      <div id="f-colonia-sug" style="position:absolute;top:100%;left:0;right:0;z-index:999;background:#fff;border:1px solid #ddd;border-radius:4px;max-height:150px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,0.15);display:none;font-size:13px"></div></div>
      <div class="form-row" style="align-items:center"><select id="f-seccion" style="flex:1;box-sizing:border-box"><option value="">Sección (auto-detectada)</option></select>
      <input type="number" id="f-lat" placeholder="Lat" step="any" value="${data.ubicacion?.lat || 20.6434}" style="flex:1;box-sizing:border-box">
      <input type="number" id="f-lng" placeholder="Lng" step="any" value="${data.ubicacion?.lng || -100.9929}" style="flex:1;box-sizing:border-box">
      <button type="button" class="btn-small btn-primary gps-btn" style="flex:none;height:40px;min-width:40px;width:40px;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;padding:0;margin:0;font-size:18px;border:none;line-height:1" title="Obtener GPS">📍</button>
      <button type="button" class="btn-small btn-secondary" id="btn-mapa-modal" style="flex:none;height:40px;min-width:40px;width:40px;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;padding:0;margin:0;font-size:18px;border:none;line-height:1" title="Ajustar en mapa">🗺️</button></div>
      <div id="f-mapa-container" style="display:none;height:250px;margin-top:6px;border-radius:8px;border:1px solid #ddd"></div>
      <div id="f-sec-auto" style="font-size:12px;color:#666;min-height:18px"></div>
      <div class="form-row" style="align-items:center"><label style="flex:1;font-size:11px">Casilla (auto por cercanía, ajustable)</label><select id="f-casilla" style="flex:3;box-sizing:border-box"><option value="">Auto-detectar</option></select></div>
      <div class="form-row" style="align-items:stretch"><label style="flex:0.4;display:flex;flex-direction:column;gap:2px;font-size:11px"><span>Prioridad</span><select id="f-prioridad" style="width:100%"><option value="0" ${data.prioridad==0?'selected':''}>Baja</option><option value="1" ${data.prioridad==1?'selected':''}>Media</option><option value="2" ${data.prioridad==2?'selected':''}>Alta</option><option value="3" ${data.prioridad==3?'selected':''}>Máxima</option></select></label>
      <label style="flex:1;display:flex;flex-direction:column;gap:2px;font-size:11px"><span>Nivel de compromiso</span><select id="f-nivel_compromiso" style="width:100%"><option value="">-</option><option value="seguro" ${data.nivel_compromiso==='seguro'?'selected':''}>Seguro</option><option value="probable" ${data.nivel_compromiso==='probable'?'selected':''}>Probable</option><option value="dudoso" ${data.nivel_compromiso==='dudoso'?'selected':''}>Dudoso</option></select></label>
      <label style="flex:1;display:flex;flex-direction:column;gap:2px;font-size:11px"><span>Partido</span><select id="f-intencion_voto_presidente" style="width:100%"></select></label></div>
      <input type="hidden" id="f-hogar" value="${data.numero_hogar || ''}">
      <input type="hidden" id="f-intencion_voto_diputado" value="${data.intencion_voto_diputado || ''}">`;
    function toDatetimeLocal(d) {
      if (!d) return '';
      const dt = new Date(d);
      if (isNaN(dt.getTime())) return d.slice(0, 16).replace('T', ' ');
      const pad = n => String(n).padStart(2, '0');
      return dt.getFullYear() + '-' + pad(dt.getMonth() + 1) + '-' + pad(dt.getDate()) + 'T' + pad(dt.getHours()) + ':' + pad(dt.getMinutes());
    }
    if (tipo === 'evento') return `
      <input type="text" id="f-nombre" placeholder="Nombre del evento" value="${data.nombre || ''}" required>
      <div class="form-row"><input type="datetime-local" id="f-fecha_inicio" value="${toDatetimeLocal(data.fecha_inicio)}" required>
      <input type="datetime-local" id="f-fecha_fin" value="${toDatetimeLocal(data.fecha_fin)}" required></div>
      <div class="form-row"><input type="number" id="f-lat" placeholder="Latitud" step="any" value="${data.ubicacion?.lat || 20.6434}" required>
      <input type="number" id="f-lng" placeholder="Longitud" step="any" value="${data.ubicacion?.lng || -100.9929}" required>
      <button type="button" class="btn-small btn-primary gps-btn">GPS</button>
      <button type="button" class="btn-small btn-secondary" id="btn-mapa-modal" title="Ajustar en mapa">🗺️</button></div>
      <div id="f-mapa-container" style="display:none;height:250px;margin-top:6px;border-radius:8px;border:1px solid #ddd"></div>
      <div id="f-sec-auto" style="font-size:12px;color:#666;min-height:18px"></div>
      <div class="form-row"><input type="number" id="f-radio" placeholder="Radio (m)" value="${data.radio_geocerca || 500}" required style="flex:0.3;min-width:70px">
      <select id="f-seccion" required style="flex:1;min-width:100px"></select></div>
      <div class="form-row"><select id="f-plantilla_id" style="flex:1;min-width:100px"><option value="">Sin plantilla</option></select>
      <label class="checkbox-line" style="margin:0;white-space:nowrap"><input type="checkbox" id="f-alertar-solo-simp" ${data.alertar_solo_simpatizantes?'checked':''}> Solo simpatizantes</label></div>
      <div class="form-group"><label style="font-size:12px;color:var(--text-muted)">Programar recordatorios automáticos</label>
        <div style="display:flex;flex-wrap:wrap;gap:8px;font-size:13px">
          <label class="chk-junto"><input type="checkbox" class="chk-alerta-programada" value="1semana" ${Array.isArray(data.alertar_config) && data.alertar_config.includes('1semana')?'checked':''}> 1 semana antes</label>
          <label class="chk-junto"><input type="checkbox" class="chk-alerta-programada" value="1dia" ${Array.isArray(data.alertar_config) && data.alertar_config.includes('1dia')?'checked':''}> 1 día antes</label>
          <label class="chk-junto"><input type="checkbox" class="chk-alerta-programada" value="3horas" ${Array.isArray(data.alertar_config) && data.alertar_config.includes('3horas')?'checked':''}> 3 horas antes</label>
          <label class="chk-junto"><input type="checkbox" class="chk-alerta-programada" value="inicio" ${Array.isArray(data.alertar_config) && data.alertar_config.includes('inicio')?'checked':''}> Al inicio del evento</label>
        </div>
      </div>`;
    if (tipo === 'partido') return `
      <label>Nombre</label><input type="text" id="f-nombre" value="${data.nombre || ''}" required>
      <label>Abreviatura</label><input type="text" id="f-abreviatura" value="${data.abreviatura || ''}" required maxlength="20">
      <label>Color</label><input type="color" id="f-color" value="${data.color || '#CC0000'}">
      <label class="checkbox-line"><input type="checkbox" id="f-es_favorito" ${data.es_favorito?'checked':''}> Partido favorito (se preselecciona al capturar ciudadanos)</label>`;
    if (tipo === 'casilla') return `
      <label>Sección</label><select id="f-seccion_id" required></select>
      <label>Tipo</label><select id="f-nombre" required>
        <option value="Básica" ${data.nombre==='Básica'?'selected':''}>Básica (C1)</option>
        <option value="Contigua 1" ${data.nombre==='Contigua 1'?'selected':''}>Contigua 1 (C2)</option>
        <option value="Contigua 2" ${data.nombre==='Contigua 2'?'selected':''}>Contigua 2 (C3)</option>
        <option value="Contigua 3" ${data.nombre==='Contigua 3'?'selected':''}>Contigua 3 (C4)</option>
        <option value="Contigua 4" ${data.nombre==='Contigua 4'?'selected':''}>Contigua 4 (C5)</option>
        <option value="Especial" ${data.nombre==='Especial'?'selected':''}>Especial</option>
        <option value="Extraordinaria" ${data.nombre==='Extraordinaria'?'selected':''}>Extraordinaria</option>
      </select>
      <label>Dirección (opcional)</label><input type="text" id="f-direccion" value="${data.direccion || ''}" placeholder="Ubicación de la casilla">
      <label>Meta de votos esperados</label><input type="number" id="f-meta_votos" value="${data.meta_votos || 0}" min="0" placeholder="Votos esperados para esta casilla">
      <div class="form-row"><label style="flex:1">Latitud</label><input type="number" id="f-lat" step="any" value="${data.lat ?? ''}" placeholder="20.6434" style="flex:2">
      <label style="flex:1">Longitud</label><input type="number" id="f-lng" step="any" value="${data.lng ?? ''}" placeholder="-100.9929" style="flex:2">
      <button type="button" class="btn-small btn-primary gps-btn" style="flex:none;height:36px;min-width:36px;width:36px;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;padding:0;margin:0;font-size:16px;border:none;line-height:1" title="Usar mi ubicación">📍</button>
      <button type="button" id="btn-mapa-modal" class="btn-small btn-primary" style="flex:none;height:36px;min-width:36px;width:36px;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;padding:0;margin:0;font-size:16px;border:none;line-height:1" title="Ajustar pin en el mapa">🗺️</button></div>
      <div id="f-mapa-container" style="display:none;height:260px;margin-top:6px;border-radius:8px;border:1px solid #ddd"></div>`;
    if (tipo === 'resultado') return `
      <label>Sección</label><select id="f-seccion_id" required></select>
      <label>Partido</label><select id="f-partido_id" required></select>
      <label>Votos</label><input type="number" id="f-votos" value="${data.votos || ''}" required min="0">
      <input type="hidden" id="f-resultado-id" value="${data.id || ''}">`;
    return '';
  }

  async function aplicarConfiguracionVisual(cfg) {
    if (!cfg) { try { cfg = await API.request('GET', '/api/configuracion'); } catch { return; } }
    C_PRIMARY = cfg.color_primary || C_PRIMARY;
    C_SECONDARY = cfg.color_secondary || C_SECONDARY;
    document.documentElement.style.setProperty('--color-primary', C_PRIMARY);
    document.documentElement.style.setProperty('--color-primary-dark', ajustarColor(C_PRIMARY, -20));
    document.documentElement.style.setProperty('--color-secondary', C_SECONDARY);
    document.documentElement.style.setProperty('--color-secondary-dark', ajustarColor(C_SECONDARY, -20));
    const logo = cfg.logo || '';
    const logos = [
      { img: 'login-logo-img', fallback: 'login-logo-fallback' },
      { img: 'nav-logo-img', fallback: 'nav-logo-fallback' },
      { img: 'config-logo-preview', fallback: 'config-logo-fallback' }
    ];
    logos.forEach(({ img, fallback }) => {
      const imgEl = document.getElementById(img);
      const fbEl = document.getElementById(fallback);
      if (imgEl && fbEl) {
        if (logo) {
          imgEl.src = logo; imgEl.style.display = ''; fbEl.style.display = 'none';
        } else {
          imgEl.src = ''; imgEl.style.display = 'none'; fbEl.style.display = '';
        }
      }
    });
  }

  let C_PRIMARY = '#CC0000';
  let C_SECONDARY = '#009639';

  function cssColor(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#999'; }

  function ajustarColor(hex, amt) {
    const num = parseInt(hex.replace('#', ''), 16);
    const r = Math.min(255, Math.max(0, (num >> 16) + amt));
    const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00FF) + amt));
    const b = Math.min(255, Math.max(0, (num & 0x0000FF) + amt));
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  async function loadConfiguracion() {
    let cfg = {};
    try { cfg = await API.request('GET', '/api/configuracion'); } catch (e) { console.warn(e); }
    await aplicarConfiguracionVisual(cfg);
    document.querySelectorAll('.cfg-tab').forEach(t => {
      t.onclick = function() {
        document.querySelectorAll('.cfg-tab').forEach(x => x.classList.remove('active'));
        document.querySelectorAll('.cfg-panel').forEach(x => x.classList.remove('active'));
        this.classList.add('active');
        const panel = document.getElementById('cfg-panel-' + this.dataset.panel);
        if (panel) panel.classList.add('active');
      };
    });
    try {
      const m = document.querySelectorAll('.cfg-input');
      m.forEach(el => { const key = el.id.replace('cfg-', '').replace(/-/g, '_'); if (cfg[key] !== undefined) el.value = cfg[key]; });
      if (cfg.color_primary) document.getElementById('cfg-color_primary').value = cfg.color_primary;
      if (cfg.color_secondary) document.getElementById('cfg-color_secondary').value = cfg.color_secondary;
      const logoPreview = document.getElementById('cfg-logo-preview');
      if (cfg.logo) { logoPreview.src = cfg.logo; logoPreview.style.display = ''; document.getElementById('config-logo-fallback').style.display = 'none'; document.getElementById('btn-quitar-logo').style.display = ''; }
    } catch (e) { console.warn(e); }
    document.getElementById('cfg-logo-input').onchange = function(e) {
      const file = e.target.files[0];
      if (!file) return;
      if (file.size > 500 * 1024) { alert('La imagen no debe exceder 500KB'); this.value = ''; return; }
      const reader = new FileReader();
      reader.onload = function(ev) {
        const preview = document.getElementById('cfg-logo-preview');
        preview.src = ev.target.result;
        preview.style.display = '';
        document.getElementById('config-logo-fallback').style.display = 'none';
        document.getElementById('btn-quitar-logo').style.display = '';
      };
      reader.readAsDataURL(file);
    };
    document.getElementById('btn-quitar-logo').onclick = function() {
      document.getElementById('cfg-logo-preview').src = '';
      document.getElementById('cfg-logo-preview').style.display = 'none';
      document.getElementById('config-logo-fallback').style.display = '';
      document.getElementById('cfg-logo-input').value = '';
      this.style.display = 'none';
    };
    document.getElementById('btn-guardar-config').onclick = async () => {
      const m = document.querySelectorAll('.cfg-input');
      const data = {};
      m.forEach(el => { const key = el.id.replace('cfg-', '').replace(/-/g, '_'); data[key] = el.value; });
      data.color_primary = document.getElementById('cfg-color_primary').value;
      data.color_secondary = document.getElementById('cfg-color_secondary').value;
      const logoPreview = document.getElementById('cfg-logo-preview');
      data.logo = (logoPreview.src && logoPreview.style.display !== 'none') ? logoPreview.src : '';
      try {
        await API.request('PUT', '/api/configuracion', data);
        document.getElementById('cfg-status').textContent = 'Configuracion guardada';
        await aplicarConfiguracionVisual();
      } catch (e) { document.getElementById('cfg-status').textContent = 'Error: ' + e.message; }
    };
  }

  let socket = null;

  function conectarSocket() {
    try {
      const io = window.io;
      if (!io || socket) return;
      socket = io(API.getBase());
      const token = API.getToken();
      if (token) socket.emit('authenticate', token);
      socket.on('nueva-ruta', (data) => {
        if (API.getUser()?.rol === 'enlace' && document.getElementById('view-rutas').classList.contains('active')) loadRutasEnlace();
      });
      socket.on('solicitud-reseteo', (data) => {
        if (API.getUser()?.rol === 'admin') notify('Solicitud de reseteo de: ' + data.nombre + ' (' + data.email + '). Ve a Usuarios.', 'info');
      });
      socket.on('password-reset', (data) => {
        notify('Tu contrasena fue restablecida. Nueva contrasena: ' + data.password, 'success');
      });
      socket.on('nuevo-ciudadano', (data) => {
        API.limpiarCache();
        if (document.getElementById('view-dashboard')?.classList.contains('active')) loadDashboard({ preserveMapView: true });
        if (document.getElementById('view-ciudadanos')?.classList.contains('active')) loadCiudadanos();
      });
      socket.on('actualizar-ciudadano', () => {
        API.limpiarCache();
        if (document.getElementById('view-dashboard')?.classList.contains('active')) loadDashboard({ preserveMapView: true });
        if (document.getElementById('view-ciudadanos')?.classList.contains('active')) loadCiudadanos();
      });
      socket.on('eliminar-ciudadano', () => {
        API.limpiarCache();
        if (document.getElementById('view-dashboard')?.classList.contains('active')) loadDashboard({ preserveMapView: true });
        if (document.getElementById('view-ciudadanos')?.classList.contains('active')) loadCiudadanos();
      });
      ['nuevo-comprometido', 'actualizar-comprometido', 'eliminar-comprometido'].forEach(evt => {
        socket.on(evt, () => {
          API.limpiarCache();
          if (document.getElementById('view-ciudadanos')?.classList.contains('active') && subTabCiudadanos === 'seguros') loadComprometidos();
        });
      });
    } catch (e) { console.warn(e); }
  }

  async function registrarFCM() {
    try {
      const PushNotifications = window.PushNotifications;
      if (PushNotifications) {
        await PushNotifications.requestPermissions().catch(e => console.warn(e));
        const result = await PushNotifications.register().catch(() => ({}));
        const token = result?.value || result?.token;
        if (token) await API.request('POST', '/api/dispositivos', { token_fcm: token, plataforma: 'android' });
      }
    } catch (e) { console.warn(e); }
  }

  window.iniciarSesionActiva = function() {
    conectarSocket();
    if (window.Capacitor?.isNativePlatform?.()) registrarFCM();
  };

  window.eliminarItem = async function(tipo, id, nombre) {
    if (!(await confirmAsync(`¿Eliminar ${nombre}?`))) return;
    try {
      if (tipo === 'usuario') await API.request('DELETE', '/api/usuarios/' + id);
      else if (tipo === 'ciudadano') await API.eliminarCiudadano(id);
      else if (tipo === 'estado') await API.eliminarEstado(id);
      else if (tipo === 'municipio') await API.eliminarMunicipio(id);
      else if (tipo === 'seccion') await API.eliminarSeccion(id);
      else if (tipo === 'evento') await API.eliminarEvento(id);
      else if (tipo === 'partido') await API.eliminarPartido(id);
      else if (tipo === 'casilla') await API.eliminarCasilla(id);
      else if (tipo === 'resultado') await API.eliminarResultado(id);
      else if (tipo === 'comprometido') await API.eliminarComprometido(id);
      notify('Eliminado', 'success');
    } catch (err) { notify(err.message, 'error'); }
    if (tipo === 'comprometido') loadComprometidos();
    else loadView(tipo === 'evento' ? 'eventos' : tipo.endsWith('o') ? tipo + 's' : tipo + 'es');
  };

  window.renderMicroCharts = function(tabFiltered, geoFiltered, rutas) {
    // Simpatizantes: mini bar simpatizantes vs no simpatizantes
    const microSimp = document.getElementById('micro-simpatizantes');
    if (microSimp) {
      if (geoFiltered.length) {
        const total = geoFiltered.length;
        const simps = geoFiltered.filter(c => c.simpatizante).length;
        const noSimps = total - simps;
        const pct = (simps / total * 100).toFixed(1);
        microSimp.innerHTML =
          `<div style="flex:1;height:18px;background:#eee;border-radius:3px;overflow:hidden;display:flex">
            <div style="width:${pct}%;background:var(--pri-green);transition:width 0.3s;position:relative" title="Simpatizantes: ${simps} (${pct}%)"></div>
            <div style="flex:1;background:#f0f0f0" title="No simpatizantes: ${noSimps}"></div>
          </div>
          <span style="font-size:10px;min-width:32px;text-align:right;color:var(--pri-green)">${pct}%</span>`;
        microSimp.style.display = '';
      } else microSimp.style.display = 'none';
    }
    // Ciudadanos: mini bar hombres vs mujeres
    const microCiu = document.getElementById('micro-ciudadanos');
    if (microCiu) {
      if (tabFiltered.length) {
        const hombres = tabFiltered.filter(c => c.genero === 'hombre' || c.genero === 'H').length;
        const mujeres = tabFiltered.filter(c => c.genero === 'mujer' || c.genero === 'M').length;
        const otros = tabFiltered.length - hombres - mujeres;
        if (hombres || mujeres) {
          const max = Math.max(hombres, mujeres, 1);
          microCiu.innerHTML =
            `<div style="flex:1;display:flex;align-items:flex-end;gap:2px;height:18px;padding:0 4px">
              <div style="flex:${hombres};height:${hombres/max*16}px;background:#2196F3;border-radius:2px 2px 0 0;min-width:4px" title="Hombres: ${hombres}"></div>
              <div style="flex:${mujeres};height:${mujeres/max*16}px;background:#E91E63;border-radius:2px 2px 0 0;min-width:4px" title="Mujeres: ${mujeres}"></div>
              ${otros ? `<div style="flex:${otros};height:${otros/max*16}px;background:#999;border-radius:2px 2px 0 0;min-width:4px" title="Otros: ${otros}"></div>` : ''}
            </div>
            <span style="font-size:10px;min-width:20px;text-align:right;color:#666">${tabFiltered.length}</span>`;
          microCiu.style.display = '';
        } else microCiu.style.display = 'none';
      } else microCiu.style.display = 'none';
    }
    // Rutas: mini bar en_progreso vs completadas vs pendientes
    const microRutas = document.getElementById('micro-rutas');
    if (microRutas) {
      if (rutas && rutas.length) {
        const enProgreso = rutas.filter(r => r.estado === 'en_progreso').length;
        const completadas = rutas.filter(r => r.estado === 'completada').length;
        const pendientes = rutas.length - enProgreso - completadas;
        const maxR = Math.max(enProgreso, completadas, 1);
        const activas = rutas.filter(r => r.estado === 'en_progreso');
        const encActivas = activas.filter(r => r.tipo === 'encuesta').length;
        const segActivas = activas.length - encActivas;
        microRutas.innerHTML =
          `<div style="flex:1;display:flex;align-items:flex-end;gap:2px;height:18px">
            <div style="flex:${enProgreso};height:${enProgreso/maxR*16}px;background:#FF9800;border-radius:2px 2px 0 0;min-width:4px" title="En progreso: ${enProgreso}"></div>
            <div style="flex:${completadas};height:${completadas/maxR*16}px;background:var(--pri-green);border-radius:2px 2px 0 0;min-width:4px" title="Completadas: ${completadas}"></div>
            <div style="flex:${pendientes};height:${pendientes/maxR*16}px;background:#e0e0e0;border-radius:2px 2px 0 0;min-width:4px" title="Pendientes: ${pendientes}"></div>
          </div>
          <span style="font-size:10px;min-width:24px;text-align:right;color:#666">${rutas.length}</span>
          <div style="flex:1 0 100%;font-size:9px;color:#888;margin-top:2px">📋 ${encActivas} encuesta · 🛡 ${segActivas} seguros</div>`;
        microRutas.style.display = '';
      } else microRutas.style.display = 'none';
    }
    // Visitas hoy: mini bar por hora (simulated con data de completados hoy)
    const microVisitas = document.getElementById('micro-visitas');
    if (microVisitas) {
      if (rutas && rutas.length) {
        const hoy = new Date(); hoy.setHours(0,0,0,0);
        const hoyCompletadas = rutas.filter(r => r.completado_en && new Date(r.completado_en) >= hoy);
        const horas = Array(12).fill(0);
        hoyCompletadas.forEach(r => {
          const h = new Date(r.completado_en).getHours();
          if (h >= 6 && h < 18) horas[h - 6]++;
        });
        const maxH = Math.max(...horas, 1);
        microVisitas.innerHTML = horas.map((v, i) =>
          `<div style="flex:1;height:${v/maxH*16}px;background:${v ? '#9C27B0' : '#f0f0f0'};border-radius:1px;min-height:2px" title="${i+6}:00 - ${v} visitas"></div>`
        ).join('');
        microVisitas.style.display = '';
      } else microVisitas.style.display = 'none';
    }
  };

  window.exportarReporte = function() {
    const data = window._exportData || [];
    if (!data.length) { alert('No hay datos para exportar'); return; }
    const headers = ['ID', 'Nombre', 'Teléfono', 'Sección', 'Municipio', 'Dirección', 'Genero', 'Simpatizante', 'Partido Presidente', 'Partido Diputado', 'Intención', 'Notas'];
    const rows = data.map(c => [
      c.id, c.nombre, c.telefono, c.seccion_id, c.municipio_nombre || '', c.direccion || '',
      c.genero || '', c.simpatizante ? 'Sí' : 'No',
      c.partido_presidente?.nombre || '', c.partido_diputado?.nombre || '',
      c.intencion_voto_presidente || c.intencion_voto_diputado || '', (c.notas || '').replace(/,/g, ';')
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `reporte_ciudadanos_${new Date().toISOString().slice(0,10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  // Exportar a Excel (hoja de cálculo descargada desde el servidor)
  window.exportarExcel = async function() {
    try {
      const blob = await API.requestBlob('GET', '/api/exportar/excel');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `ciudadanos_${new Date().toISOString().slice(0,10)}.xls`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { notify('Error al exportar Excel: ' + (e.message || e), 'error'); }
  };

  // ---- Avance de barrido en vivo ----
  let dashAvanceTimer = null;
  let dashAvanceLayer = null;
  async function cargarAvanceBarrido() {
    try {
      const data = await API.request('GET', '/api/geo/avance-barrido');
      const listEl = document.getElementById('dash-avance-list');
      const leyendaEl = document.getElementById('dash-avance-leyenda');
      const horaEl = document.getElementById('dash-avance-hora');
      if (!listEl) return;
      horaEl.textContent = 'actualizado ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const conDatos = data.filter(d => d.total_ciudadanos > 0);
      const visitados = data.reduce((s, d) => s + (d.visitados_24h || 0), 0);
      const totales = data.reduce((s, d) => s + (d.total_ciudadanos || 0), 0);
      const colorAvance = p => p <= 0 ? '#e0e0e0' : p < 25 ? '#ff6b6b' : p < 50 ? '#ffd93d' : p < 75 ? '#6bcb77' : '#2d8a4e';
      leyendaEl.innerHTML = [
        `<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${colorAvance(0)};vertical-align:-1px"></span> Sin avance</span>`,
        `<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${colorAvance(10)};vertical-align:-1px"></span> &lt;25%</span>`,
        `<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${colorAvance(30)};vertical-align:-1px"></span> 25-49%</span>`,
        `<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${colorAvance(60)};vertical-align:-1px"></span> 50-74%</span>`,
        `<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${colorAvance(90)};vertical-align:-1px"></span> 75%+</span>`
      ].join('');
      listEl.innerHTML = conDatos.length
        ? conDatos.sort((a, b) => ((b.visitados_24h || 0) / b.total_ciudadanos) - ((a.visitados_24h || 0) / a.total_ciudadanos)).map(d => {
            const pct = Math.round(((d.visitados_24h || 0) / d.total_ciudadanos) * 100);
            return `<div style="display:flex;align-items:center;gap:6px;margin:3px 0">
              <span style="width:34px;flex:none;text-align:right;font-weight:600">${d.seccion_num}</span>
              <div style="flex:1;height:12px;background:#eee;border-radius:4px;overflow:hidden;min-width:40px">
                <div style="height:100%;width:${pct}%;background:${colorAvance(pct)};border-radius:4px"></div>
              </div>
              <span style="width:70px;text-align:right;color:#666">${d.visitados_24h}/${d.total_ciudadanos}</span>
            </div>`;
          }).join('')
        : '<div style="color:#999;font-size:12px">Sin ciudadanos registrados</div>';
      // Heatmap en el mapa del dashboard (círculos por sección)
      if (dashboardMap && data.length) {
        if (dashAvanceLayer) { dashboardMap.removeLayer(dashAvanceLayer); dashAvanceLayer = null; }
        dashAvanceLayer = L.layerGroup().addTo(dashboardMap);
        data.forEach(d => {
          if (d.centro_lat == null || d.centro_lng == null || !d.total_ciudadanos) return;
          const pct = (d.visitados_24h || 0) / d.total_ciudadanos;
          const radius = pct <= 0 ? 8 : 10 + pct * 18;
          L.circleMarker([d.centro_lat, d.centro_lng], {
            radius, fillColor: colorAvance(pct * 100), color: '#fff', weight: 1.5, fillOpacity: pct <= 0 ? 0.25 : 0.7
          }).bindPopup(`<b>Sección ${d.seccion_num}</b><br>${d.municipio}<br>Visitados 24h: ${d.visitados_24h}/${d.total_ciudadanos} (${Math.round(pct*100)}%)`).addTo(dashAvanceLayer);
        });
      }
    } catch (e) { console.warn('avance:', e); }
  }
  function iniciarAvanceEnVivo() {
    if (dashAvanceTimer) clearInterval(dashAvanceTimer);
    cargarAvanceBarrido();
    dashAvanceTimer = setInterval(cargarAvanceBarrido, 60000);
  }
  function detenerAvanceEnVivo() {
    if (dashAvanceTimer) { clearInterval(dashAvanceTimer); dashAvanceTimer = null; }
  }
  setInterval(() => { if (!document.getElementById('view-dashboard').classList.contains('active')) return; iniciarAvanceEnVivo(); }, 60000);

  let _encuestaCampanaId = null;
  window.lanzarEncuestaCampana = async function(campanaId, lanzada) {
    try {
      const camp = (await API.getCampanas()).find(c => c.id === campanaId);
      await API.request('PUT', '/api/campanas/' + campanaId, {
        nombre: camp?.nombre || 'Campaña',
        encuesta_lanzada: lanzada
      });
      notify(lanzada ? 'Encuesta lanzada: disponible en cada ciudadano' : 'Encuesta cerrada', lanzada ? 'success' : 'info');
      loadCampanas();
    } catch (e) { notify('Error: ' + e.message, 'error'); }
  };
  window.abrirEncuesta = async function(campanaId, campanaNombre) {
    _encuestaCampanaId = campanaId;
    document.getElementById('encuesta-title').textContent = 'Encuesta: ' + (campanaNombre || 'Campaña');
    limpiarFormPregunta();
    document.getElementById('encuesta-modal').classList.remove('hidden');
    await cargarPreguntasEncuesta();
  };
  async function cargarPreguntasEncuesta() {
    try {
      const preguntas = await API.request('GET', '/api/encuestas/preguntas?campana_id=' + _encuestaCampanaId + '&todas=1');
      window._encuestaPreguntas = preguntas;
      const list = document.getElementById('encuesta-list');
      list.innerHTML = preguntas.length ? preguntas.map((p, i) => `
        <div style="display:flex;align-items:center;gap:8px;padding:8px;border:1px solid #eee;border-radius:8px;margin-bottom:6px;background:#fafafa">
          <span style="width:22px;text-align:right;color:#999;font-weight:600">${i+1}.</span>
          <div style="flex:1;font-size:13px">
            <strong>${p.pregunta}</strong>
            <div style="color:#999;font-size:11px">
              ${p.tipo === 'si_no' ? 'Sí/No' : p.tipo === 'opciones' ? 'Opciones: ' + (Array.isArray(p.opciones) ? p.opciones.join(', ') : (p.opciones||'')) : 'Texto'}
              ${p.obligatoria ? ' · Obligatoria' : ''} ${p.activa === false ? ' · <span style="color:#999">inactiva</span>' : ''}
            </div>
          </div>
          <button class="btn-small btn-secondary" onclick="editarPreguntaEncuesta('${p.id}')" title="Editar pregunta">✏️ Editar</button>
          <button class="btn-small btn-danger" onclick="eliminarPreguntaEncuesta('${p.id}')">X</button>
        </div>`).join('')
        : '<div style="color:#999;font-size:13px;text-align:center;padding:12px">Aún no hay preguntas para esta campaña</div>';
    } catch (e) { notify('Error al cargar preguntas: ' + e.message, 'error'); }
  }
  function limpiarFormPregunta() {
    document.getElementById('enc-pregunta').value = '';
    document.getElementById('enc-opciones').value = '';
    document.getElementById('enc-obligatoria').checked = false;
    document.getElementById('enc-tipo').value = 'texto';
    document.getElementById('enc-opciones-wrap').style.display = 'none';
    window._encuestaEditandoId = null;
    document.getElementById('enc-agregar').textContent = 'Agregar pregunta';
    document.getElementById('enc-cancelar-edicion').style.display = 'none';
  }
  window.editarPreguntaEncuesta = function(id) {
    const p = (window._encuestaPreguntas || []).find(x => x.id === id);
    if (!p) return;
    window._encuestaEditandoId = id;
    document.getElementById('enc-pregunta').value = p.pregunta;
    document.getElementById('enc-tipo').value = p.tipo || 'texto';
    document.getElementById('enc-opciones').value = Array.isArray(p.opciones) ? p.opciones.join(', ') : (p.opciones || '');
    document.getElementById('enc-opciones-wrap').style.display = (p.tipo || 'texto') === 'opciones' ? 'block' : 'none';
    document.getElementById('enc-obligatoria').checked = !!p.obligatoria;
    document.getElementById('enc-agregar').textContent = '💾 Guardar cambios';
    document.getElementById('enc-cancelar-edicion').style.display = 'inline-block';
  };
  window.cancelarEdicionPregunta = function() { limpiarFormPregunta(); };
  window.eliminarPreguntaEncuesta = async function(id) {
    try { await API.request('DELETE', '/api/encuestas/preguntas/' + id); await cargarPreguntasEncuesta(); }
    catch (e) { notify('Error: ' + e.message, 'error'); }
  };
  document.getElementById('enc-agregar').addEventListener('click', async function() {
    const pregunta = document.getElementById('enc-pregunta').value.trim();
    if (!pregunta) { notify('Escribe la pregunta', 'error'); return; }
    const tipo = document.getElementById('enc-tipo').value;
    let opciones = null;
    if (tipo === 'opciones') {
      opciones = document.getElementById('enc-opciones').value.split(',').map(s => s.trim()).filter(Boolean);
      if (!opciones.length) { notify('Escribe las opciones separadas por coma', 'error'); return; }
    }
    const editandoId = window._encuestaEditandoId || null;
    try {
      if (editandoId) {
        await API.request('PUT', '/api/encuestas/preguntas/' + editandoId, { pregunta, tipo, opciones, obligatoria: document.getElementById('enc-obligatoria').checked });
      } else {
        await API.request('POST', '/api/encuestas/preguntas', {
          campana_id: _encuestaCampanaId, pregunta, tipo, opciones,
          obligatoria: document.getElementById('enc-obligatoria').checked
        });
      }
      limpiarFormPregunta();
      await cargarPreguntasEncuesta();
    } catch (e) { notify('Error: ' + e.message, 'error'); }
  });
  document.getElementById('enc-tipo').addEventListener('change', function() {
    document.getElementById('enc-opciones-wrap').style.display = this.value === 'opciones' ? 'block' : 'none';
  });

  window.verificarVersionApp = async function() {
    try {
      const res = await fetch(API.getBase() + '/index.html?t=' + Date.now());
      const html = await res.text();
      const m = html.match(/window\._APP_VERSION\s*=\s*'(\d+)'/);
      const servidor = m ? m[1] : null;
      const el = document.getElementById('cfg-version-servidor');
      if (!servidor) { el.textContent = 'No disponible'; return; }
      const actual = window._APP_VERSION || '132';
      el.textContent = 'v' + servidor + (servidor === actual ? ' (al día ✓)' : ' (hay actualización)');
      if (servidor !== actual) notify('Hay una nueva versión disponible (v' + servidor + ')', 'info');
      else notify('La app está al día (v' + actual + ')', 'success');
    } catch (e) { document.getElementById('cfg-version-servidor').textContent = 'Sin conexión'; }
  };

  window.descargarBackup = async function() {
    try {
      const blob = await API.requestBlob('GET', '/api/backup');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'colmena_backup_' + new Date().toISOString().slice(0, 10) + '.sql';
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
      notify('Respaldo descargado', 'success');
    } catch (e) { notify('Error al descargar respaldo: ' + e.message, 'error'); }
  };

  window.abrirAuditoria = async function() {
    const cont = document.getElementById('cfg-avance-log');
    try {
      const log = await API.request('GET', '/api/auditoria?limit=100');
      cont.innerHTML = log.length ? log.map(a => `
        <div style="padding:6px 0;border-bottom:1px solid #f0f0f0">
          <div style="display:flex;justify-content:space-between;gap:8px">
            <strong>${a.accion}</strong>
            <span style="color:#999;font-size:11px">${new Date(a.created_at).toLocaleString()}</span>
          </div>
          <div style="color:#666;font-size:11px">${a.usuario_nombre || '—'} · ${a.entidad || ''} ${a.entidad_id ? '#' + a.entidad_id.slice(0,8) : ''}</div>
          ${a.detalle ? '<div style="color:#999;font-size:11px">' + JSON.stringify(a.detalle).slice(0,120) + '</div>' : ''}
        </div>`).join('')
        : '<div style="color:#999;text-align:center;padding:10px">Sin registros</div>';
      cont.style.display = 'block';
    } catch (e) { notify('Error al cargar auditoría: ' + e.message, 'error'); }
  };

  window.abrirEncuestaCiudadano = async function(id, nombre, campanaId) {
    try {
      const preguntas = campanaId
        ? await API.request('GET', '/api/encuestas/preguntas?campana_id=' + campanaId)
        : await API.request('GET', '/api/encuestas/preguntas');
      document.getElementById('enc-ciu-title').textContent = 'Encuesta: ' + (nombre || 'Ciudadano');
      const preguntasEl = document.getElementById('enc-ciu-preguntas');
      const msgEl = document.getElementById('enc-ciu-msg');
      const avisoEl = document.getElementById('enc-ciu-aviso');
      const campanaEl = document.getElementById('enc-ciu-campana');
      msgEl.textContent = '';
      if (!preguntas.length) {
        avisoEl.textContent = 'No hay encuesta lanzada en este momento';
        campanaEl.textContent = '';
        preguntasEl.innerHTML = '';
        document.getElementById('encuesta-ciudadano-modal').classList.remove('hidden');
        return;
      }
      const campanaNombre = campanaId ? preguntas[0].campana_nombre : preguntas[0].campana_nombre;
      const campanaRealId = campanaId || preguntas[0].campana_id;
      const distinta = preguntas.find(p => p.campana_id !== campanaRealId);
      if (distinta) {
        avisoEl.textContent = 'Se guardarán solo las respuestas de la campaña "' + campanaNombre + '"';
        preguntas = preguntas.filter(p => p.campana_id === campanaRealId);
      } else {
        avisoEl.textContent = preguntas.length + ' pregunta(s) · Campaña ' + campanaNombre;
      }
      campanaEl.textContent = '';
      let existentes = {};
      try {
        const rr = await API.request('GET', '/api/encuestas/respuestas?ciudadano_id=' + id);
        rr.forEach(r => { existentes[r.pregunta_id] = r.valor; });
      } catch (e) { console.warn(e); }
      preguntasEl.innerHTML = preguntas.map(p => {
        const val = existentes[p.id];
        if (p.tipo === 'si_no') {
          return `<div style="margin:8px 0;font-size:13px"><strong>${p.pregunta}</strong>${p.obligatoria ? ' <span style="color:var(--pri-red)">*</span>' : ''}
            <div style="display:flex;gap:12px;margin-top:4px">
              <label style="font-size:12px"><input type="radio" name="encu-${p.id}" value="Si" ${val==='Si'?'checked':''}> Si</label>
              <label style="font-size:12px"><input type="radio" name="encu-${p.id}" value="No" ${val==='No'?'checked':''}> No</label>
            </div></div>`;
        }
        if (p.tipo === 'opciones') {
          const opts = Array.isArray(p.opciones) ? p.opciones : [];
          return `<div style="margin:8px 0;font-size:13px"><strong>${p.pregunta}</strong>${p.obligatoria ? ' <span style="color:var(--pri-red)">*</span>' : ''}
            <select id="encu-r-${p.id}" style="width:100%;margin-top:4px;padding:6px;border:1px solid #ddd;border-radius:6px">
              <option value="">— Seleccionar —</option>
              ${opts.map(o => `<option value="${o}" ${val===o?'selected':''}>${o}</option>`).join('')}
            </select></div>`;
        }
        return `<div style="margin:8px 0;font-size:13px"><strong>${p.pregunta}</strong>${p.obligatoria ? ' <span style="color:var(--pri-red)">*</span>' : ''}
          <input type="text" id="encu-r-${p.id}" value="${val || ''}" placeholder="Respuesta" style="width:100%;margin-top:4px;padding:6px;border:1px solid #ddd;border-radius:6px;box-sizing:border-box"></div>`;
      }).join('');
      document.getElementById('encuesta-ciudadano-modal').classList.remove('hidden');
      const guardarBtn = document.getElementById('enc-ciu-guardar');
      const prevOnClick = guardarBtn.onclick;
      guardarBtn.onclick = async function() {
        const respuestas = [];
        let obligatoriaFaltante = false;
        preguntas.forEach(p => {
          let valor = null;
          if (p.tipo === 'si_no') {
            const r = document.querySelector(`input[name="encu-${p.id}"]:checked`);
            if (r) valor = r.value;
          } else {
            const el = document.getElementById('encu-r-' + p.id);
            if (el && el.value.trim()) valor = el.value.trim();
          }
          if (valor === null && p.obligatoria) obligatoriaFaltante = true;
          if (valor !== null) respuestas.push({ pregunta_id: p.id, valor });
        });
        if (obligatoriaFaltante) { msgEl.textContent = 'Completa las preguntas marcadas con *'; msgEl.style.color = 'var(--pri-red)'; return; }
        if (!respuestas.length) { msgEl.textContent = 'Responde al menos una pregunta'; msgEl.style.color = 'var(--pri-red)'; return; }
        try {
          await API.request('POST', '/api/encuestas/respuestas', { ciudadano_id: id, campana_id: campanaRealId, respuestas });
          msgEl.textContent = 'Encuesta guardada ✓'; msgEl.style.color = 'var(--pri-green)';
          setTimeout(() => document.getElementById('encuesta-ciudadano-modal').classList.add('hidden'), 700);
          guardarBtn.onclick = prevOnClick;
        } catch (e) { msgEl.textContent = 'Error: ' + (e.message || e); msgEl.style.color = 'var(--pri-red)'; }
      };
    } catch (e) { notify('Error al cargar encuesta: ' + e.message, 'error'); }
  };

  window.mostrarHistorialCiudadano = async function(id, nombre) {
    try {
      const visitas = await API.request('GET', `/api/ciudadanos/${id}/visitas`);
      const tipos = { alta: 'Registro', edicion: 'Edición', encuesta: 'Encuesta', ruta: 'Visita de ruta' };
      const html = visitas.length ? visitas.map(v => `
        <div style="padding:8px;border-bottom:1px solid #eee;font-size:13px">
          <div style="display:flex;justify-content:space-between;gap:8px">
            <strong>${tipos[v.tipo] || v.tipo}</strong>
            <span style="color:#999;font-size:11px">${new Date(v.created_at).toLocaleString()}</span>
          </div>
          ${v.usuario_nombre ? `<div style="color:#666;font-size:12px">por ${v.usuario_nombre}</div>` : ''}
          ${v.lat != null && v.lng != null ? `<div style="color:#999;font-size:11px">📍 ${v.lat.toFixed(5)}, ${v.lng.toFixed(5)}</div>` : ''}
        </div>`).join('')
        : '<div style="color:#999;font-size:13px;padding:8px">Sin visitas registradas</div>';
      const overlay = document.getElementById('modal-overlay');
      const fields = document.getElementById('modal-fields');
      document.getElementById('modal-title').textContent = 'Historial: ' + (nombre || '');
      const submitBtn = document.getElementById('modal-submit');
      const prevTipo = submitBtn.dataset.tipo;
      const prevEdit = submitBtn.dataset.editId;
      submitBtn.style.display = 'none';
      overlay.classList.remove('hidden');
      fields.innerHTML = html;
      document.getElementById('modal-msg').textContent = '';
      // Restaurar botón al cerrar
      const restore = function() {
        submitBtn.style.display = '';
        submitBtn.dataset.tipo = prevTipo;
        submitBtn.dataset.editId = prevEdit;
      };
      const closeBtn = overlay.querySelector('.modal-close');
      if (closeBtn) {
        const old = closeBtn.onclick;
        closeBtn.onclick = function(e) { restore(); if (old) old.call(closeBtn, e); };
      }
    } catch (e) { notify('Error al cargar historial: ' + e.message, 'error'); }
  };
})();