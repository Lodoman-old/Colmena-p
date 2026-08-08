const fs = require('fs');
const path = require('path');

const DEST = path.join(__dirname, '..', 'src', 'tiles-server');
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile';
const ZMIN = 13, ZMAX = 18;
const CONCURRENCIA = 24;
const REINTENTOS = 8;
const BBOX = { latMin: 20.548236808, latMax: 20.821167724, lngMin: -101.130305249, lngMax: -100.858349747 };

function tileY(lat, z) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
}

const urls = [];
for (let z = ZMIN; z <= ZMAX; z++) {
  const n = Math.pow(2, z);
  const x0 = Math.max(0, Math.floor(((BBOX.lngMin + 180) / 360) * n));
  const x1 = Math.min(n - 1, Math.floor(((BBOX.lngMax + 180) / 360) * n));
  const y0 = Math.max(0, tileY(BBOX.latMax, z));
  const y1 = Math.min(n - 1, tileY(BBOX.latMin, z));
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) urls.push({ z, x, y });
}

const pendientes = urls.filter(u => !fs.existsSync(path.join(DEST, String(u.z), String(u.y), u.x + '.jpg')));
const total = urls.length;
if (!total) { console.log('Sin tiles que calcular'); process.exit(1); }
console.log(`Total: ${total} tiles | ya descargados: ${total - pendientes.length} | pendientes: ${pendientes.length}`);

let idx = 0, ok = 0, errs = 0;
const inicio = Date.now();
let ultimoLog = 0;

async function descargar(u) {
  const dir = path.join(DEST, String(u.z), String(u.y));
  const file = path.join(dir, u.x + '.jpg');
  for (let intento = 0; intento < REINTENTOS; intento++) {
    try {
      const r = await fetch(`${ESRI}/${u.z}/${u.y}/${u.x}`);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, buf);
      ok++;
      return;
    } catch (e) {
      if (intento === REINTENTOS - 1) { errs++; console.log(`FALLÓ ${u.z}/${u.y}/${u.x}: ${e.message}`); }
      else await new Promise(res => setTimeout(res, 1000 * Math.pow(2, intento)));
    }
  }
}

(async () => {
  const trabajadores = [];
  for (let t = 0; t < CONCURRENCIA; t++) {
    trabajadores.push((async () => {
      while (true) {
        const i = idx++;
        if (i >= pendientes.length) return;
        await descargar(pendientes[i]);
        const now = Date.now();
        if (now - ultimoLog > 10000) {
          ultimoLog = now;
          const seg = (now - inicio) / 1000;
          const vel = seg > 2 ? Math.round(ok / seg) : 0;
          const resto = pendientes.length - ok - errs;
          const eta = vel > 0 ? Math.round(resto / vel / 60) : null;
          console.log(`${ok}/${pendientes.length} tiles (${(ok / pendientes.length * 100).toFixed(1)}%) · ${vel}/s · ETA ${eta} min · errores ${errs}`);
        }
      }
    })());
  }
  await Promise.all(trabajadores);
  const seg = Math.round((Date.now() - inicio) / 1000);
  console.log(`Terminado: ${ok} descargados, ${errs} fallidos en ${seg}s${errs ? ' (relanza el script para reintentar los faltantes)' : ''}`);
})();
