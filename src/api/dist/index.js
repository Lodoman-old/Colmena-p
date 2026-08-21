"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const pg_1 = require("pg");
const dotenv_1 = __importDefault(require("dotenv"));
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const sharp_1 = __importDefault(require("sharp"));
const socket_io_1 = require("socket.io");
const Rutas_1 = require("./Rutas");
const Eventos_1 = require("./Eventos");
const Notificaciones_1 = require("./Notificaciones");
const web_push_1 = __importDefault(require("web-push"));
const axios_1 = __importDefault(require("axios"));
// @ts-ignore pdfkit no tiene tipos completos en runtime con commonjs
const pdfkit_1 = __importDefault(require("pdfkit"));
const client_s3_1 = require("@aws-sdk/client-s3");
dotenv_1.default.config();
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const io = new socket_io_1.Server(server, { cors: { origin: '*' } });
const PORT = process.env.PORT || 3000;
const pool = new pg_1.Pool({
    host: process.env.DB_HOST || 'postgres',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'colmena_db',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'password',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});
// Migration: add idempotency_key column
pool.query(`ALTER TABLE ciudadanos ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ciudadanos_idempotency ON ciudadanos(idempotency_key) WHERE idempotency_key IS NOT NULL;`)
    .catch((e) => console.warn('Migration (idempotency_key):', e?.message));
// Migration: visitas, encuestas, auditoria
pool.query(`
CREATE TABLE IF NOT EXISTS visitas (
  id UUID PRIMARY KEY,
  ciudadano_id UUID REFERENCES ciudadanos(id) ON DELETE CASCADE,
  usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  tipo TEXT NOT NULL DEFAULT 'alta',
  lat DOUBLE PRECISION, lng DOUBLE PRECISION,
  notas TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_visitas_ciudadano ON visitas(ciudadano_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_visitas_usuario ON visitas(usuario_id, created_at DESC);

CREATE TABLE IF NOT EXISTS encuesta_preguntas (
  id UUID PRIMARY KEY,
  campana_id UUID REFERENCES campanas(id) ON DELETE CASCADE,
  pregunta TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'texto',
  opciones JSONB,
  obligatoria BOOLEAN NOT NULL DEFAULT FALSE,
  orden INT NOT NULL DEFAULT 0,
  activa BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_encuesta_preguntas_campana ON encuesta_preguntas(campana_id, orden);

CREATE TABLE IF NOT EXISTS encuesta_respuestas (
  id UUID PRIMARY KEY,
  ciudadano_id UUID REFERENCES ciudadanos(id) ON DELETE CASCADE,
  campana_id UUID REFERENCES campanas(id) ON DELETE CASCADE,
  pregunta_id UUID REFERENCES encuesta_preguntas(id) ON DELETE CASCADE,
  valor TEXT,
  usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ciudadano_id, pregunta_id)
);

CREATE TABLE IF NOT EXISTS auditoria (
  id UUID PRIMARY KEY,
  usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  usuario_nombre TEXT,
  accion TEXT NOT NULL,
  entidad TEXT,
  entidad_id TEXT,
  detalle JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_auditoria_created ON auditoria(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_entidad ON auditoria(entidad, entidad_id);

ALTER TABLE campanas ADD COLUMN IF NOT EXISTS encuesta_lanzada BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE campanas ADD COLUMN IF NOT EXISTS encuesta_barrido BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_campanas_encuesta_barrido ON campanas (encuesta_barrido) WHERE encuesta_barrido = TRUE;

ALTER TABLE campanas ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE campanas ADD COLUMN IF NOT EXISTS encuesta_id UUID REFERENCES campanas(id) ON DELETE SET NULL;
ALTER TABLE rutas ADD COLUMN IF NOT EXISTS encuesta_campana_id UUID REFERENCES campanas(id) ON DELETE SET NULL;
ALTER TABLE rutas ADD COLUMN IF NOT EXISTS polyline JSONB;
CREATE INDEX IF NOT EXISTS idx_campanas_tipo ON campanas(tipo);
CREATE INDEX IF NOT EXISTS idx_rutas_encuesta ON rutas(encuesta_campana_id);

ALTER TABLE ciudadanos DROP COLUMN IF EXISTS simpatizante;
ALTER TABLE ciudadanos_comprometidos DROP COLUMN IF EXISTS simpatizante;

CREATE TABLE IF NOT EXISTS ciudadanos_encuestas (
  ciudadano_id UUID PRIMARY KEY REFERENCES ciudadanos(id) ON DELETE CASCADE,
  campana_id UUID NOT NULL REFERENCES campanas(id) ON DELETE CASCADE,
  asignada_por UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ciudadanos_encuestas_campana ON ciudadanos_encuestas(campana_id);

INSERT INTO configuracion (clave, valor, descripcion) VALUES ('url_publica', 'http://192.168.0.16', 'URL publica del sistema (para enlaces de encuesta)')
ON CONFLICT (clave) DO NOTHING;
`).catch((e) => console.warn('Migration (visitas/encuestas/auditoria):', e?.message));
// Migration: catalogos discapacidad/ocupacion + perfil del ciudadano
pool.query(`
CREATE TABLE IF NOT EXISTS cat_discapacidades (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL UNIQUE,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  orden INTEGER NOT NULL DEFAULT 0,
  creado_en TIMESTAMP DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS cat_ocupaciones (
  id SERIAL PRIMARY KEY,
  nombre VARCHAR(100) NOT NULL UNIQUE,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  orden INTEGER NOT NULL DEFAULT 0,
  creado_en TIMESTAMP DEFAULT NOW()
);
ALTER TABLE ciudadanos ADD COLUMN IF NOT EXISTS sexo CHAR(1);
ALTER TABLE ciudadanos ADD COLUMN IF NOT EXISTS discapacidad_id INTEGER REFERENCES cat_discapacidades(id) ON DELETE SET NULL;
ALTER TABLE ciudadanos ADD COLUMN IF NOT EXISTS ocupacion_id INTEGER REFERENCES cat_ocupaciones(id) ON DELETE SET NULL;
ALTER TABLE ciudadanos ADD COLUMN IF NOT EXISTS motivo_puerta VARCHAR(30);
ALTER TABLE ciudadanos_comprometidos ADD COLUMN IF NOT EXISTS sexo CHAR(1);
ALTER TABLE ciudadanos_comprometidos ADD COLUMN IF NOT EXISTS discapacidad_id INTEGER REFERENCES cat_discapacidades(id) ON DELETE SET NULL;
ALTER TABLE ciudadanos_comprometidos ADD COLUMN IF NOT EXISTS ocupacion_id INTEGER REFERENCES cat_ocupaciones(id) ON DELETE SET NULL;
INSERT INTO cat_discapacidades (nombre, orden) VALUES ('Ninguna',0),('Visual',1),('Auditiva',2),('Motriz',3),('Cognitiva',4),('Otra',5)
ON CONFLICT (nombre) DO NOTHING;
INSERT INTO cat_ocupaciones (nombre, orden) VALUES ('Estudiante',0),('Hogar',1),('Empleado',2),('Comerciante',3),('Agricultor',4),('Jubilado / Pensionado',5),('Profesionista',6),('Otro',7)
ON CONFLICT (nombre) DO NOTHING;
CREATE TABLE IF NOT EXISTS cat_estatus_visita (
  id SERIAL PRIMARY KEY,
  clave VARCHAR(30) NOT NULL UNIQUE,
  nombre VARCHAR(100) NOT NULL UNIQUE,
  marca_no_abrio BOOLEAN NOT NULL DEFAULT TRUE,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  orden INTEGER NOT NULL DEFAULT 0,
  creado_en TIMESTAMP DEFAULT NOW()
);
INSERT INTO cat_estatus_visita (clave, nombre, marca_no_abrio, orden) VALUES
  ('no_abrio','No abrió puerta',TRUE,0),
  ('con_prisa','Tenía prisa',TRUE,1),
  ('sin_info','No dio información',TRUE,2),
  ('otro','Otro motivo',FALSE,3)
ON CONFLICT (clave) DO NOTHING;
`).catch((e) => console.warn('Migration (catalogos/perfil):', e?.message));
async function logAuditoria(userId, usuarioNombre, accion, entidad, entidadId, detalle) {
    try {
        await pool.query('INSERT INTO auditoria (id, usuario_id, usuario_nombre, accion, entidad, entidad_id, detalle) VALUES ($1,$2,$3,$4,$5,$6,$7)', [crypto_1.default.randomUUID(), userId || null, usuarioNombre || null, accion, entidad, entidadId || null, detalle ? JSON.stringify(detalle) : null]);
    }
    catch (e) {
        console.warn('logAuditoria error:', e);
    }
}
const routingService = new Rutas_1.RoutingService(pool);
const eventService = new Eventos_1.EventService(pool);
const notificacionService = new Notificaciones_1.NotificacionService(pool);
// Motivo de puerta / estatus de visita: acepta claves del catálogo cat_estatus_visita
// (además de los valores legados) para que el select crezca sin tocar código.
const MOTIVOS_PUERTA_BASE = ['no_abrio', 'sin_info', 'con_prisa', 'otro'];
async function validarMotivoPuerta(v) {
    const s = String(v ?? '').trim().toLowerCase().slice(0, 30);
    if (!s)
        return null;
    try {
        const r = await pool.query('SELECT 1 FROM cat_estatus_visita WHERE clave=$1 AND activo=TRUE', [s]);
        if (r.rows.length)
            return s;
    }
    catch { /* tabla puede no existir todavía */ }
    return MOTIVOS_PUERTA_BASE.includes(s) ? s : null;
}
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
const JWT_EXPIRES_IN = '24h';
// Web Push (VAPID)
const vapidPublicKey = process.env.VAPID_PUBLIC_KEY || '';
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || '';
const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@colmena.app';
if (vapidPublicKey && vapidPrivateKey) {
    web_push_1.default.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
}
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader?.split(' ')[1];
    if (!token) {
        res.status(401).json({ error: 'Token requerido' });
        return;
    }
    jsonwebtoken_1.default.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            res.status(403).json({ error: 'Token inválido' });
            return;
        }
        req.user = user;
        next();
    });
};
app.set('trust proxy', 1);
app.use((0, helmet_1.default)());
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '10mb' }));
app.use(express_1.default.urlencoded({ extended: true }));
app.use('/uploads', express_1.default.static(path_1.default.join(__dirname, '../uploads')));
app.use('/api/', (0, express_rate_limit_1.default)({ windowMs: 15 * 60 * 1000, max: 50000, standardHeaders: true, legacyHeaders: false, skipFailedRequests: true, message: { error: 'Demasiadas solicitudes, intente más tarde' } }));
app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') {
        res.status(400).json({ error: 'Formato JSON inválido' });
        return;
    }
    console.error('Error no manejado:', err);
    res.status(500).json({ error: 'Error interno' });
});
io.on('connection', (socket) => {
    const authSocket = socket;
    console.log('Cliente conectado:', authSocket.id);
    authSocket.on('authenticate', async (token) => {
        try {
            const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
            authSocket.userId = decoded.userId;
            authSocket.rol = decoded.rol;
            authSocket.join(`user_${decoded.userId}`);
            authSocket.emit('authenticated', { success: true });
        }
        catch {
            authSocket.emit('auth_error', { message: 'Token inválido' });
        }
    });
});
app.get('/api/health', (_req, res) => res.json({ status: 'healthy', timestamp: new Date().toISOString(), uptime: process.uptime() }));
const requireAdmin = (req, res, next) => {
    if (req.user?.rol !== 'admin') {
        res.status(403).json({ error: 'Solo administradores' });
        return;
    }
    next();
};
const requireAdminOCoordinador = (req, res, next) => {
    if (!esAdminOCoordinador(req.user)) {
        res.status(403).json({ error: 'Solo administradores y coordinadores' });
        return;
    }
    next();
};
async function getUserSecciones(userId) {
    try {
        const r = await pool.query('SELECT seccion_id FROM usuarios_secciones WHERE usuario_id = $1', [userId]);
        return r.rows.map((x) => x.seccion_id);
    }
    catch {
        return [];
    }
}
async function emitirRefreshToken(usuarioId) {
    const rt = crypto_1.default.randomBytes(48).toString('base64url');
    const hash = crypto_1.default.createHash('sha256').update(rt).digest('hex');
    await pool.query('INSERT INTO refresh_tokens (usuario_id, token_hash, expira_en) VALUES ($1,$2,NOW() + interval \'90 days\')', [usuarioId, hash]);
    return rt;
}
function hashRefreshToken(rt) {
    return crypto_1.default.createHash('sha256').update(rt).digest('hex');
}
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        res.status(400).json({ error: 'Correo/usuario y contrasena requeridos' });
        return;
    }
    try {
        const result = await pool.query(`SELECT id, nombre, email, username, password_hash, rol, municipio_id, telefono FROM usuarios WHERE email = $1 OR nombre = $1 OR username = $1`, [email]);
        if (!result.rows.length) {
            res.status(401).json({ error: 'Credenciales inválidas' });
            return;
        }
        const user = result.rows[0];
        if (!(await bcryptjs_1.default.compare(password, user.password_hash))) {
            res.status(401).json({ error: 'Credenciales inválidas' });
            return;
        }
        const secciones = await getUserSecciones(user.id);
        const token = jsonwebtoken_1.default.sign({ userId: user.id, email: user.email, rol: user.rol, municipio_id: user.municipio_id }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        const refreshToken = await emitirRefreshToken(user.id);
        await logAuditoria(user.id, user.nombre, 'login', 'usuarios', user.id).catch(() => { });
        res.json({ token, refresh_token: refreshToken, user: { id: user.id, nombre: user.nombre, email: user.email, username: user.username, rol: user.rol, municipio_id: user.municipio_id, telefono: user.telefono, secciones } });
    }
    catch (error) {
        console.error('Error en login:', error);
        res.status(500).json({ error: 'Error interno' });
    }
});
app.post('/api/auth/refresh', async (req, res) => {
    const { refresh_token } = req.body || {};
    if (!refresh_token) {
        res.status(400).json({ error: 'refresh_token requerido' });
        return;
    }
    try {
        const hash = hashRefreshToken(refresh_token);
        const r = await pool.query(`SELECT u.id, u.nombre, u.email, u.username, u.rol, u.municipio_id, u.telefono
       FROM refresh_tokens rt JOIN usuarios u ON u.id = rt.usuario_id
       WHERE rt.token_hash=$1 AND rt.expira_en > NOW()`, [hash]);
        if (!r.rows.length) {
            res.status(401).json({ error: 'Sesión expirada, inicia sesión de nuevo' });
            return;
        }
        const u = r.rows[0];
        await pool.query('DELETE FROM refresh_tokens WHERE token_hash=$1', [hash]);
        const token = jsonwebtoken_1.default.sign({ userId: u.id, email: u.email, rol: u.rol, municipio_id: u.municipio_id }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
        const refreshToken = await emitirRefreshToken(u.id);
        const secciones = await getUserSecciones(u.id);
        res.json({ token, refresh_token: refreshToken, user: { id: u.id, nombre: u.nombre, email: u.email, username: u.username, rol: u.rol, municipio_id: u.municipio_id, telefono: u.telefono, secciones } });
    }
    catch (e) {
        console.error('Error en refresh:', e?.message || e);
        res.status(500).json({ error: 'Error interno' });
    }
});
app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const r = await pool.query('SELECT id, nombre, email, username, rol, municipio_id, telefono FROM usuarios WHERE id=$1', [req.user.userId]);
        if (!r.rows.length) {
            res.status(404).json({ error: 'No encontrado' });
            return;
        }
        const user = r.rows[0];
        const secciones = await getUserSecciones(user.id);
        res.json({ ...user, secciones });
    }
    catch {
        res.status(500).json({ error: 'Error' });
    }
});
app.post('/api/auth/logout', async (req, res) => {
    try {
        const { refresh_token } = req.body || {};
        if (refresh_token)
            await pool.query('DELETE FROM refresh_tokens WHERE token_hash=$1', [hashRefreshToken(refresh_token)]);
        res.json({ message: 'Sesion cerrada' });
    }
    catch {
        res.json({ message: 'Sesion cerrada' });
    }
});
app.post('/api/auth/solicitar-reseteo', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            res.status(400).json({ error: 'Email requerido' });
            return;
        }
        const user = await pool.query('SELECT id, nombre, email FROM usuarios WHERE email=$1', [email]);
        if (user.rows.length) {
            const u = user.rows[0];
            const sockets = await io.fetchSockets();
            sockets.forEach(s => { if (s.userId)
                s.emit('solicitud-reseteo', { email: u.email, nombre: u.nombre }); });
            const admins = (await pool.query('SELECT id FROM usuarios WHERE rol=$1', ['admin'])).rows.map((r) => r.id);
            await notificacionService.enviarPushAUsuarios(admins, 'Solicitud de reseteo', `${u.nombre} (${u.email}) solicito restablecer su contrasena`);
            await pool.query('INSERT INTO notificaciones (usuario_id, tipo, mensaje) VALUES ($1,$2,$3)', [u.id, 'solicitud_reseteo', 'Solicitud de restablecimiento de contrasena']);
        }
        res.json({ message: 'Si el correo existe, tu administrador recibira una notificacion' });
    }
    catch {
        res.status(500).json({ error: 'Error' });
    }
});
app.put('/api/auth/password', authenticateToken, async (req, res) => {
    try {
        const { password_actual, password_nueva } = req.body;
        if (!password_actual || !password_nueva) {
            res.status(400).json({ error: 'Ambas contrasenas requeridas' });
            return;
        }
        if (password_nueva.length < 4) {
            res.status(400).json({ error: 'La nueva contrasena debe tener al menos 4 caracteres' });
            return;
        }
        const user = await pool.query('SELECT password_hash FROM usuarios WHERE id=$1', [req.user.userId]);
        if (!user.rows.length) {
            res.status(404).json({ error: 'Usuario no encontrado' });
            return;
        }
        if (!(await bcryptjs_1.default.compare(password_actual, user.rows[0].password_hash))) {
            res.status(401).json({ error: 'Contrasena actual incorrecta' });
            return;
        }
        const hash = await bcryptjs_1.default.hash(password_nueva, 10);
        await pool.query('UPDATE usuarios SET password_hash=$1 WHERE id=$2', [hash, req.user.userId]);
        await notificacionService.enviarPushAUsuarios([req.user.userId], 'Contrasena actualizada', 'Tu contrasena fue cambiada exitosamente');
        res.json({ message: 'Contrasena actualizada' });
    }
    catch {
        res.status(500).json({ error: 'Error al actualizar' });
    }
});
app.get('/api/usuarios', authenticateToken, requireAdminOCoordinador, async (_req, res) => {
    try {
        const result = await pool.query(`
      SELECT u.id, u.nombre, u.email, u.username, u.rol, u.municipio_id, u.telefono, m.nombre as municipio,
      COALESCE(json_agg(DISTINCT jsonb_build_object('id', us.seccion_id)) FILTER (WHERE us.seccion_id IS NOT NULL), '[]') as secciones,
      COALESCE(json_agg(DISTINCT jsonb_build_object('id', rc.casilla_id)) FILTER (WHERE rc.casilla_id IS NOT NULL), '[]') as casillas,
      scc.seccional_id
      FROM usuarios u
      LEFT JOIN municipios m ON m.id = u.municipio_id
      LEFT JOIN usuarios_secciones us ON us.usuario_id = u.id
      LEFT JOIN representantes_casillas rc ON rc.representante_id = u.id
      LEFT JOIN seccional_capturistas scc ON scc.capturista_id = u.id
      GROUP BY u.id, u.nombre, u.email, u.username, u.rol, u.municipio_id, u.telefono, m.nombre, scc.seccional_id
      ORDER BY u.nombre
    `);
        res.json(result.rows.map((r) => ({ ...r, secciones: r.secciones.map((s) => s.id), casillas: r.casillas.map((c) => c.id) })));
    }
    catch {
        res.status(500).json({ error: 'Error al obtener usuarios' });
    }
});
app.post('/api/usuarios', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        const { nombre, email, username, password, rol, municipio_id, telefono, secciones, casillas, seccional_id } = req.body;
        if (!nombre || !email || !password || !rol) {
            res.status(400).json({ error: 'Faltan datos' });
            return;
        }
        const hash = await bcryptjs_1.default.hash(password, 10);
        const user = await pool.query('INSERT INTO usuarios (nombre, email, username, password_hash, rol, municipio_id, telefono) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [nombre, email, username || null, hash, rol, municipio_id || null, telefono || '']);
        const userId = user.rows[0].id;
        if (secciones?.length && rol === 'enlace') {
            const vals = secciones.map((_, i) => `($1,$${i + 2})`).join(',');
            await pool.query(`INSERT INTO usuarios_secciones (usuario_id, seccion_id) VALUES ${vals} ON CONFLICT DO NOTHING`, [userId, ...secciones]);
        }
        if (casillas?.length && rol === 'representante') {
            if (casillas.length > 1) {
                res.status(400).json({ error: 'Solo se puede asignar una casilla por representante' });
                return;
            }
            const ocupadas = (await pool.query('SELECT casilla_id FROM representantes_casillas WHERE casilla_id = ANY($1) AND representante_id != $2', [casillas, userId])).rows.map((r) => r.casilla_id);
            if (ocupadas.length) {
                res.status(409).json({ error: `Casillas ya asignadas a otro representante: ${ocupadas.join(', ')}` });
                return;
            }
            const vals = casillas.map((_, i) => `($1,$${i + 2})`).join(',');
            await pool.query(`INSERT INTO representantes_casillas (representante_id, casilla_id) VALUES ${vals} ON CONFLICT DO NOTHING`, [userId, ...casillas]);
        }
        if (rol === 'capturista' && seccional_id) {
            await pool.query('INSERT INTO seccional_capturistas (seccional_id, capturista_id) VALUES ($1,$2) ON CONFLICT (capturista_id) DO NOTHING', [seccional_id, userId]);
        }
        res.json({ id: userId, nombre, email, rol });
    }
    catch (e) {
        res.status(500).json({ error: e.message || 'Error al crear usuario' });
    }
});
app.put('/api/usuarios/:id', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        const { nombre, email, username, password, rol, municipio_id, telefono, secciones, casillas, seccional_id } = req.body;
        if (password) {
            const hash = await bcryptjs_1.default.hash(password, 10);
            await pool.query('UPDATE usuarios SET nombre=$1, email=$2, username=$3, password_hash=$4, rol=$5, municipio_id=$6, telefono=$7 WHERE id=$8', [nombre, email, username || null, hash, rol, municipio_id || null, telefono || '', req.params.id]);
        }
        else {
            await pool.query('UPDATE usuarios SET nombre=$1, email=$2, username=$3, rol=$4, municipio_id=$5, telefono=$6 WHERE id=$7', [nombre, email, username || null, rol, municipio_id || null, telefono || '', req.params.id]);
        }
        await pool.query('DELETE FROM usuarios_secciones WHERE usuario_id=$1', [req.params.id]);
        if (secciones?.length && rol === 'enlace') {
            const vals = secciones.map((_, i) => `($1,$${i + 2})`).join(',');
            await pool.query(`INSERT INTO usuarios_secciones (usuario_id, seccion_id) VALUES ${vals} ON CONFLICT DO NOTHING`, [req.params.id, ...secciones]);
        }
        if (rol === 'representante') {
            await pool.query('DELETE FROM representantes_casillas WHERE representante_id=$1', [req.params.id]);
            if (casillas?.length) {
                if (casillas.length > 1) {
                    res.status(400).json({ error: 'Solo se puede asignar una casilla por representante' });
                    return;
                }
                const ocupadas = (await pool.query('SELECT casilla_id FROM representantes_casillas WHERE casilla_id = ANY($1) AND representante_id != $2', [casillas, req.params.id])).rows.map((r) => r.casilla_id);
                if (ocupadas.length) {
                    res.status(409).json({ error: `Casillas ya asignadas a otro representante: ${ocupadas.join(', ')}` });
                    return;
                }
                const vals = casillas.map((_, i) => `($1,$${i + 2})`).join(',');
                await pool.query(`INSERT INTO representantes_casillas (representante_id, casilla_id) VALUES ${vals} ON CONFLICT DO NOTHING`, [req.params.id, ...casillas]);
            }
        }
        else {
            await pool.query('DELETE FROM representantes_casillas WHERE representante_id=$1', [req.params.id]);
        }
        if (rol === 'capturista') {
            if (seccional_id) {
                await pool.query('INSERT INTO seccional_capturistas (seccional_id, capturista_id) VALUES ($1,$2) ON CONFLICT (capturista_id) DO UPDATE SET seccional_id=EXCLUDED.seccional_id', [seccional_id, req.params.id]);
            }
        }
        else {
            await pool.query('DELETE FROM seccional_capturistas WHERE capturista_id=$1', [req.params.id]);
        }
        res.json({ message: 'Usuario actualizado' });
    }
    catch (e) {
        res.status(500).json({ error: e.message || 'Error al actualizar' });
    }
});
app.delete('/api/usuarios/:id', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM rutas WHERE enlace_id=$1 OR admin_id=$1', [req.params.id]);
        await client.query('DELETE FROM eventos WHERE creado_por=$1', [req.params.id]);
        await client.query('DELETE FROM ubicaciones_enlace WHERE user_id=$1', [req.params.id]);
        await client.query('DELETE FROM push_subscriptions WHERE user_id=$1', [req.params.id]);
        await client.query('DELETE FROM notificaciones WHERE usuario_id=$1', [req.params.id]);
        await client.query('DELETE FROM usuarios_secciones WHERE usuario_id=$1', [req.params.id]);
        await client.query('DELETE FROM representantes_casillas WHERE representante_id=$1', [req.params.id]);
        await client.query('DELETE FROM dispositivos WHERE usuario_id=$1', [req.params.id]);
        const result = await client.query('DELETE FROM usuarios WHERE id=$1', [req.params.id]);
        await client.query('COMMIT');
        if (!result.rowCount) {
            res.status(404).json({ error: 'Usuario no encontrado' });
            return;
        }
        res.json({ message: 'Usuario eliminado' });
    }
    catch {
        await client.query('ROLLBACK').catch(() => { });
        res.status(500).json({ error: 'Error al eliminar' });
    }
    finally {
        client.release();
    }
});
app.post('/api/usuarios/:id/reset-password', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        const u = (await pool.query('SELECT id, nombre, telefono FROM usuarios WHERE id=$1', [req.params.id])).rows[0];
        if (!u) {
            res.status(404).json({ error: 'Usuario no encontrado' });
            return;
        }
        const nueva = Math.random().toString(36).slice(-8);
        const hash = await bcryptjs_1.default.hash(nueva, 10);
        await pool.query('UPDATE usuarios SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
        await notificacionService.enviarPushAUsuarios([req.params.id], 'Contrasena restablecida', `Tu nueva contrasena es: ${nueva}`);
        if (u.telefono)
            await notificacionService.enviarWhatsApp(u.telefono, `Hola ${u.nombre}, tu nueva contrasena de Colmena es: ${nueva}`);
        const sockets = await io.fetchSockets();
        sockets.forEach(s => { if (s.userId === req.params.id)
            s.emit('password-reset', { password: nueva }); });
        res.json({ message: 'Contrasena restablecida', password: nueva });
    }
    catch {
        res.status(500).json({ error: 'Error al resetear' });
    }
});
app.get('/api/estados', async (_req, res) => {
    try {
        const result = await pool.query('SELECT id, nombre, abreviatura, es_default FROM estados ORDER BY nombre');
        res.json(result.rows);
    }
    catch {
        res.status(500).json({ error: 'Error al obtener estados' });
    }
});
app.get('/api/estados/default', async (_req, res) => {
    try {
        const result = await pool.query('SELECT id, nombre, abreviatura FROM estados WHERE es_default = TRUE LIMIT 1');
        if (!result.rows.length) {
            res.json(null);
            return;
        }
        res.json(result.rows[0]);
    }
    catch {
        res.status(500).json({ error: 'Error al obtener default' });
    }
});
app.post('/api/estados', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        const { id, nombre, abreviatura, es_default } = req.body;
        if (!id || !nombre) {
            res.status(400).json({ error: 'id y nombre requeridos' });
            return;
        }
        if (es_default)
            await pool.query('UPDATE estados SET es_default=FALSE WHERE es_default=TRUE');
        await pool.query('INSERT INTO estados (id, nombre, abreviatura, es_default) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET nombre=$2,abreviatura=$3,es_default=$4', [id, nombre, abreviatura || null, !!es_default]);
        res.status(201).json({ message: 'Estado guardado' });
    }
    catch {
        res.status(500).json({ error: 'Error al guardar estado' });
    }
});
app.put('/api/estados/:id', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        const { nombre, abreviatura, es_default } = req.body;
        if (es_default)
            await pool.query('UPDATE estados SET es_default=FALSE WHERE es_default=TRUE');
        await pool.query('UPDATE estados SET nombre=$1, abreviatura=$2, es_default=$3 WHERE id=$4', [nombre, abreviatura || null, !!es_default, req.params.id]);
        res.json({ message: 'Estado actualizado' });
    }
    catch {
        res.status(500).json({ error: 'Error al actualizar' });
    }
});
app.delete('/api/estados/:id', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        await pool.query('DELETE FROM estados WHERE id=$1', [req.params.id]);
        res.json({ message: 'Estado eliminado' });
    }
    catch {
        res.status(500).json({ error: 'Error al eliminar' });
    }
});
app.get('/api/municipios', async (_req, res) => {
    try {
        const result = await pool.query('SELECT m.id, m.nombre, m.estado_id, m.lat, m.lng, m.es_default, e.nombre as estado FROM municipios m JOIN estados e ON e.id = m.estado_id ORDER BY e.nombre, m.nombre');
        res.json(result.rows);
    }
    catch {
        res.status(500).json({ error: 'Error al obtener municipios' });
    }
});
app.get('/api/municipios/default', async (_req, res) => {
    try {
        const result = await pool.query('SELECT id, nombre, lat, lng, estado_id FROM municipios WHERE es_default = TRUE LIMIT 1');
        if (!result.rows.length) {
            res.json(null);
            return;
        }
        res.json(result.rows[0]);
    }
    catch {
        res.status(500).json({ error: 'Error al obtener default' });
    }
});
app.get('/api/municipios/:estadoId', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, nombre, lat, lng, es_default FROM municipios WHERE estado_id = $1 ORDER BY nombre', [req.params.estadoId]);
        res.json(result.rows);
    }
    catch {
        res.status(500).json({ error: 'Error al obtener municipios' });
    }
});
app.post('/api/municipios', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        const { id, nombre, estado_id, lat, lng, es_default } = req.body;
        if (!id || !nombre || !estado_id) {
            res.status(400).json({ error: 'id, nombre y estado_id requeridos' });
            return;
        }
        if (es_default)
            await pool.query('UPDATE municipios SET es_default=FALSE WHERE es_default=TRUE');
        await pool.query('INSERT INTO municipios (id, nombre, estado_id, lat, lng, es_default) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET nombre=$2, estado_id=$3, lat=$4, lng=$5, es_default=$6', [id, nombre, estado_id, lat || null, lng || null, !!es_default]);
        res.status(201).json({ message: 'Municipio guardado' });
    }
    catch {
        res.status(500).json({ error: 'Error al guardar municipio' });
    }
});
app.put('/api/municipios/:id', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        const { nombre, estado_id, lat, lng, es_default } = req.body;
        if (es_default)
            await pool.query('UPDATE municipios SET es_default=FALSE WHERE es_default=TRUE');
        await pool.query('UPDATE municipios SET nombre=$1, estado_id=$2, lat=$3, lng=$4, es_default=$5 WHERE id=$6', [nombre, estado_id, lat || null, lng || null, !!es_default, req.params.id]);
        res.json({ message: 'Municipio actualizado' });
    }
    catch {
        res.status(500).json({ error: 'Error al actualizar' });
    }
});
app.delete('/api/municipios/:id', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        await pool.query('DELETE FROM municipios WHERE id=$1', [req.params.id]);
        res.json({ message: 'Municipio eliminado' });
    }
    catch {
        res.status(500).json({ error: 'Error al eliminar' });
    }
});
app.get('/api/secciones', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        let query = `SELECT s.id, s.municipio_id, s.tipo, s.meta, m.nombre as municipio, m.estado_id
                 FROM secciones_electorales s
                 JOIN municipios m ON m.id = s.municipio_id`;
        const params = [];
        if (user.rol === 'enlace') {
            const secs = await getUserSecciones(user.userId);
            if (secs.length) {
                params.push(secs);
                query += ` WHERE s.id = ANY($${params.length})`;
            }
        }
        query += ' ORDER BY s.id';
        const result = await pool.query(query, params);
        res.json(result.rows);
    }
    catch {
        res.status(500).json({ error: 'Error al obtener secciones' });
    }
});
app.get('/api/secciones/:municipioId', async (req, res) => {
    try {
        const { excluir_usuario, rol } = req.query;
        const soloExclusivo = rol === 'enlace';
        const result = await pool.query(`
      SELECT s.id, s.tipo, s.meta,
        ${soloExclusivo ? `(SELECT us.usuario_id FROM usuarios_secciones us JOIN usuarios u ON u.id = us.usuario_id WHERE us.seccion_id = s.id AND u.rol = 'enlace' ${excluir_usuario ? 'AND us.usuario_id != $2' : ''}) as asignada_a` : 'NULL as asignada_a'}
      FROM secciones_electorales s WHERE s.municipio_id = $1 ORDER BY s.id`, soloExclusivo && excluir_usuario ? [req.params.municipioId, excluir_usuario] : [req.params.municipioId]);
        res.json(result.rows);
    }
    catch (e) {
        console.error('Error en /api/secciones/:municipioId', e.message || e);
        res.status(500).json({ error: 'Error al obtener secciones' });
    }
});
app.post('/api/secciones', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        const { id, municipio_id, tipo, meta } = req.body;
        if (!id || !municipio_id) {
            res.status(400).json({ error: 'id y municipio_id requeridos' });
            return;
        }
        await pool.query('INSERT INTO secciones_electorales (id, municipio_id, tipo, meta) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET municipio_id=$2, tipo=$3, meta=$4', [id, municipio_id, tipo || 'urbana', parseInt(meta) || 0]);
        res.status(201).json({ message: 'Sección guardada' });
    }
    catch {
        res.status(500).json({ error: 'Error al guardar sección' });
    }
});
app.put('/api/secciones/:id', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        const { municipio_id, tipo, meta } = req.body;
        await pool.query('UPDATE secciones_electorales SET municipio_id=$1, tipo=$2, meta=$3 WHERE id=$4', [municipio_id, tipo, parseInt(meta) || 0, req.params.id]);
        res.json({ message: 'Sección actualizada' });
    }
    catch {
        res.status(500).json({ error: 'Error al actualizar' });
    }
});
app.delete('/api/secciones/:id', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        await pool.query('DELETE FROM secciones_electorales WHERE id=$1', [req.params.id]);
        res.json({ message: 'Sección eliminada' });
    }
    catch {
        res.status(500).json({ error: 'Error al eliminar' });
    }
});
app.get('/api/secciones/:id/centroid', authenticateToken, async (req, res) => {
    try {
        const r = await pool.query(`SELECT ST_X(ST_Centroid(geom)) as lng, ST_Y(ST_Centroid(geom)) as lat
       FROM seccion_geo WHERE seccion = $1::numeric AND entidad = 11`, [req.params.id]);
        if (!r.rows.length) {
            res.status(404).json({ error: 'Geometría no encontrada' });
            return;
        }
        res.json({ lat: r.rows[0].lat, lng: r.rows[0].lng });
    }
    catch {
        res.status(500).json({ error: 'Error al obtener centroide' });
    }
});
// Proxy for CP lookup (avoid CORS issues)
app.get('/api/cp/:codigo', async (req, res) => {
    try {
        const { codigo } = req.params;
        if (!/^\d{5}$/.test(codigo)) {
            res.status(400).json({ error: 'CP invalido' });
            return;
        }
        let data;
        // Try cp.terio.dev (lightweight, fast, CORS-enabled, works from containers)
        try {
            const r = await fetch(`https://cp.terio.dev/v1/codigos-postales/${codigo}`, { signal: AbortSignal.timeout(3000) });
            if (r.ok) {
                const json = await r.json();
                if (json.datos?.length) {
                    data = {
                        colonias: json.datos.map((d) => d.asentamiento).filter(Boolean),
                        municipio: json.datos[0].municipio,
                        estado: json.datos[0].estado,
                        codigo_estado: json.datos[0].codigo_estado
                    };
                }
            }
        }
        catch (e) {
            console.warn('Error consultando INE:', e);
        }
        if (!data) {
            try {
                const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&postalcode=${codigo}&countrycodes=MX&limit=20`, { signal: AbortSignal.timeout(5000) });
                if (r.ok) {
                    const json = await r.json();
                    if (Array.isArray(json)) {
                        const colonias = [...new Set(json.map((d) => d.address?.suburb || d.address?.neighbourhood || d.address?.hamlet || d.address?.village || d.address?.town || d.address?.city).filter(Boolean))];
                        if (colonias.length)
                            data = { colonias };
                    }
                }
            }
            catch (e) {
                console.warn('Error consultando Nominatim:', e);
            }
        }
        if (data)
            res.json(data);
        else
            res.status(404).json({ error: 'No se encontraron colonias' });
    }
    catch {
        res.status(502).json({ error: 'Error al consultar CP' });
    }
});
async function getR2Config() {
    try {
        const r = await pool.query("SELECT clave, valor FROM configuracion WHERE clave IN ('r2_account_id','r2_access_key_id','r2_secret_access_key','r2_bucket','r2_public_url')");
        const cfg = {};
        r.rows.forEach((x) => cfg[x.clave] = x.valor);
        if (!cfg.r2_account_id || !cfg.r2_access_key_id || !cfg.r2_secret_access_key || !cfg.r2_bucket || !cfg.r2_public_url) {
            return { activo: false };
        }
        const client = new client_s3_1.S3Client({
            region: 'auto',
            endpoint: `https://${cfg.r2_account_id}.r2.cloudflarestorage.com`,
            credentials: { accessKeyId: cfg.r2_access_key_id, secretAccessKey: cfg.r2_secret_access_key },
            forcePathStyle: true
        });
        return { activo: true, client, bucket: cfg.r2_bucket, publicUrl: cfg.r2_public_url.replace(/\/+$/, '') };
    }
    catch (e) {
        console.warn('getR2Config:', e?.message || e);
        return { activo: false };
    }
}
async function subirAR2(client, bucket, filename, buf, contentType) {
    await client.send(new client_s3_1.PutObjectCommand({
        Bucket: bucket,
        Key: filename,
        Body: buf,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable'
    }));
}
app.post('/api/upload', authenticateToken, async (req, res) => {
    try {
        const { image } = req.body;
        if (!image || typeof image !== 'string' || !image.startsWith('data:image/')) {
            res.status(400).json({ error: 'Imagen inválida' });
            return;
        }
        const base64 = image.split(',')[1];
        if (!base64) {
            res.status(400).json({ error: 'Imagen inválida' });
            return;
        }
        const buf = Buffer.from(base64, 'base64');
        const filename = crypto_1.default.randomUUID() + '.jpg';
        const r2 = await getR2Config();
        if (r2.activo && r2.client && r2.bucket && r2.publicUrl) {
            await subirAR2(r2.client, r2.bucket, filename, await (0, sharp_1.default)(buf).resize(1200, 1200, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer(), 'image/jpeg');
            res.json({ url: r2.publicUrl + '/' + filename });
            return;
        }
        const outputPath = path_1.default.join(__dirname, '../uploads/evidencias', filename);
        await (0, sharp_1.default)(buf).resize(1200, 1200, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toFile(outputPath);
        res.json({ url: '/uploads/evidencias/' + filename });
    }
    catch {
        res.status(500).json({ error: 'Error al subir imagen' });
    }
});
app.post('/api/config/r2/test', authenticateToken, requireAdmin, async (_req, res) => {
    try {
        const r2 = await getR2Config();
        if (!r2.activo || !r2.client || !r2.bucket) {
            res.status(400).json({ error: 'Faltan datos de configuración R2 (completa los 5 campos)' });
            return;
        }
        const lista = await r2.client.send(new client_s3_1.ListObjectsV2Command({ Bucket: r2.bucket, MaxKeys: 1 }));
        res.json({ ok: true, bucket: r2.bucket, objetos: lista.Contents?.length || 0, publicUrl: r2.publicUrl });
    }
    catch (e) {
        res.status(500).json({ error: 'No se pudo conectar a R2: ' + (e?.message || e) });
    }
});
app.post('/api/upload/migrate-r2', authenticateToken, requireAdmin, async (_req, res) => {
    try {
        const r2 = await getR2Config();
        if (!r2.activo || !r2.client || !r2.bucket || !r2.publicUrl) {
            res.status(400).json({ error: 'Configura Cloudflare R2 antes de migrar' });
            return;
        }
        const dir = path_1.default.join(__dirname, '../uploads/evidencias');
        let archivos = [];
        try {
            archivos = fs_1.default.readdirSync(dir).filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
        }
        catch {
            archivos = [];
        }
        let subidos = 0, yaExistentes = 0;
        for (const f of archivos) {
            try {
                await r2.client.send(new client_s3_1.HeadObjectCommand({ Bucket: r2.bucket, Key: f }));
                yaExistentes++;
                continue;
            }
            catch { /* no existe, se sube */ }
            const buf = fs_1.default.readFileSync(path_1.default.join(dir, f));
            await subirAR2(r2.client, r2.bucket, f, buf, f.endsWith('.png') ? 'image/png' : 'image/jpeg');
            subidos++;
        }
        const prefijoLocal = '/uploads/evidencias/';
        const prefijoR2 = r2.publicUrl + '/';
        const columnas = [
            ['incidencias', 'evidencia'],
            ['ciudadanos', 'evidencia'],
            ['ciudadanos_comprometidos', 'evidencia']
        ];
        let filasActualizadas = 0;
        for (const [tabla, col] of columnas) {
            try {
                const u = await pool.query(`UPDATE ${tabla} SET ${col} = replace(${col}, $1, $2) WHERE ${col} LIKE '%' || $1 || '%'`, [prefijoLocal, prefijoR2]);
                filasActualizadas += u.rowCount || 0;
            }
            catch (e) {
                console.warn(`Migrar columna ${tabla}.${col}:`, e?.message);
            }
        }
        try {
            const ur = await pool.query(`UPDATE rutas SET paradas = replace(paradas::text, $1, $2)::jsonb WHERE paradas::text LIKE '%' || $1 || '%'`, [prefijoLocal, prefijoR2]);
            filasActualizadas += ur.rowCount || 0;
        }
        catch (e) {
            console.warn('Migrar rutas.paradas:', e?.message);
        }
        try {
            const ul = await pool.query(`UPDATE configuracion SET valor = replace(valor, $1, $2) WHERE clave='logo' AND valor LIKE '%' || $1 || '%'`, [prefijoLocal, prefijoR2]);
            filasActualizadas += ul.rowCount || 0;
        }
        catch (e) {
            console.warn('Migrar logo:', e?.message);
        }
        res.json({ subidos, yaExistentes, filasActualizadas, totalArchivos: archivos.length, publicUrl: r2.publicUrl });
    }
    catch (e) {
        res.status(500).json({ error: 'Error al migrar: ' + (e?.message || e) });
    }
});
app.post('/api/ciudadanos', authenticateToken, async (req, res) => {
    try {
        const { seccion_id, numero_hogar, nombre, apellido_paterno, apellido_materno, telefono, calle, numero, colonia, cp, lat, lng, prioridad, intencion_voto_presidente, intencion_voto_diputado, notas, edad, idempotency_key, casilla_id, votantes_casa, no_abrio, votantes_casa_list, encuesta_campana_id } = req.body;
        const motivoRaw = req.body.motivo_puerta;
        const motivoPuerta = await validarMotivoPuerta(motivoRaw);
        const noAbrioFinal = !!no_abrio || !!motivoPuerta;
        if (!seccion_id || (!nombre && !noAbrioFinal)) {
            res.status(400).json({ error: 'seccion_id requerido; nombre requerido salvo que no haya abierto' });
            return;
        }
        const nombreFinal = (nombre && (apellido_paterno || apellido_materno)) ? [nombre, apellido_paterno, apellido_materno].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() : (nombre || null);
        const tieneUbicacion = lat != null && lng != null && !Number.isNaN(+lat) && !Number.isNaN(+lng);
        const casillaAuto = casilla_id ? parseInt(casilla_id) : (tieneUbicacion && tieneDireccionValida(req.body) ? await asignarCasillaAutomatica(seccion_id, lat, lng) : null);
        // Idempotency check: if key provided and already processed, return existing record
        if (idempotency_key) {
            const existing = await pool.query('SELECT id FROM ciudadanos WHERE idempotency_key=$1', [idempotency_key]);
            if (existing.rows.length) {
                res.status(200).json({ id: existing.rows[0].id, message: 'Ya existe (idempotente)' });
                try {
                    io.emit('nuevo-ciudadano', { seccion_id, lat, lng, nombre: nombreFinal });
                }
                catch (e) {
                    console.warn('io.emit error:', e);
                }
                return;
            }
        }
        const id = crypto_1.default.randomUUID();
        const ubiSql = 'ST_SetSRID(ST_MakePoint($12,$13),4326)';
        await pool.query(`INSERT INTO ciudadanos (id, seccion_id, numero_hogar, nombre, apellido_paterno, apellido_materno, telefono, calle, numero, colonia, cp, ubicacion, prioridad, intencion_voto_presidente, intencion_voto_diputado, notas, edad, idempotency_key, casilla_id, votantes_casa, no_abrio, created_by, sexo, discapacidad_id, ocupacion_id, motivo_puerta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${ubiSql},$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`, [id, seccion_id, numero_hogar || null, nombreFinal, apellido_paterno || null, apellido_materno || null, telefono || null, calle || null, numero || null, colonia || null, cp || null, tieneUbicacion ? +lng : null, tieneUbicacion ? +lat : null, prioridad || 0, intencion_voto_presidente || null, intencion_voto_diputado || null, notas || null, edad ? parseInt(edad) : null, idempotency_key || null, casillaAuto, votantes_casa ? parseInt(votantes_casa) : 1, noAbrioFinal, req.user?.userId || null,
            ['H', 'M'].includes(req.body.sexo) ? req.body.sexo : null,
            req.body.discapacidad_id ? parseInt(req.body.discapacidad_id) : null,
            req.body.ocupacion_id ? parseInt(req.body.ocupacion_id) : null,
            motivoPuerta]);
        if (encuesta_campana_id) {
            await pool.query('INSERT INTO ciudadanos_encuestas (ciudadano_id, campana_id, asignada_por) VALUES ($1,$2,$3) ON CONFLICT (ciudadano_id) DO UPDATE SET campana_id=$2, asignada_por=$3', [id, encuesta_campana_id, req.user?.userId || null]);
        }
        // Votantes en casa: insertar la lista capturada y completar con acompañantes
        // sin nombre hasta alcanzar el total declarado en `votantes_casa` (incluye al titular).
        const extrasDeclarados = Math.max(0, (votantes_casa ? parseInt(votantes_casa) : 1) - 1);
        const listaVc = Array.isArray(votantes_casa_list) ? votantes_casa_list.slice(0, 20) : [];
        for (let i = 0; i < Math.max(listaVc.length, extrasDeclarados); i++) {
            const v = listaVc[i];
            await pool.query('INSERT INTO votantes_casa (ciudadano_id, nombre, partido_id, partido_diputado_id, pendiente) VALUES ($1,$2,$3,$4,$5)', [id, v?.nombre ? String(v.nombre).slice(0, 100) : null, v?.partido_id || null, v?.partido_diputado_id || null, v ? v.pendiente !== false : true]);
        }
        try {
            await pool.query('INSERT INTO visitas (id, ciudadano_id, usuario_id, tipo, lat, lng) VALUES ($1,$2,$3,$4,$5,$6)', [crypto_1.default.randomUUID(), id, req.user?.userId || null, 'alta', lat || null, lng || null]);
        }
        catch (e) {
            console.warn('visita alta:', e);
        }
        res.status(201).json({ id, message: 'Ciudadano creado' });
        try {
            io.emit('nuevo-ciudadano', { seccion_id, lat, lng, nombre });
        }
        catch (e) {
            console.warn('io.emit error:', e);
        }
        try {
            if (req.body.desde_offline) {
                await sendPushToRole('admin', 'Brigadista reconectado', `${req.user?.nombre || 'Un brigadista'} subió datos pendientes de su recorrido`, '/mapa');
            }
            const u = req.user;
            if (u?.nombre)
                await logAuditoria(u.userId, u.nombre, 'alta_ciudadano', 'ciudadanos', id, { nombre, seccion_id, telefono });
        }
        catch (e) {
            console.warn('post-alta:', e);
        }
    }
    catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error al crear ciudadano' });
    }
});
app.put('/api/ciudadanos/:id', authenticateToken, async (req, res) => {
    try {
        const { nombre, apellido_paterno, apellido_materno, telefono, seccion_id, calle, numero, colonia, cp, lat, lng, prioridad, numero_hogar, intencion_voto_presidente, intencion_voto_diputado, notas, edad, casilla_id, votantes_casa, no_abrio, votantes_casa_list, encuesta_campana_id } = req.body;
        const nombreFinal = (nombre && (apellido_paterno || apellido_materno)) ? [nombre, apellido_paterno, apellido_materno].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() : (nombre || null);
        const tieneUbicacion = lat != null && lng != null && !Number.isNaN(+lat) && !Number.isNaN(+lng);
        const casillaAuto = casilla_id ? parseInt(casilla_id) : (tieneUbicacion && tieneDireccionValida(req.body) ? await asignarCasillaAutomatica(seccion_id, lat, lng) : (casilla_id === null ? null : undefined));
        // Perfil: motivo_puerta controla no_abrio; se puede limpiar enviando null/''
        let motivoPuerta = undefined;
        if (req.body.motivo_puerta !== undefined) {
            motivoPuerta = await validarMotivoPuerta(req.body.motivo_puerta);
        }
        const parts = [];
        const params = [];
        const p = (v) => { params.push(v); return '$' + params.length; };
        const cols = ['nombre', 'apellido_paterno', 'apellido_materno', 'telefono', 'seccion_id', 'calle', 'numero', 'colonia', 'cp'];
        const vals = [nombreFinal, apellido_paterno || null, apellido_materno || null, telefono || null, seccion_id || null, calle || null, numero || null, colonia || null, cp || null];
        parts.push(cols.map((c, i) => c + '=COALESCE(' + p(vals[i]) + ',' + c + ')').join(','));
        if (lat != null && lng != null && !Number.isNaN(+lat) && !Number.isNaN(+lng)) {
            parts.push('ubicacion=ST_SetSRID(ST_MakePoint(' + p(+lng) + ',' + p(+lat) + '),4326)');
        }
        if (casillaAuto !== undefined)
            parts.push('casilla_id=' + p(casillaAuto));
        const cols2 = ['prioridad', 'numero_hogar', 'intencion_voto_presidente', 'intencion_voto_diputado', 'notas', 'edad', 'votantes_casa'];
        const vals2 = [prioridad || 0, numero_hogar || null, intencion_voto_presidente || null, intencion_voto_diputado || null, notas || null, edad || null, votantes_casa ? parseInt(votantes_casa) : null];
        parts.push(cols2.map((c, i) => c + '=COALESCE(' + p(vals2[i]) + ',' + c + ')').join(','));
        if (['H', 'M'].includes(req.body.sexo))
            parts.push('sexo=' + p(req.body.sexo));
        if (req.body.discapacidad_id !== undefined)
            parts.push('discapacidad_id=' + p(req.body.discapacidad_id ? parseInt(req.body.discapacidad_id) : null));
        if (req.body.ocupacion_id !== undefined)
            parts.push('ocupacion_id=' + p(req.body.ocupacion_id ? parseInt(req.body.ocupacion_id) : null));
        if (motivoPuerta !== undefined) {
            parts.push('motivo_puerta=' + p(motivoPuerta));
            parts.push('no_abrio=' + p(!!motivoPuerta || !!no_abrio));
        }
        else if (no_abrio != null)
            parts.push('no_abrio=' + p(!!no_abrio));
        parts.push('updated_at=now()');
        parts.push('updated_by=' + p(req.user?.userId || null));
        params.push(req.params.id);
        await pool.query('UPDATE ciudadanos SET ' + parts.join(',') + ' WHERE id=$' + params.length, params);
        if (encuesta_campana_id !== undefined) {
            const userId = req.user?.userId || null;
            if (encuesta_campana_id) {
                await pool.query('INSERT INTO ciudadanos_encuestas (ciudadano_id, campana_id, asignada_por) VALUES ($1,$2,$3) ON CONFLICT (ciudadano_id) DO UPDATE SET campana_id=$2, asignada_por=$3', [req.params.id, encuesta_campana_id, userId]);
            }
            else {
                await pool.query('DELETE FROM ciudadanos_encuestas WHERE ciudadano_id=$1', [req.params.id]);
            }
        }
        if (Array.isArray(votantes_casa_list)) {
            // Solo se reemplaza lo capturado cuando el formulario envía la lista completa
            await pool.query('DELETE FROM votantes_casa WHERE ciudadano_id=$1', [req.params.id]);
            for (const v of votantes_casa_list.slice(0, 20)) {
                if (!v)
                    continue;
                await pool.query('INSERT INTO votantes_casa (ciudadano_id, nombre, partido_id, partido_diputado_id, pendiente) VALUES ($1,$2,$3,$4,$5)', [req.params.id, v.nombre ? String(v.nombre).slice(0, 100) : null, v.partido_id || null, v.partido_diputado_id || null, v.pendiente !== false]);
            }
        }
        // Mantener acompañantes sin registro acordes al conteo declarado
        // (votantes_casa es el total incluyendo al titular; nunca se borra lo capturado aquí)
        if (votantes_casa !== undefined && votantes_casa !== null && votantes_casa !== '') {
            const deseados = Math.max(0, (parseInt(String(votantes_casa)) || 1) - 1);
            const ex = await pool.query('SELECT COUNT(*)::int AS n FROM votantes_casa WHERE ciudadano_id=$1', [req.params.id]);
            const actuales = ex.rows[0]?.n || 0;
            for (let i = actuales; i < deseados; i++) {
                await pool.query('INSERT INTO votantes_casa (ciudadano_id, nombre, partido_id, partido_diputado_id, pendiente) VALUES ($1, NULL, NULL, NULL, TRUE)', [req.params.id]);
            }
        }
        res.json({ message: 'Ciudadano actualizado' });
        try {
            io.emit('actualizar-ciudadano', { id: req.params.id, seccion_id, lat, lng });
        }
        catch (e) {
            console.warn('io.emit error:', e);
        }
        try {
            await pool.query('INSERT INTO visitas (id, ciudadano_id, usuario_id, tipo, lat, lng) VALUES ($1,$2,$3,$4,$5,$6)', [crypto_1.default.randomUUID(), req.params.id, req.user?.userId || null, 'edicion', lat || null, lng || null]);
            const u = req.user;
            if (u?.nombre)
                await logAuditoria(u.userId, u.nombre, 'editar_ciudadano', 'ciudadanos', req.params.id, { nombre });
        }
        catch (e) {
            console.warn('visita edicion:', e);
        }
    }
    catch (e) {
        console.error('PUT /api/ciudadanos error:', e?.message || e);
        res.status(500).json({ error: 'Error al actualizar' });
    }
});
app.delete('/api/ciudadanos/:id', authenticateToken, async (req, res) => {
    try {
        const rows = await pool.query('SELECT notas FROM ciudadanos WHERE id=$1', [req.params.id]);
        if (rows.rows.length) {
            const notas = rows.rows[0].notas || '';
            if (notas.startsWith('📷 ')) {
                const url = notas.replace('📷 ', '');
                const idx = url.lastIndexOf('/');
                if (idx >= 0) {
                    const fname = url.substring(idx + 1);
                    const fpath = path_1.default.join(__dirname, '../../uploads/evidencias', fname);
                    try {
                        fs_1.default.unlinkSync(fpath);
                    }
                    catch (e) { /* file may not exist */ }
                }
            }
        }
        await pool.query('DELETE FROM ciudadanos WHERE id=$1', [req.params.id]);
        res.json({ message: 'Ciudadano eliminado' });
        try {
            io.emit('eliminar-ciudadano', { id: req.params.id });
        }
        catch (e) {
            console.warn('io.emit error:', e);
        }
    }
    catch {
        res.status(500).json({ error: 'Error al eliminar' });
    }
});
app.delete('/api/ciudadanos/:id/foto', authenticateToken, async (req, res) => {
    try {
        const rows = await pool.query('SELECT notas FROM ciudadanos WHERE id=$1', [req.params.id]);
        if (rows.rows.length) {
            const notas = rows.rows[0].notas || '';
            if (notas.startsWith('📷 ')) {
                const url = notas.replace('📷 ', '');
                const idx = url.lastIndexOf('/');
                if (idx >= 0) {
                    const fname = url.substring(idx + 1);
                    const fpath = path_1.default.join(__dirname, '../../uploads/evidencias', fname);
                    try {
                        fs_1.default.unlinkSync(fpath);
                    }
                    catch (e) { /* file may not exist */ }
                }
            }
            await pool.query('UPDATE ciudadanos SET notas=NULL WHERE id=$1', [req.params.id]);
        }
        res.json({ message: 'Foto eliminada' });
        try {
            io.emit('actualizar-ciudadano', { id: req.params.id });
        }
        catch (e) {
            console.warn('io.emit error:', e);
        }
    }
    catch {
        res.status(500).json({ error: 'Error al eliminar foto' });
    }
});
app.get('/api/ciudadanos', authenticateToken, async (req, res) => {
    try {
        const seccionId = req.query.seccion_id;
        let query = `SELECT c.id, c.seccion_id, c.numero_hogar, c.nombre, c.apellido_paterno, c.apellido_materno, c.telefono, c.calle, c.numero, c.colonia, c.cp, c.edad, c.notas,
                  ST_X(c.ubicacion::geometry) as lng, ST_Y(c.ubicacion::geometry) as lat,
                  c.prioridad, c.timestamp_registro, c.sexo, c.motivo_puerta,
                  c.discapacidad_id, cd.nombre as discapacidad_nombre,
                  c.ocupacion_id, co2.nombre as ocupacion_nombre,
                  c.intencion_voto_presidente, pp.nombre as partido_presidente_nombre, pp.color as partido_presidente_color, pp.abreviatura as partido_presidente_abreviatura,
                  c.intencion_voto_diputado, pd.nombre as partido_diputado_nombre, pd.color as partido_diputado_color, pd.abreviatura as partido_diputado_abreviatura,
                  c.casilla_id, cs.nombre as casilla_nombre, c.votantes_casa, c.no_abrio,
                  c.created_at, c.updated_at, ucb.nombre as creado_por, uub.nombre as editado_por,
                  ce.campana_id as encuesta_campana_id,
                  (v.ciudadano_id IS NOT NULL) as ya_voto,
                  s.id as seccion_num, m.nombre as municipio, e.nombre as estado
                FROM ciudadanos c
                JOIN secciones_electorales s ON s.id = c.seccion_id
                JOIN municipios m ON m.id = s.municipio_id
                JOIN estados e ON e.id = m.estado_id
                LEFT JOIN partidos_politicos pp ON pp.id = c.intencion_voto_presidente
                LEFT JOIN partidos_politicos pd ON pd.id = c.intencion_voto_diputado
                LEFT JOIN casillas cs ON cs.id = c.casilla_id
                LEFT JOIN usuarios ucb ON ucb.id = c.created_by
                LEFT JOIN usuarios uub ON uub.id = c.updated_by
                LEFT JOIN ciudadanos_encuestas ce ON ce.ciudadano_id = c.id
                LEFT JOIN votos v ON v.ciudadano_id = c.id
                LEFT JOIN cat_discapacidades cd ON cd.id = c.discapacidad_id
                LEFT JOIN cat_ocupaciones co2 ON co2.id = c.ocupacion_id`;
        const params = [];
        const conds = [];
        if (seccionId) {
            params.push(seccionId);
            conds.push(`c.seccion_id = $${params.length}`);
        }
        if (conds.length)
            query += ' WHERE ' + conds.join(' AND ');
        query += ' ORDER BY c.timestamp_registro DESC';
        const result = await pool.query(query, params);
        let votantesCasa = [];
        if (result.rows.length) {
            const ids = result.rows.map((r) => r.id);
            const vc = await pool.query('SELECT ciudadano_id, nombre, partido_id, partido_diputado_id, pendiente FROM votantes_casa WHERE ciudadano_id = ANY($1)', [ids]);
            votantesCasa = vc.rows;
        }
        res.json(result.rows.map((r) => ({
            ...r, ubicacion: r.lat ? { lat: r.lat, lng: r.lng } : null,
            partido_presidente: r.partido_presidente_nombre ? { id: r.intencion_voto_presidente, nombre: r.partido_presidente_nombre, color: r.partido_presidente_color, abreviatura: r.partido_presidente_abreviatura } : null,
            partido_diputado: r.partido_diputado_nombre ? { id: r.intencion_voto_diputado, nombre: r.partido_diputado_nombre, color: r.partido_diputado_color, abreviatura: r.partido_diputado_abreviatura } : null,
            votantes_casa_list: votantesCasa.filter((v) => v.ciudadano_id === r.id)
        })));
    }
    catch {
        res.status(500).json({ error: 'Error al listar ciudadanos' });
    }
});
app.get('/api/ciudadanos/duplicados', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (user.rol !== 'admin' && user.rol !== 'coordinador') {
            res.json([]);
            return;
        }
        let where = '';
        const params = [];
        params.push(2);
        const query = `SELECT LOWER(TRIM(c.nombre)) as grupo_clave,
      array_agg(c.id) as ids, array_agg(c.nombre) as nombres, array_agg(c.edad) as edades,
      array_agg(c.calle) as calles, array_agg(c.numero) as numeros, array_agg(c.colonia) as colonias,
      array_agg(c.cp) as cps, array_agg(c.telefono) as telefonos,
      array_agg(c.prioridad) as prioridades,
      array_agg(c.notas) as notas_arr, array_agg(c.seccion_id) as seccion_ids,
      array_agg(c.timestamp_registro) as timestamps,
      array_agg(ST_X(c.ubicacion::geometry)) as lngs, array_agg(ST_Y(c.ubicacion::geometry)) as lats
    FROM ciudadanos c
    JOIN secciones_electorales s ON s.id = c.seccion_id
    ${where}
    GROUP BY LOWER(TRIM(c.nombre)), c.edad, LOWER(TRIM(c.calle)), LOWER(TRIM(c.colonia))
    HAVING COUNT(*) >= $${params.length}
    ORDER BY COUNT(*) DESC, grupo_clave`;
        const result = await pool.query(query, params);
        const groups = result.rows.map((r) => ({
            grupo_clave: r.grupo_clave,
            registros: r.ids.map((id, i) => ({
                id, nombre: r.nombres[i], edad: r.edades[i],
                calle: r.calles[i], numero: r.numeros[i], colonia: r.colonias[i], cp: r.cps[i],
                telefono: r.telefonos[i], prioridad: r.prioridades[i],
                notas: r.notas_arr[i], seccion_id: r.seccion_ids[i],
                timestamp: r.timestamps[i],
                lat: r.lats[i], lng: r.lngs[i]
            }))
        }));
        res.json(groups.filter((g) => g.registros.length >= 2));
    }
    catch (e) {
        console.error('GET /api/ciudadanos/duplicados error:', e?.message || e);
        res.status(500).json({ error: 'Error' });
    }
});
// Verificar duplicados por teléfono (para alerta en captura)
app.get('/api/ciudadanos/verificar-duplicado', authenticateToken, async (req, res) => {
    try {
        const telefono = String(req.query.telefono || '').trim();
        const ignorarId = req.query.ignorar_id;
        if (!telefono) {
            res.json({ duplicado: false });
            return;
        }
        const params = [telefono];
        let cond = `(telefono = $1 OR telefono = '+52' || $1 OR replace(telefono,' ','') = replace($1,' ','')) AND telefono != ''`;
        if (ignorarId) {
            params.push(ignorarId);
            cond += ` AND id != $${params.length}`;
        }
        const rows = await pool.query(`SELECT id, nombre, seccion_id FROM ciudadanos WHERE ${cond} LIMIT 5`, params);
        res.json({ duplicado: rows.rows.length > 0, coincidencias: rows.rows });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/ciudadanos/:id', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT c.*, ST_X(c.ubicacion::geometry) as lng, ST_Y(c.ubicacion::geometry) as lat,
        c.intencion_voto_presidente, pp.nombre as partido_presidente_nombre, pp.color as partido_presidente_color, pp.abreviatura as partido_presidente_abreviatura,
        c.intencion_voto_diputado, pd.nombre as partido_diputado_nombre, pd.color as partido_diputado_color, pd.abreviatura as partido_diputado_abreviatura,
        ce.campana_id as encuesta_campana_id
       FROM ciudadanos c
       LEFT JOIN partidos_politicos pp ON pp.id = c.intencion_voto_presidente
       LEFT JOIN partidos_politicos pd ON pd.id = c.intencion_voto_diputado
       LEFT JOIN ciudadanos_encuestas ce ON ce.ciudadano_id = c.id
       WHERE c.id=$1`, [req.params.id]);
        if (!result.rows.length) {
            res.status(404).json({ error: 'No encontrado' });
            return;
        }
        const r = result.rows[0];
        let votantesCasaList = [];
        try {
            const vc = await pool.query('SELECT ciudadano_id, nombre, partido_id, partido_diputado_id, pendiente FROM votantes_casa WHERE ciudadano_id=$1 ORDER BY id', [req.params.id]);
            votantesCasaList = vc.rows;
        }
        catch (e) {
            console.warn('votantes_casa GET by id:', e);
        }
        res.json({ ...r, ubicacion: r.lat ? { lat: r.lat, lng: r.lng } : null,
            partido_presidente: r.partido_presidente_nombre ? { id: r.intencion_voto_presidente, nombre: r.partido_presidente_nombre, color: r.partido_presidente_color, abreviatura: r.partido_presidente_abreviatura } : null,
            partido_diputado: r.partido_diputado_nombre ? { id: r.intencion_voto_diputado, nombre: r.partido_diputado_nombre, color: r.partido_diputado_color, abreviatura: r.partido_diputado_abreviatura } : null,
            votantes_casa_list: votantesCasaList
        });
    }
    catch {
        res.status(500).json({ error: 'Error' });
    }
});
// ── Ciudadanos comprometidos (voto seguro) — tabla separada de ciudadanos, solo coord/admin ──
function esAdminOCoordinador(user) {
    return user && (user.rol === 'admin' || user.rol === 'coordinador');
}
function validarCurp(curp) {
    return /^[A-Z][AEIOUX][A-Z]{2}\d{6}[HM][A-Z]{5}[0-9A-Z]\d$/.test(curp);
}
function normalizarCurp(curp) {
    if (!curp || !String(curp).trim())
        return null;
    const c = String(curp).trim().toUpperCase();
    return c;
}
// Una casilla solo se asigna automáticamente si el ciudadano tiene ubicación y dirección,
// para poder posicionarlo en el mapa y decidir qué casilla le corresponde por cercanía/sección.
function tieneDireccionValida(c) {
    const calle = String(c?.calle || '').trim();
    const numero = String(c?.numero || '').trim();
    const colonia = String(c?.colonia || '').trim();
    return !!calle && (!!numero || !!colonia);
}
// Asigna la casilla más cercana dentro de la sección según lat/lng.
// Requiere coordenadas válidas Y casillas posicionadas (lat/lng); sin posición no se puede
// decidir por cercanía, por lo que se devuelve null (no se asigna casilla a ciegas).
async function asignarCasillaAutomatica(seccionId, lat, lng, casillaId) {
    if (casillaId)
        return parseInt(casillaId);
    const lats = parseFloat(lat), lngs = parseFloat(lng);
    if (Number.isNaN(lats) || Number.isNaN(lngs))
        return null;
    const casillas = await pool.query('SELECT id, lat, lng FROM casillas WHERE seccion_id=$1 ORDER BY id', [seccionId]);
    if (!casillas.rows.length)
        return null;
    const posicionadas = casillas.rows.filter(c => c.lat != null && c.lng != null);
    if (!posicionadas.length)
        return null;
    if (posicionadas.length === 1)
        return posicionadas[0].id;
    let mejor = null;
    let mejorDist = Infinity;
    for (const c of posicionadas) {
        const d = Math.hypot(c.lat - lats, c.lng - lngs);
        if (d < mejorDist) {
            mejorDist = d;
            mejor = c.id;
        }
    }
    return mejor;
}
// Valida coherencia semántica: inicial del nombre (pos 4) y fecha de nacimiento (pos 5-10)
// Regla SEGOB: si el primer nombre es María/José y hay segundo nombre, se usa la inicial del segundo.
function validarCurpSemantica(curp, nombre, fechaNacimiento) {
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
            // Se usa la inicial del segundo nombre (o el nombre único aplica criterios internos SEGOB)
            const inicialEsperada = palabras[1][0];
            if (curpInicial === inicialEsperada)
                return null;
            // Tolerancia: si el orden capturado es apellidos primero, acepta si coincide con cualquier palabra
            if (palabras.some(p => p[0] === curpInicial && p !== 'MARIA' && p !== 'JOSE'))
                return null;
            return 'CURP no coincide con el nombre: con María/José como primer nombre se usa la inicial del segundo nombre';
        }
        if (curpInicial !== primera[0] && !palabras.some(p => p[0] === curpInicial)) {
            return 'CURP no coincide con el nombre capturado';
        }
    }
    if (fechaNacimiento) {
        const d = new Date(String(fechaNacimiento).slice(0, 10));
        if (!Number.isNaN(d.getTime())) {
            const aa = String(d.getFullYear()).slice(-2);
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            const curpFecha = curp.slice(4, 10);
            if (curpFecha !== aa + mm + dd)
                return 'CURP no coincide con la fecha de nacimiento (la CURP indica ' + curpFecha + ', la fecha capturada es ' + aa + mm + dd + ')';
        }
    }
    return null;
}
app.get('/api/comprometidos', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (!esAdminOCoordinador(user) && user.rol !== 'capturista' && user.rol !== 'seccional') {
            res.status(403).json({ error: 'Solo coordinadores, administradores, seccionales y capturistas' });
            return;
        }
        const seccionId = req.query.seccion_id;
        let query = `SELECT c.id, c.seccion_id, c.numero_hogar, c.nombre, c.apellido_paterno, c.apellido_materno, c.telefono, c.calle, c.numero, c.colonia, c.cp, c.edad, c.fecha_nacimiento, c.notas,
                  ST_X(c.ubicacion::geometry) as lng, ST_Y(c.ubicacion::geometry) as lat,
                  c.timestamp_registro, c.sexo,
                  c.discapacidad_id, cd.nombre as discapacidad_nombre,
                  c.ocupacion_id, co2.nombre as ocupacion_nombre,
                  c.intencion_voto_presidente, pp.nombre as partido_presidente_nombre, pp.color as partido_presidente_color, pp.abreviatura as partido_presidente_abreviatura,
                  c.intencion_voto_diputado, pd.nombre as partido_diputado_nombre, pd.color as partido_diputado_color, pd.abreviatura as partido_diputado_abreviatura,
                  c.correo, c.curp, c.ine, c.vigencia_ine,
                  c.casilla_id, cs.nombre as casilla_nombre,
                  c.correccion_solicitada_at, ucb_corr.nombre as correccion_solicitada_por,
                  c.created_at, c.updated_at, ucb.nombre as creado_por, uub.nombre as editado_por,
                  (v.comprometido_id IS NOT NULL) as ya_voto,
                  s.id as seccion_num, m.nombre as municipio, e.nombre as estado
                FROM ciudadanos_comprometidos c
                JOIN secciones_electorales s ON s.id = c.seccion_id
                JOIN municipios m ON m.id = s.municipio_id
                JOIN estados e ON e.id = m.estado_id
                LEFT JOIN partidos_politicos pp ON pp.id = c.intencion_voto_presidente
                LEFT JOIN partidos_politicos pd ON pd.id = c.intencion_voto_diputado
                LEFT JOIN casillas cs ON cs.id = c.casilla_id
                LEFT JOIN usuarios ucb ON ucb.id = c.created_by
                LEFT JOIN usuarios uub ON uub.id = c.updated_by
                LEFT JOIN usuarios ucb_corr ON ucb_corr.id = c.correccion_solicitada_by
                LEFT JOIN votos v ON v.comprometido_id = c.id
                LEFT JOIN cat_discapacidades cd ON cd.id = c.discapacidad_id
                LEFT JOIN cat_ocupaciones co2 ON co2.id = c.ocupacion_id`;
        const params = [];
        const conds = [];
        if (user.rol === 'capturista') {
            params.push(user.userId);
            conds.push(`c.created_by = $${params.length}`);
        }
        else if (user.rol === 'seccional') {
            params.push(user.userId);
            conds.push(`c.created_by IN (SELECT capturista_id FROM seccional_capturistas WHERE seccional_id = $${params.length})`);
        }
        if (seccionId) {
            params.push(seccionId);
            conds.push(`c.seccion_id = $${params.length}`);
        }
        if (conds.length)
            query += ' WHERE ' + conds.join(' AND ');
        query += ' ORDER BY c.timestamp_registro DESC';
        const result = await pool.query(query, params);
        res.json(result.rows.map((r) => ({
            ...r, ubicacion: r.lat ? { lat: r.lat, lng: r.lng } : null,
            partido_presidente: r.partido_presidente_nombre ? { id: r.intencion_voto_presidente, nombre: r.partido_presidente_nombre, color: r.partido_presidente_color, abreviatura: r.partido_presidente_abreviatura } : null,
            partido_diputado: r.partido_diputado_nombre ? { id: r.intencion_voto_diputado, nombre: r.partido_diputado_nombre, color: r.partido_diputado_color, abreviatura: r.partido_diputado_abreviatura } : null
        })));
    }
    catch (e) {
        console.error('GET /api/comprometidos error:', e?.message || e);
        res.status(500).json({ error: 'Error al listar comprometidos' });
    }
});
app.post('/api/comprometidos/importar', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (!esAdminOCoordinador(user)) {
            res.status(403).json({ error: 'Solo coordinadores y administradores' });
            return;
        }
        const { base64 } = req.body;
        if (!base64) {
            res.status(400).json({ error: 'Falta el archivo' });
            return;
        }
        const texto = Buffer.from(String(base64), 'base64').toString('utf8');
        const lineas = texto.split(/\r?\n/).filter(l => l.trim());
        if (lineas.length < 2) {
            res.status(400).json({ error: 'Archivo vacío' });
            return;
        }
        const encabezado = lineas[0].split(',').map(h => h.trim().toLowerCase().replace(/^\ufeff/, ''));
        const partidos = (await pool.query('SELECT id, abreviatura FROM partidos_politicos')).rows;
        const partidoPorAbrev = new Map(partidos.map(p => [String(p.abreviatura || '').toLowerCase().trim(), p.id]));
        let creados = 0, omitidos = 0;
        const errores = [];
        for (let i = 1; i < lineas.length; i++) {
            const celdas = lineas[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
            if (!celdas[0])
                continue;
            const fila = {};
            encabezado.forEach((h, idx) => fila[h] = celdas[idx] || '');
            const nombre = fila['nombre'];
            const seccionNum = fila['seccion'];
            if (!nombre || !seccionNum) {
                errores.push(`Fila ${i + 1}: falta nombre o seccion`);
                continue;
            }
            const secRes = await pool.query('SELECT id FROM secciones_electorales WHERE id=$1', [seccionNum]);
            if (!secRes.rows.length) {
                errores.push(`Fila ${i + 1}: seccion ${seccionNum} no existe`);
                continue;
            }
            const seccion_id = secRes.rows[0].id;
            const abrev = String(fila['partido'] || '').toLowerCase().trim();
            const partidoId = abrev ? partidoPorAbrev.get(abrev) || null : null;
            const curpImp = normalizarCurp(fila['curp']);
            if (curpImp && !validarCurp(curpImp)) {
                errores.push(`Fila ${i + 1}: CURP inválida (${curpImp})`);
                continue;
            }
            let fechaNacImp = null;
            const fechaRaw = String(fila['fecha_nacimiento'] || '').trim();
            if (fechaRaw) {
                const m = fechaRaw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
                const dmy = fechaRaw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
                if (m)
                    fechaNacImp = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
                else if (dmy)
                    fechaNacImp = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
                else {
                    errores.push(`Fila ${i + 1}: fecha de nacimiento inválida (${fechaRaw})`);
                    continue;
                }
                if (Number.isNaN(new Date(fechaNacImp).getTime())) {
                    errores.push(`Fila ${i + 1}: fecha de nacimiento inválida (${fechaRaw})`);
                    continue;
                }
            }
            if (curpImp) {
                const errSem = validarCurpSemantica(curpImp, nombre, fechaNacImp);
                if (errSem) {
                    errores.push(`Fila ${i + 1}: ${errSem}`);
                    continue;
                }
                const dupCurp = await pool.query('SELECT id FROM ciudadanos_comprometidos WHERE UPPER(curp)=$1', [curpImp]);
                if (dupCurp.rows.length) {
                    errores.push(`Fila ${i + 1}: CURP duplicada (${curpImp})`);
                    continue;
                }
            }
            const key = 'imp-' + crypto_1.default.createHash('md5').update([seccion_id, nombre, fila['telefono'] || ''].join('|')).digest('hex');
            const dup = await pool.query('SELECT id FROM ciudadanos_comprometidos WHERE idempotency_key=$1', [key]);
            if (dup.rows.length) {
                omitidos++;
                continue;
            }
            const id = crypto_1.default.randomUUID();
            const casillaAuto = await asignarCasillaAutomatica(seccion_id, null, null);
            await pool.query(`INSERT INTO ciudadanos_comprometidos (id, seccion_id, nombre, telefono, edad, fecha_nacimiento, calle, numero, colonia, cp, correo, curp, ine, intencion_voto_presidente, casilla_id, capturado_por, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [id, seccion_id, nombre, fila['telefono'] || null, fila['edad'] ? parseInt(fila['edad']) || null : null, fechaNacImp,
                fila['calle'] || null, fila['numero'] || null, fila['colonia'] || null, fila['cp'] || null,
                fila['correo'] || null, curpImp, fila['ine'] || null, partidoId, casillaAuto, user.userId, key]);
            creados++;
            try {
                if (user?.nombre)
                    await logAuditoria(user.userId, user.nombre, 'importar_comprometidos', 'ciudadanos_comprometidos', id, { nombre, seccion_id });
            }
            catch { }
        }
        res.json({ creados, omitidos, errores: errores.slice(0, 10) });
        try {
            io.emit('nuevo-comprometido', {});
        }
        catch (e) {
            console.warn('io.emit error:', e);
        }
    }
    catch (e) {
        console.error('POST /api/comprometidos/importar error:', e?.message || e);
        res.status(500).json({ error: 'Error al importar' });
    }
});
app.get('/api/comprometidos/:id', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (!esAdminOCoordinador(user) && user.rol !== 'capturista' && user.rol !== 'seccional') {
            res.status(403).json({ error: 'Solo coordinadores y administradores' });
            return;
        }
        if (user.rol === 'capturista') {
            const owned = await pool.query('SELECT id FROM ciudadanos_comprometidos WHERE id=$1 AND created_by=$2', [req.params.id, user.userId]);
            if (!owned.rows.length) {
                res.status(403).json({ error: 'No puedes ver esta captura' });
                return;
            }
        }
        if (user.rol === 'seccional') {
            const owned = await pool.query('SELECT c.id FROM ciudadanos_comprometidos c JOIN seccional_capturistas sc ON sc.capturista_id=c.created_by WHERE sc.seccional_id=$1 AND c.id=$2', [user.userId, req.params.id]);
            if (!owned.rows.length) {
                res.status(403).json({ error: 'No puedes ver esta captura' });
                return;
            }
        }
        const result = await pool.query(`SELECT c.*, ST_X(c.ubicacion::geometry) as lng, ST_Y(c.ubicacion::geometry) as lat,
        c.intencion_voto_presidente, pp.nombre as partido_presidente_nombre, pp.color as partido_presidente_color, pp.abreviatura as partido_presidente_abreviatura,
        c.intencion_voto_diputado, pd.nombre as partido_diputado_nombre, pd.color as partido_diputado_color, pd.abreviatura as partido_diputado_abreviatura
       FROM ciudadanos_comprometidos c
       LEFT JOIN partidos_politicos pp ON pp.id = c.intencion_voto_presidente
       LEFT JOIN partidos_politicos pd ON pd.id = c.intencion_voto_diputado
       WHERE c.id=$1`, [req.params.id]);
        if (!result.rows.length) {
            res.status(404).json({ error: 'No encontrado' });
            return;
        }
        const r = result.rows[0];
        res.json({ ...r, ubicacion: r.lat ? { lat: r.lat, lng: r.lng } : null,
            partido_presidente: r.partido_presidente_nombre ? { id: r.intencion_voto_presidente, nombre: r.partido_presidente_nombre, color: r.partido_presidente_color, abreviatura: r.partido_presidente_abreviatura } : null,
            partido_diputado: r.partido_diputado_nombre ? { id: r.intencion_voto_diputado, nombre: r.partido_diputado_nombre, color: r.partido_diputado_color, abreviatura: r.partido_diputado_abreviatura } : null
        });
    }
    catch {
        res.status(500).json({ error: 'Error' });
    }
});
app.post('/api/comprometidos', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (!esAdminOCoordinador(user) && user.rol !== 'capturista') {
            res.status(403).json({ error: 'Solo coordinadores, administradores y capturistas' });
            return;
        }
        const { seccion_id, numero_hogar, nombre, apellido_paterno, apellido_materno, telefono, calle, numero, colonia, cp, lat, lng, intencion_voto_presidente, notas, edad, fecha_nacimiento, correo, curp, ine, vigencia_ine, idempotency_key, casilla_id } = req.body;
        if (!seccion_id || !nombre) {
            res.status(400).json({ error: 'seccion_id y nombre requeridos' });
            return;
        }
        const nombreFinal = (nombre && (apellido_paterno || apellido_materno)) ? [nombre, apellido_paterno, apellido_materno].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() : nombre;
        // Captura obligatoria: todos los campos salvo el correo
        if (user.rol === 'capturista') {
            if (!telefono || !curp || !ine || !vigencia_ine || !calle || !numero || !colonia || !cp || !fecha_nacimiento) {
                res.status(400).json({ error: 'Todos los campos son obligatorios salvo el correo' });
                return;
            }
        }
        const casillaAuto = casilla_id ? parseInt(casilla_id) : (lat != null && lng != null && !Number.isNaN(+lat) && !Number.isNaN(+lng) && tieneDireccionValida(req.body) ? await asignarCasillaAutomatica(seccion_id, lat, lng) : null);
        const curpVal = normalizarCurp(curp);
        if (curpVal && !validarCurp(curpVal)) {
            res.status(400).json({ error: 'CURP inválida: debe tener 18 caracteres con el formato oficial (ej. GODE561231HDFRRN09)' });
            return;
        }
        let fechaNacVal = null;
        if (fecha_nacimiento) {
            fechaNacVal = String(fecha_nacimiento).slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaNacVal) || Number.isNaN(new Date(fechaNacVal).getTime())) {
                res.status(400).json({ error: 'Fecha de nacimiento inválida' });
                return;
            }
        }
        let vigenciaIneVal = null;
        if (vigencia_ine) {
            vigenciaIneVal = String(vigencia_ine).slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(vigenciaIneVal) || Number.isNaN(new Date(vigenciaIneVal).getTime())) {
                res.status(400).json({ error: 'Vigencia de INE inválida' });
                return;
            }
        }
        if (curpVal) {
            const errSem = validarCurpSemantica(curpVal, nombreFinal, fechaNacVal);
            if (errSem) {
                res.status(400).json({ error: errSem });
                return;
            }
            const dup = await pool.query('SELECT id FROM ciudadanos_comprometidos WHERE UPPER(curp)=$1', [curpVal]);
            if (dup.rows.length) {
                res.status(400).json({ error: 'La CURP ya está registrada en ciudadanos seguros' });
                return;
            }
        }
        if (idempotency_key) {
            const existing = await pool.query('SELECT id FROM ciudadanos_comprometidos WHERE idempotency_key=$1', [idempotency_key]);
            if (existing.rows.length) {
                res.status(200).json({ id: existing.rows[0].id, message: 'Ya existe (idempotente)' });
                return;
            }
        }
        const id = crypto_1.default.randomUUID();
        const tieneUbicacionComp = lat != null && lng != null && !Number.isNaN(+lat) && !Number.isNaN(+lng);
        const ubiSqlComp = 'ST_SetSRID(ST_MakePoint($12,$13),4326)';
        await pool.query(`INSERT INTO ciudadanos_comprometidos (id, seccion_id, numero_hogar, nombre, apellido_paterno, apellido_materno, telefono, calle, numero, colonia, cp, ubicacion, intencion_voto_presidente, intencion_voto_diputado, notas, edad, fecha_nacimiento, correo, curp, ine, vigencia_ine, capturado_por, idempotency_key, casilla_id, created_by, sexo, discapacidad_id, ocupacion_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${ubiSqlComp},$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`, [id, seccion_id, numero_hogar || null, nombreFinal, apellido_paterno || null, apellido_materno || null, telefono || null, calle || null, numero || null, colonia || null, cp || null, tieneUbicacionComp ? +lng : null, tieneUbicacionComp ? +lat : null, intencion_voto_presidente || null, null, notas || null, edad ? parseInt(edad) : null, fechaNacVal, correo || null, curpVal, ine || null, vigenciaIneVal, user.userId, idempotency_key || null, casillaAuto, user.userId,
            ['H', 'M'].includes(req.body.sexo) ? req.body.sexo : null,
            req.body.discapacidad_id ? parseInt(req.body.discapacidad_id) : null,
            req.body.ocupacion_id ? parseInt(req.body.ocupacion_id) : null]);
        res.status(201).json({ id, message: 'Ciudadano comprometido creado' });
        try {
            io.emit('nuevo-comprometido', { id, seccion_id });
        }
        catch (e) {
            console.warn('io.emit error:', e);
        }
        try {
            const u = req.user;
            if (u?.nombre)
                await logAuditoria(u.userId, u.nombre, 'alta_comprometido', 'ciudadanos_comprometidos', id, { nombre, seccion_id, telefono });
        }
        catch (e) {
            console.warn('post-alta comprometido:', e);
        }
    }
    catch (error) {
        console.error('POST /api/comprometidos error:', error?.message || error);
        res.status(500).json({ error: 'Error al crear comprometido' });
    }
});
app.put('/api/comprometidos/:id', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (!esAdminOCoordinador(user)) {
            if (user.rol === 'capturista') {
                const owned = await pool.query('SELECT created_by, correccion_solicitada_at FROM ciudadanos_comprometidos WHERE id=$1', [req.params.id]);
                if (!owned.rows.length || owned.rows[0].created_by !== user.userId || !owned.rows[0].correccion_solicitada_at) {
                    res.status(403).json({ error: 'Solo puedes editar capturas propias con corrección solicitada por tu seccional' });
                    return;
                }
            }
            else {
                res.status(403).json({ error: 'Solo coordinadores y administradores' });
                return;
            }
        }
        const { nombre, apellido_paterno, apellido_materno, telefono, seccion_id, calle, numero, colonia, cp, lat, lng, numero_hogar, intencion_voto_presidente, notas, edad, fecha_nacimiento, curp, vigencia_ine, casilla_id } = req.body;
        const curpVal = normalizarCurp(curp);
        if (curpVal && !validarCurp(curpVal)) {
            res.status(400).json({ error: 'CURP inválida: debe tener 18 caracteres con el formato oficial (ej. GODE561231HDFRRN09)' });
            return;
        }
        const nombreFinal = (nombre && (apellido_paterno || apellido_materno)) ? [nombre, apellido_paterno, apellido_materno].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() : nombre;
        let fechaNacVal = null;
        if (fecha_nacimiento) {
            fechaNacVal = String(fecha_nacimiento).slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaNacVal) || Number.isNaN(new Date(fechaNacVal).getTime())) {
                res.status(400).json({ error: 'Fecha de nacimiento inválida' });
                return;
            }
        }
        let vigenciaIneVal = null;
        if (vigencia_ine) {
            vigenciaIneVal = String(vigencia_ine).slice(0, 10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(vigenciaIneVal) || Number.isNaN(new Date(vigenciaIneVal).getTime())) {
                res.status(400).json({ error: 'Vigencia de INE inválida' });
                return;
            }
        }
        if (curpVal) {
            const errSem = validarCurpSemantica(curpVal, nombreFinal, fechaNacVal);
            if (errSem) {
                res.status(400).json({ error: errSem });
                return;
            }
            const dup = await pool.query('SELECT id FROM ciudadanos_comprometidos WHERE UPPER(curp)=$1 AND id<>$2', [curpVal, req.params.id]);
            if (dup.rows.length) {
                res.status(400).json({ error: 'La CURP ya está registrada en ciudadanos seguros' });
                return;
            }
        }
        const parts = [];
        const params = [];
        const p = (v) => { params.push(v); return '$' + params.length; };
        const cols = ['nombre', 'apellido_paterno', 'apellido_materno', 'telefono', 'seccion_id', 'calle', 'numero', 'colonia', 'cp'];
        const vals = [nombreFinal, apellido_paterno || null, apellido_materno || null, telefono || null, seccion_id || null, calle || null, numero || null, colonia || null, cp || null];
        parts.push(cols.map((c, i) => c + '=COALESCE(' + p(vals[i]) + ',' + c + ')').join(','));
        const colsLimpiables = ['correo', 'curp', 'ine'].filter(c => req.body[c] !== undefined);
        const valsLimpiables = colsLimpiables.map(c => c === 'curp' ? curpVal : (req.body[c] || null));
        if (colsLimpiables.length)
            parts.push(colsLimpiables.map((c, i) => c + '=' + p(valsLimpiables[i])).join(','));
        if (lat != null && lng != null && !Number.isNaN(+lat) && !Number.isNaN(+lng)) {
            parts.push('ubicacion=ST_SetSRID(ST_MakePoint(' + p(+lng) + ',' + p(+lat) + '),4326)');
        }
        if (casilla_id != null)
            parts.push('casilla_id=' + p(parseInt(casilla_id)));
        else if (lat != null && lng != null && !Number.isNaN(+lat) && !Number.isNaN(+lng) && tieneDireccionValida(req.body))
            parts.push('casilla_id=' + p(await asignarCasillaAutomatica(seccion_id, lat, lng)));
        else if (casilla_id === null)
            parts.push('casilla_id=NULL');
        const cols2 = ['numero_hogar', 'intencion_voto_presidente', 'notas', 'edad', 'fecha_nacimiento', 'vigencia_ine'];
        const vals2 = [numero_hogar || null, intencion_voto_presidente || null, notas || null, edad || null, fechaNacVal, vigenciaIneVal];
        parts.push(cols2.map((c, i) => c + '=COALESCE(' + p(vals2[i]) + ',' + c + ')').join(','));
        if (['H', 'M'].includes(req.body.sexo))
            parts.push('sexo=' + p(req.body.sexo));
        if (req.body.discapacidad_id !== undefined)
            parts.push('discapacidad_id=' + p(req.body.discapacidad_id ? parseInt(req.body.discapacidad_id) : null));
        if (req.body.ocupacion_id !== undefined)
            parts.push('ocupacion_id=' + p(req.body.ocupacion_id ? parseInt(req.body.ocupacion_id) : null));
        parts.push('updated_at=now()');
        parts.push('updated_by=' + p(user.userId || null));
        params.push(req.params.id);
        await pool.query('UPDATE ciudadanos_comprometidos SET ' + parts.join(',') + ' WHERE id=$' + params.length, params);
        res.json({ message: 'Ciudadano comprometido actualizado' });
        try {
            io.emit('actualizar-comprometido', { id: req.params.id });
        }
        catch (e) {
            console.warn('io.emit error:', e);
        }
        try {
            const u = req.user;
            if (u?.nombre)
                await logAuditoria(u.userId, u.nombre, 'editar_comprometido', 'ciudadanos_comprometidos', req.params.id, { nombre });
        }
        catch (e) {
            console.warn('post-edicion comprometido:', e);
        }
    }
    catch (e) {
        console.error('PUT /api/comprometidos error:', e?.message || e);
        res.status(500).json({ error: 'Error al actualizar' });
    }
});
app.delete('/api/comprometidos/:id', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (!esAdminOCoordinador(user)) {
            res.status(403).json({ error: 'Solo coordinadores y administradores' });
            return;
        }
        const rows = await pool.query('SELECT notas FROM ciudadanos_comprometidos WHERE id=$1', [req.params.id]);
        if (rows.rows.length) {
            const notas = rows.rows[0].notas || '';
            if (notas.startsWith('📷 ')) {
                const url = notas.replace('📷 ', '');
                const idx = url.lastIndexOf('/');
                if (idx >= 0) {
                    const fname = url.substring(idx + 1);
                    const fpath = path_1.default.join(__dirname, '../../uploads/evidencias', fname);
                    try {
                        fs_1.default.unlinkSync(fpath);
                    }
                    catch (e) { /* file may not exist */ }
                }
            }
        }
        await pool.query('DELETE FROM ciudadanos_comprometidos WHERE id=$1', [req.params.id]);
        res.json({ message: 'Ciudadano comprometido eliminado' });
        try {
            io.emit('eliminar-comprometido', { id: req.params.id });
        }
        catch (e) {
            console.warn('io.emit error:', e);
        }
    }
    catch {
        res.status(500).json({ error: 'Error al eliminar' });
    }
});
app.delete('/api/comprometidos/:id/foto', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (!esAdminOCoordinador(user)) {
            res.status(403).json({ error: 'Solo coordinadores y administradores' });
            return;
        }
        const rows = await pool.query('SELECT notas FROM ciudadanos_comprometidos WHERE id=$1', [req.params.id]);
        if (rows.rows.length) {
            const notas = rows.rows[0].notas || '';
            if (notas.startsWith('📷 ')) {
                const url = notas.replace('📷 ', '');
                const idx = url.lastIndexOf('/');
                if (idx >= 0) {
                    const fname = url.substring(idx + 1);
                    const fpath = path_1.default.join(__dirname, '../../uploads/evidencias', fname);
                    try {
                        fs_1.default.unlinkSync(fpath);
                    }
                    catch (e) { /* file may not exist */ }
                }
            }
            await pool.query('UPDATE ciudadanos_comprometidos SET notas=NULL WHERE id=$1', [req.params.id]);
        }
        res.json({ message: 'Foto eliminada' });
    }
    catch {
        res.status(500).json({ error: 'Error al eliminar foto' });
    }
});
app.get('/api/representante/casillas', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (user.rol !== 'representante') {
            res.status(403).json({ error: 'Solo representantes' });
            return;
        }
        const rows = await pool.query(`
      SELECT rc.casilla_id, c.nombre as casilla, c.direccion, c.seccion_id, c.meta_votos,
             m.nombre as municipio
      FROM representantes_casillas rc
      JOIN casillas c ON c.id = rc.casilla_id
      LEFT JOIN secciones_electorales s ON s.id = c.seccion_id
      LEFT JOIN municipios m ON m.id = s.municipio_id
      WHERE rc.representante_id = $1
      ORDER BY c.seccion_id, c.nombre`, [user.userId]);
        res.json(rows.rows);
    }
    catch {
        res.status(500).json({ error: 'Error' });
    }
});
app.get('/api/seccional/capturistas', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (!esAdminOCoordinador(user) && user.rol !== 'seccional') {
            res.status(403).json({ error: 'No autorizado' });
            return;
        }
        const rows = await pool.query(`
      SELECT u.id as capturista_id, u.nombre, u.email, u.telefono, sc.seccional_id,
             m.meta, m.updated_at as meta_actualizada
      FROM usuarios u
      LEFT JOIN seccional_capturistas sc ON sc.capturista_id = u.id
      LEFT JOIN metas_captura m ON m.capturista_id = u.id
      WHERE u.rol = 'capturista'
      ORDER BY u.nombre`);
        if (user.rol === 'seccional') {
            res.json(rows.rows
                .filter((r) => r.seccional_id === user.userId)
                .map(({ seccional_id, ...r }) => r));
            return;
        }
        res.json(rows.rows.map(({ seccional_id, ...r }) => r));
    }
    catch {
        res.status(500).json({ error: 'Error al obtener capturistas' });
    }
});
app.put('/api/seccional/capturistas', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (!esAdminOCoordinador(user) && user.rol !== 'seccional') {
            res.status(403).json({ error: 'No autorizado' });
            return;
        }
        const { capturista_ids } = req.body;
        if (!Array.isArray(capturista_ids)) {
            res.status(400).json({ error: 'capturista_ids requerido' });
            return;
        }
        if (capturista_ids.length) {
            const otros = (await pool.query('SELECT sc.capturista_id FROM seccional_capturistas sc WHERE sc.capturista_id = ANY($1) AND sc.seccional_id != $2', [capturista_ids, user.userId])).rows.map((r) => r.capturista_id);
            if (otros.length) {
                res.status(409).json({ error: 'Uno o más capturistas ya pertenecen a otro seccional' });
                return;
            }
        }
        await pool.query('DELETE FROM seccional_capturistas WHERE seccional_id=$1', [user.userId]);
        if (capturista_ids.length) {
            const vals = capturista_ids.map((_, i) => `($1,$${i + 2})`).join(',');
            await pool.query(`INSERT INTO seccional_capturistas (seccional_id, capturista_id) VALUES ${vals} ON CONFLICT DO NOTHING`, [user.userId, ...capturista_ids]);
        }
        res.json({ message: 'Capturistas asignados' });
    }
    catch {
        res.status(500).json({ error: 'Error al asignar capturistas' });
    }
});
app.get('/api/metas', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (!esAdminOCoordinador(user) && user.rol !== 'seccional') {
            res.status(403).json({ error: 'No autorizado' });
            return;
        }
        const params = [];
        let where = '';
        if (user.rol === 'seccional') {
            params.push(user.userId);
            where = 'WHERE m.capturista_id IN (SELECT capturista_id FROM seccional_capturistas WHERE seccional_id=$' + params.length + ')';
        }
        const rows = await pool.query(`
      SELECT m.capturista_id, u.nombre as capturista_nombre, m.meta, m.updated_by, m.updated_at
      FROM metas_captura m
      JOIN usuarios u ON u.id = m.capturista_id
      ${where}`, params);
        res.json(rows.rows);
    }
    catch {
        res.status(500).json({ error: 'Error al obtener metas' });
    }
});
app.put('/api/metas/:capturistaId', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (!esAdminOCoordinador(user) && user.rol !== 'seccional') {
            res.status(403).json({ error: 'No autorizado' });
            return;
        }
        const meta = parseInt(req.body.meta);
        if (Number.isNaN(meta) || meta < 0) {
            res.status(400).json({ error: 'Meta inválida' });
            return;
        }
        if (user.rol === 'seccional') {
            const asig = await pool.query('SELECT 1 FROM seccional_capturistas WHERE seccional_id=$1 AND capturista_id=$2', [user.userId, req.params.capturistaId]);
            if (!asig.rows.length) {
                res.status(403).json({ error: 'Ese capturista no está asignado a ti' });
                return;
            }
        }
        await pool.query('INSERT INTO metas_captura (capturista_id, meta, created_by, updated_by) VALUES ($1,$2,$3,$3) ON CONFLICT (capturista_id) DO UPDATE SET meta=$2, updated_by=$3, updated_at=now()', [req.params.capturistaId, meta, user.userId]);
        res.json({ message: 'Meta guardada' });
    }
    catch {
        res.status(500).json({ error: 'Error al guardar meta' });
    }
});
app.post('/api/comprometidos/:id/solicitar-correccion', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (!esAdminOCoordinador(user) && user.rol !== 'seccional') {
            res.status(403).json({ error: 'No autorizado' });
            return;
        }
        const scope = user.rol === 'seccional'
            ? ' AND c.created_by IN (SELECT capturista_id FROM seccional_capturistas WHERE seccional_id=$' + 2 + ')'
            : '';
        const owner = await pool.query('SELECT id, created_by, nombre FROM ciudadanos_comprometidos c WHERE c.id=$1' + scope, [req.params.id, ...(user.rol === 'seccional' ? [user.userId] : [])]);
        if (!owner.rows.length) {
            res.status(404).json({ error: 'Captura no encontrada en tu alcance' });
            return;
        }
        await pool.query('UPDATE ciudadanos_comprometidos SET correccion_solicitada_at=now(), correccion_solicitada_by=$1 WHERE id=$2', [user.userId, req.params.id]);
        const c = owner.rows[0];
        try {
            await notificacionService.enviarPushAUsuarios([c.created_by], 'Corrección solicitada', `Se solicita corregir el registro de ${c.nombre || 'ciudadano'}`);
        }
        catch (e) {
            console.warn('push correccion:', e);
        }
        try {
            const sockets = await io.fetchSockets();
            sockets.forEach(s => { if (s.userId === c.created_by)
                s.emit('correccion-solicitada', { id: req.params.id }); });
        }
        catch (e) {
            console.warn('emit correccion:', e);
        }
        res.json({ message: 'Corrección solicitada al capturista' });
    }
    catch {
        res.status(500).json({ error: 'Error al solicitar corrección' });
    }
});
app.get('/api/reportes/capturas-por-capturista', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (!esAdminOCoordinador(user) && user.rol !== 'seccional') {
            res.status(403).json({ error: 'No autorizado' });
            return;
        }
        let where = '';
        const params = [];
        if (user.rol === 'seccional') {
            params.push(user.userId);
            where = 'WHERE c.created_by IN (SELECT capturista_id FROM seccional_capturistas WHERE seccional_id=$' + params.length + ')';
        }
        else {
            where = "WHERE u.rol = 'capturista' OR c.id IS NOT NULL";
        }
        const rows = await pool.query(`
      SELECT u.id as capturista_id, u.nombre as capturista_nombre, u.telefono, u.rol,
             count(c.id) FILTER (WHERE c.id IS NOT NULL) as total,
             count(c.id) FILTER (WHERE c.correccion_solicitada_at IS NOT NULL) as con_correccion,
             m.meta,
             min(c.created_at)::date as primera_captura, max(c.created_at)::date as ultima_captura
      FROM usuarios u
      LEFT JOIN ciudadanos_comprometidos c ON c.created_by = u.id
      LEFT JOIN metas_captura m ON m.capturista_id = u.id
      ${where}
      GROUP BY u.id, u.nombre, u.telefono, u.rol, m.meta
      ORDER BY u.nombre`, params);
        res.json(rows.rows);
    }
    catch {
        res.status(500).json({ error: 'Error al generar reporte' });
    }
});
app.post('/api/eventos', authenticateToken, async (req, res) => {
    try {
        const { nombre, descripcion, fecha_inicio, fecha_fin, lat, lng, radio_geocerca, seccion_id, plantilla_id, alertar_config, alertar_solo_simpatizantes } = req.body;
        const user = req.user;
        const alertCfg = alertar_config ? (typeof alertar_config === 'string' ? JSON.parse(alertar_config) : alertar_config) : [];
        const result = await pool.query(`INSERT INTO eventos (nombre, descripcion, fecha_inicio, fecha_fin, ubicacion, radio_geocerca, seccion_id, creado_por, plantilla_id, alertar_config, alertar_solo_simpatizantes)
       VALUES ($1,$2,$3,$4,ST_SetSRID(ST_MakePoint($5,$6),4326),$7,$8,$9,$10,$11,$12)
       RETURNING id, ST_X(ubicacion::geometry) as lng, ST_Y(ubicacion::geometry) as lat`, [nombre, descripcion || '', fecha_inicio, fecha_fin, lng, lat, radio_geocerca || 500, seccion_id, user.userId, plantilla_id || null, JSON.stringify(alertCfg), !!alertar_solo_simpatizantes]);
        res.status(201).json(result.rows[0]);
    }
    catch {
        res.status(500).json({ error: 'Error al crear evento' });
    }
});
app.get('/api/eventos', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        let query = `SELECT e.*, ST_X(e.ubicacion::geometry) as lng, ST_Y(e.ubicacion::geometry) as lat,
                  s.id as seccion_num, m.nombre as municipio,
                  p.nombre as plantilla_nombre, p.cuerpo as plantilla_cuerpo
                 FROM eventos e
                 LEFT JOIN secciones_electorales s ON s.id = e.seccion_id
                 LEFT JOIN municipios m ON m.id = s.municipio_id
                 LEFT JOIN plantillas_whatsapp p ON p.id = e.plantilla_id`;
        const params = [];
        if (user.rol === 'enlace') {
            const secs = await getUserSecciones(user.userId);
            if (secs.length) {
                params.push(secs);
                query += ` WHERE e.seccion_id = ANY($${params.length})`;
            }
        }
        query += ' ORDER BY e.fecha_inicio DESC';
        const result = await pool.query(query, params);
        res.json(result.rows);
    }
    catch {
        res.status(500).json({ error: 'Error' });
    }
});
app.delete('/api/eventos/:id', authenticateToken, async (req, res) => {
    try {
        await pool.query('DELETE FROM eventos WHERE id=$1', [req.params.id]);
        res.json({ message: 'Evento eliminado' });
    }
    catch {
        res.status(500).json({ error: 'Error al eliminar' });
    }
});
app.put('/api/eventos/:id', authenticateToken, async (req, res) => {
    try {
        const { nombre, descripcion, fecha_inicio, fecha_fin, lat, lng, radio_geocerca, seccion_id, plantilla_id, alertar_config, alertar_solo_simpatizantes } = req.body;
        const alertCfg = alertar_config ? (typeof alertar_config === 'string' ? JSON.parse(alertar_config) : alertar_config) : [];
        const evActual = (await pool.query('SELECT fecha_fin FROM eventos WHERE id=$1', [req.params.id])).rows[0];
        if (!evActual) {
            res.status(404).json({ error: 'Evento no encontrado' });
            return;
        }
        if (new Date(evActual.fecha_fin).getTime() < Date.now()) {
            res.status(400).json({ error: 'El evento ya culminó y no puede editarse' });
            return;
        }
        await pool.query(`UPDATE eventos SET nombre=$1, descripcion=$2, fecha_inicio=$3, fecha_fin=$4,
       ubicacion=ST_SetSRID(ST_MakePoint($5,$6),4326), radio_geocerca=$7, seccion_id=$8, plantilla_id=$9,
       alertar_config=$10, alertar_solo_simpatizantes=$11
       WHERE id=$12`, [nombre, descripcion || '', fecha_inicio, fecha_fin, lng, lat, radio_geocerca, seccion_id, plantilla_id || null, JSON.stringify(alertCfg), !!alertar_solo_simpatizantes, req.params.id]);
        res.json({ message: 'Evento actualizado' });
    }
    catch {
        res.status(500).json({ error: 'Error al actualizar' });
    }
});
app.get('/api/eventos/:id/ciudadanos', authenticateToken, async (req, res) => {
    try {
        const result = await eventService.ciudadanosEnRadio(req.params.id);
        res.json(result);
    }
    catch {
        res.status(500).json({ error: 'Error' });
    }
});
app.post('/api/eventos/:id/disparar-alertas', authenticateToken, async (req, res) => {
    try {
        const ev = (await pool.query(`SELECT id, nombre, fecha_inicio, fecha_fin, plantilla_id, alertar_config, alertar_enviados, seccion_id, alertar_solo_simpatizantes, ST_X(ubicacion::geometry) as lng, ST_Y(ubicacion::geometry) as lat, radio_geocerca FROM eventos WHERE id=$1`, [req.params.id])).rows[0];
        if (!ev) {
            res.status(404).json({ error: 'Evento no encontrado' });
            return;
        }
        if (new Date(ev.fecha_fin).getTime() < Date.now()) {
            res.status(400).json({ error: 'El evento ya culminó, no se pueden enviar recordatorios' });
            return;
        }
        if (!ev.plantilla_id) {
            res.status(400).json({ error: 'El evento no tiene plantilla WhatsApp asignada' });
            return;
        }
        const plantilla = (await pool.query('SELECT cuerpo, nombre FROM plantillas_whatsapp WHERE id=$1', [ev.plantilla_id])).rows[0];
        if (!plantilla) {
            res.status(400).json({ error: 'Plantilla no encontrada' });
            return;
        }
        let ciudadanos;
        if (ev.lat && ev.lng) {
            ciudadanos = (await pool.query(`SELECT id, nombre, telefono FROM ciudadanos WHERE telefono IS NOT NULL AND telefono != '' AND ST_DWithin(ubicacion, ST_SetSRID(ST_MakePoint($1,$2),4326), $3)`, [ev.lng, ev.lat, ev.radio_geocerca || 500])).rows;
        }
        else if (ev.seccion_id) {
            ciudadanos = (await pool.query(`SELECT id, nombre, telefono FROM ciudadanos WHERE seccion_id=$1 AND telefono IS NOT NULL AND telefono != ''`, [ev.seccion_id])).rows;
        }
        else {
            ciudadanos = [];
        }
        let enviados = 0;
        const cfgRows = await pool.query("SELECT clave, valor FROM configuracion WHERE clave IN ('twilio_sid','twilio_token','twilio_whatsapp')");
        const cfgMap = {};
        cfgRows.rows.forEach((r) => cfgMap[r.clave] = r.valor);
        for (const c of ciudadanos) {
            const mensaje = plantilla.cuerpo.replace(/\{nombre\}/g, c.nombre || 'Ciudadano').replace(/\{evento\}/g, ev.nombre || '');
            await pool.query(`INSERT INTO alertas_whatsapp (ciudadano_id, evento_id, telefono_ciudadano, mensaje_enviado, enviado, timestamp_envio) VALUES ($1,$2,$3,$4,TRUE,NOW())`, [c.id, ev.id, c.telefono, mensaje]);
            if (cfgMap['twilio_sid'] && cfgMap['twilio_token'] && cfgMap['twilio_whatsapp']) {
                const num = c.telefono.startsWith('+') ? c.telefono : '+52' + c.telefono;
                try {
                    await axios_1.default.post(`https://api.twilio.com/2010-04-01/Accounts/${cfgMap['twilio_sid']}/Messages.json`, new URLSearchParams({ From: 'whatsapp:' + cfgMap['twilio_whatsapp'], To: 'whatsapp:' + num, Body: mensaje }), { auth: { username: cfgMap['twilio_sid'], password: cfgMap['twilio_token'] }, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
                }
                catch (e) {
                    console.error('Error Twilio en disparo manual:', e);
                }
            }
            enviados++;
        }
        res.json({ message: `Recordatorio enviado a ${enviados} ciudadanos`, enviados });
    }
    catch (e) {
        console.error('Error disparar alertas:', e);
        res.status(500).json({ error: 'Error al enviar recordatorios' });
    }
});
app.get('/api/alertas/stats', authenticateToken, async (_req, res) => {
    try {
        const result = await pool.query(`SELECT COUNT(*) FILTER (WHERE enviado = FALSE AND retry_count < max_retries) as pendientes, COUNT(*) FILTER (WHERE enviado = TRUE) as enviados, COUNT(*) FILTER (WHERE retry_count >= max_retries AND enviado = FALSE) as fallaron FROM alertas_whatsapp`);
        res.json(result.rows[0]);
    }
    catch {
        res.status(500).json({ error: 'Error' });
    }
});
app.get('/api/alertas/ultimas', authenticateToken, async (_req, res) => {
    try {
        const result = await pool.query(`SELECT a.id, a.telefono_ciudadano, a.mensaje_enviado, a.enviado, a.timestamp_deteccion, a.timestamp_envio, a.retry_count, c.nombre as ciudadano_nombre, e.nombre as evento_nombre FROM alertas_whatsapp a LEFT JOIN ciudadanos c ON c.id = a.ciudadano_id LEFT JOIN eventos e ON e.id = a.evento_id ORDER BY COALESCE(a.timestamp_envio, a.timestamp_deteccion) DESC LIMIT 20`);
        res.json(result.rows);
    }
    catch {
        res.status(500).json({ error: 'Error' });
    }
});
app.get('/api/configuracion', authenticateToken, requireAdmin, async (_req, res) => {
    try {
        const r = await pool.query('SELECT clave, valor, descripcion FROM configuracion ORDER BY clave');
        const obj = {};
        r.rows.forEach((x) => obj[x.clave] = x.valor);
        res.json(obj);
    }
    catch {
        res.status(500).json({ error: 'Error' });
    }
});
app.put('/api/configuracion', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const entries = req.body;
        for (const [clave, valor] of Object.entries(entries)) {
            await pool.query('INSERT INTO configuracion (clave, valor) VALUES ($1,$2) ON CONFLICT (clave) DO UPDATE SET valor=$2', [clave, valor]);
        }
        res.json({ message: 'Configuracion guardada' });
    }
    catch {
        res.status(500).json({ error: 'Error al guardar' });
    }
});
app.post('/api/dispositivos', authenticateToken, async (req, res) => {
    try {
        const { token_fcm, plataforma } = req.body;
        const user = req.user;
        await pool.query('INSERT INTO dispositivos (usuario_id, token_fcm, plataforma) VALUES ($1,$2,$3) ON CONFLICT (usuario_id, token_fcm) DO UPDATE SET actualizado_en=NOW()', [user.userId, token_fcm, plataforma || 'android']);
        res.json({ success: true });
    }
    catch {
        res.status(500).json({ error: 'Error' });
    }
});
// ── Catálogos: discapacidades, ocupaciones y estatus de visita ──
const catalogoConfig = {
    discapacidades: { tabla: 'cat_discapacidades' },
    ocupaciones: { tabla: 'cat_ocupaciones' },
    estatus_visita: { tabla: 'cat_estatus_visita' }
};
function slugClave(s) {
    return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'estatus';
}
app.get('/api/catalogos/:tipo', authenticateToken, async (req, res) => {
    try {
        const cfg = catalogoConfig[req.params.tipo];
        if (!cfg) {
            res.status(404).json({ error: 'Catálogo no encontrado' });
            return;
        }
        const soloActivos = req.query.todos !== '1';
        const r = await pool.query(`SELECT * FROM ${cfg.tabla} ${soloActivos ? 'WHERE activo = TRUE' : ''} ORDER BY orden, nombre`);
        res.json(r.rows);
    }
    catch (e) {
        res.status(500).json({ error: e.message || 'Error' });
    }
});
app.post('/api/catalogos/:tipo', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (!esAdminOCoordinador(user)) {
            res.status(403).json({ error: 'Solo coordinadores y administradores' });
            return;
        }
        const cfg = catalogoConfig[req.params.tipo];
        if (!cfg) {
            res.status(404).json({ error: 'Catálogo no encontrado' });
            return;
        }
        const nombre = String(req.body.nombre || '').trim();
        if (!nombre) {
            res.status(400).json({ error: 'El nombre es requerido' });
            return;
        }
        const dup = await pool.query(`SELECT id FROM ${cfg.tabla} WHERE LOWER(nombre)=LOWER($1)`, [nombre]);
        if (dup.rows.length) {
            res.status(400).json({ error: 'Ya existe un elemento con ese nombre' });
            return;
        }
        const maxR = await pool.query(`SELECT COALESCE(MAX(orden),0)+1 AS n FROM ${cfg.tabla}`);
        let r;
        if (cfg.tabla === 'cat_estatus_visita') {
            let clave = slugClave(nombre);
            const dupC = await pool.query('SELECT id FROM cat_estatus_visita WHERE clave=$1', [clave]);
            if (dupC.rows.length)
                clave = clave.slice(0, 24) + '_' + Date.now().toString(36).slice(-4);
            r = await pool.query('INSERT INTO cat_estatus_visita (clave, nombre, marca_no_abrio, orden) VALUES ($1,$2,$3,$4) RETURNING *', [clave, nombre, req.body.marca_no_abrio === false ? false : true, maxR.rows[0].n]);
        }
        else {
            r = await pool.query(`INSERT INTO ${cfg.tabla} (nombre, orden) VALUES ($1,$2) RETURNING *`, [nombre, maxR.rows[0].n]);
        }
        try {
            if (user?.nombre)
                await logAuditoria(user.userId, user.nombre, `crear_${req.params.tipo}`, cfg.tabla, r.rows[0].id, { nombre });
        }
        catch { }
        res.status(201).json(r.rows[0]);
    }
    catch (e) {
        res.status(500).json({ error: e.message || 'Error' });
    }
});
app.put('/api/catalogos/:tipo/:id', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (!esAdminOCoordinador(user)) {
            res.status(403).json({ error: 'Solo coordinadores y administradores' });
            return;
        }
        const cfg = catalogoConfig[req.params.tipo];
        if (!cfg) {
            res.status(404).json({ error: 'Catálogo no encontrado' });
            return;
        }
        const sets = [];
        const params = [];
        if (req.body.nombre !== undefined) {
            const nombre = String(req.body.nombre).trim();
            if (!nombre) {
                res.status(400).json({ error: 'El nombre es requerido' });
                return;
            }
            const dup = await pool.query(`SELECT id FROM ${cfg.tabla} WHERE LOWER(nombre)=LOWER($1) AND id<>$2`, [nombre, req.params.id]);
            if (dup.rows.length) {
                res.status(400).json({ error: 'Ya existe un elemento con ese nombre' });
                return;
            }
            params.push(nombre);
            sets.push('nombre=$' + params.length);
        }
        if (req.body.activo !== undefined) {
            params.push(!!req.body.activo);
            sets.push('activo=$' + params.length);
        }
        if (req.body.orden !== undefined) {
            params.push(parseInt(req.body.orden) || 0);
            sets.push('orden=$' + params.length);
        }
        if (!sets.length && req.body.marca_no_abrio === undefined) {
            res.status(400).json({ error: 'Nada que actualizar' });
            return;
        }
        if (req.body.marca_no_abrio !== undefined && cfg.tabla === 'cat_estatus_visita') {
            params.push(!!req.body.marca_no_abrio);
            sets.push('marca_no_abrio=$' + params.length);
        }
        params.push(req.params.id);
        const r = await pool.query(`UPDATE ${cfg.tabla} SET ${sets.join(',')} WHERE id=$${params.length} RETURNING *`, params);
        if (!r.rows.length) {
            res.status(404).json({ error: 'No encontrado' });
            return;
        }
        try {
            if (user?.nombre)
                await logAuditoria(user.userId, user.nombre, `editar_${req.params.tipo}`, cfg.tabla, req.params.id, req.body);
        }
        catch { }
        res.json(r.rows[0]);
    }
    catch (e) {
        res.status(500).json({ error: e.message || 'Error' });
    }
});
app.delete('/api/catalogos/:tipo/:id', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (!esAdminOCoordinador(user)) {
            res.status(403).json({ error: 'Solo coordinadores y administradores' });
            return;
        }
        const cfg = catalogoConfig[req.params.tipo];
        if (!cfg) {
            res.status(404).json({ error: 'Catálogo no encontrado' });
            return;
        }
        // Estatus de visita se referencia por clave en motivo_puerta: siempre borrado lógico
        if (cfg.tabla === 'cat_estatus_visita') {
            const r = await pool.query(`UPDATE ${cfg.tabla} SET activo=FALSE WHERE id=$1 RETURNING *`, [req.params.id]);
            if (!r.rows.length) {
                res.status(404).json({ error: 'No encontrado' });
                return;
            }
            try {
                if (user?.nombre)
                    await logAuditoria(user.userId, user.nombre, `eliminar_${req.params.tipo}`, cfg.tabla, req.params.id, {});
            }
            catch { }
            res.json({ ...r.rows[0], desactivado: true });
            return;
        }
        // Borrado lógico si está en uso por ciudadanos
        const uso = await pool.query(`SELECT
        (SELECT COUNT(*) FROM ciudadanos WHERE discapacidad_id=$1) +
        (SELECT COUNT(*) FROM ciudadanos_comprometidos WHERE discapacidad_id=$1) +
        (SELECT COUNT(*) FROM ciudadanos WHERE ocupacion_id=$1) +
        (SELECT COUNT(*) FROM ciudadanos_comprometidos WHERE ocupacion_id=$1) AS n`, [req.params.id]);
        if (parseInt(uso.rows[0].n) > 0) {
            const r = await pool.query(`UPDATE ${cfg.tabla} SET activo=FALSE WHERE id=$1 RETURNING *`, [req.params.id]);
            if (!r.rows.length) {
                res.status(404).json({ error: 'No encontrado' });
                return;
            }
            res.json({ ...r.rows[0], desactivado: true, message: 'En uso por ciudadanos: se desactivó en lugar de eliminar' });
            return;
        }
        const r = await pool.query(`DELETE FROM ${cfg.tabla} WHERE id=$1 RETURNING id`, [req.params.id]);
        if (!r.rows.length) {
            res.status(404).json({ error: 'No encontrado' });
            return;
        }
        try {
            if (user?.nombre)
                await logAuditoria(user.userId, user.nombre, `eliminar_${req.params.tipo}`, cfg.tabla, req.params.id, {});
        }
        catch { }
        res.json({ ok: true });
    }
    catch (e) {
        res.status(500).json({ error: e.message || 'Error' });
    }
});
app.get('/api/rutas', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        let query = `SELECT r.*, u.nombre as enlace_nombre, a.nombre as creador_nombre, s.id as seccion_num,
                 ec.nombre as encuesta_campana_nombre, ec.encuesta_lanzada as encuesta_lanzada
                 FROM rutas r
                 JOIN usuarios u ON u.id = r.enlace_id
                 JOIN usuarios a ON a.id = r.admin_id
                 LEFT JOIN secciones_electorales s ON s.id = r.seccion_id
                 LEFT JOIN campanas ec ON ec.id = r.encuesta_campana_id`;
        const params = [];
        if (user.rol === 'enlace') {
            params.push(user.userId);
            query += ' WHERE r.enlace_id = $1';
        }
        query += ' ORDER BY r.creado_en DESC';
        const r = await pool.query(query, params);
        res.json(r.rows);
    }
    catch (e) {
        res.status(500).json({ error: e.message || 'Error' });
    }
});
app.post('/api/rutas', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (user.rol !== 'admin' && user.rol !== 'coordinador') {
            res.status(403).json({ error: 'No autorizado' });
            return;
        }
        const { enlace_ids, seccion_id, tipo, encuesta_campana_id, filtros } = req.body;
        if (!enlace_ids?.length || !seccion_id) {
            res.status(400).json({ error: 'enlace_ids[] y seccion_id requeridos' });
            return;
        }
        const tipoRuta = ['encuesta', 'seguros', 'filtro'].includes(tipo) ? tipo : 'seguros';
        if (tipoRuta === 'encuesta' && encuesta_campana_id) {
            const ec = (await pool.query('SELECT tipo FROM campanas WHERE id=$1', [encuesta_campana_id])).rows[0];
            if (!ec || ec.tipo !== 'encuesta') {
                res.status(400).json({ error: 'La encuesta asignada no existe o no es tipo encuesta' });
                return;
            }
        }
        let tablaParadas = tipoRuta === 'seguros' ? 'ciudadanos_comprometidos' : 'ciudadanos';
        if (tipoRuta === 'filtro')
            tablaParadas = 'ciudadanos';
        let whereSql = 'seccion_id=$1';
        const countParams = [seccion_id];
        if (tipoRuta === 'filtro') {
            const w = routingService.construirWhereFiltros(filtros || {}, countParams);
            whereSql += w.sql;
            if (!w.algunaCondicion) {
                res.status(400).json({ error: 'Define al menos un filtro para crear una ruta por filtro' });
                return;
            }
        }
        const countRes = await pool.query(`SELECT COUNT(*) FROM ${tablaParadas} c WHERE ${whereSql}`, countParams);
        if (parseInt(countRes.rows[0].count) === 0) {
            res.status(400).json({ error: `No hay ciudadanos que cumplan los filtros en esta sección` });
            return;
        }
        const misiones = await routingService.repartirRutas(seccion_id.toString(), tipoRuta, enlace_ids.length, tipoRuta === 'filtro' ? filtros : undefined);
        const ids = [];
        for (let i = 0; i < enlace_ids.length; i++) {
            const mision = misiones[i] || { paradas: [], distancia_total_km: 0, tiempo_total_minutos: 0 };
            const r = await pool.query(`INSERT INTO rutas (admin_id, enlace_id, seccion_id, tipo, solo_simpatizantes, paradas, distancia_total_km, tiempo_total_minutos, encuesta_campana_id, polyline)
         VALUES ($1,$2,$3,$4,FALSE,$5,$6,$7,$8,$9) RETURNING id`, [user.userId, enlace_ids[i], seccion_id, tipoRuta, JSON.stringify(mision.paradas || []),
                mision.distancia_total_km || 0, mision.tiempo_total_minutos || 0, (tipoRuta === 'encuesta' ? encuesta_campana_id : null) || null,
                mision.polyline ? JSON.stringify(mision.polyline) : null]);
            ids.push(r.rows[0].id);
        }
        const sockets = await io.fetchSockets();
        enlace_ids.forEach((eid) => sockets.forEach(s => { if (s.userId === eid)
            s.emit('nueva-ruta', { ids }); }));
        // Send push notification to each enlace
        const tipoLabel = tipoRuta === 'seguros' ? 'de seguros' : (tipoRuta === 'filtro' ? 'por filtro' : 'de encuesta');
        for (const eid of enlace_ids) {
            await sendPushToUser(eid, 'Nueva ruta asignada', `Se te ha asignado una ruta ${tipoLabel}`, '/mi-ruta');
        }
        res.status(201).json({ ids, message: `Rutas ${tipoLabel} creadas para ${enlace_ids.length} enlace(s) con paradas distribuidas` });
    }
    catch (e) {
        res.status(500).json({ error: 'Error al crear rutas: ' + (e.message || '') });
    }
});
// Preview de conteo para rutas por filtro
app.post('/api/rutas/preview-filtro', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (user.rol !== 'admin' && user.rol !== 'coordinador') {
            res.status(403).json({ error: 'No autorizado' });
            return;
        }
        const { seccion_id, filtros } = req.body;
        if (!seccion_id) {
            res.status(400).json({ error: 'seccion_id requerido' });
            return;
        }
        const params = [seccion_id];
        const w = routingService.construirWhereFiltros(filtros || {}, params);
        const r = await pool.query(`SELECT COUNT(*)::int AS total FROM ciudadanos c WHERE c.seccion_id=$1${w.sql}`, params);
        res.json({ total: r.rows[0]?.total || 0 });
    }
    catch (e) {
        res.status(500).json({ error: e.message || 'Error' });
    }
});
app.get('/api/rutas/:id', authenticateToken, async (req, res) => {
    try {
        const r = await pool.query(`SELECT r.*, u.nombre as enlace_nombre, c.nombre as encuesta_campana_nombre, c.encuesta_lanzada FROM rutas r JOIN usuarios u ON u.id = r.enlace_id LEFT JOIN campanas c ON c.id = r.encuesta_campana_id WHERE r.id=$1`, [req.params.id]);
        if (!r.rows.length) {
            res.status(404).json({ error: 'No encontrada' });
            return;
        }
        const ruta = r.rows[0];
        if (ruta.paradas?.length && ruta.seccion_id) {
            const v = await pool.query(`SELECT ciudadano_id, comprometido_id FROM votos
         WHERE casilla_id IN (SELECT id FROM casillas WHERE seccion_id=$1)`, [ruta.seccion_id]);
            const votIds = new Set(v.rows.flatMap((rw) => [rw.ciudadano_id, rw.comprometido_id].filter(Boolean)));
            ruta.paradas.forEach((p) => { p.ya_voto = votIds.has(p.id); });
        }
        res.json(ruta);
    }
    catch {
        res.status(500).json({ error: 'Error' });
    }
});
app.delete('/api/rutas/:id', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        await pool.query('DELETE FROM rutas WHERE id=$1', [req.params.id]);
        res.json({ message: 'Ruta eliminada' });
    }
    catch {
        res.status(500).json({ error: 'Error' });
    }
});
app.patch('/api/rutas/:id/estado', authenticateToken, async (req, res) => {
    try {
        const { estado } = req.body;
        if (!['pendiente', 'en_progreso', 'completada'].includes(estado)) {
            res.status(400).json({ error: 'Estado invalido' });
            return;
        }
        const user = req.user;
        const r = await pool.query('SELECT enlace_id FROM rutas WHERE id=$1', [req.params.id]);
        if (!r.rows.length) {
            res.status(404).json({ error: 'No encontrada' });
            return;
        }
        if (user.rol !== 'admin' && r.rows[0].enlace_id !== user.userId) {
            res.status(403).json({ error: 'No autorizado' });
            return;
        }
        const completado = estado === 'completada' ? 'NOW()' : null;
        await pool.query(`UPDATE rutas SET estado=$1${completado ? ', completado_en=NOW()' : ''} WHERE id=$2`, [estado, req.params.id]);
        if (estado === 'completada') {
            const sockets = await io.fetchSockets();
            sockets.forEach(s => { if (s.userId === r.rows[0].enlace_id)
                s.emit('ruta-completada', { id: req.params.id }); });
            await sendPushToRole('coordinador', 'Ruta completada', 'Un enlace ha completado su ruta de cambaceo', '/reportes');
            await sendPushToRole('admin', 'Ruta completada', 'Un enlace ha completado su ruta de cambaceo', '/reportes');
        }
        res.json({ message: 'Estado actualizado' });
    }
    catch {
        res.status(500).json({ error: 'Error' });
    }
});
app.patch('/api/rutas/:id/parada/:idx', authenticateToken, async (req, res) => {
    try {
        const { visitado, gps_confirmado, evidencia, no_abrio, lat, lng } = req.body;
        // Estatus de visita opcional (clave del catálogo cat_estatus_visita)
        let estatusRow = null;
        if (req.body.resultado) {
            try {
                const er = await pool.query('SELECT clave, nombre, marca_no_abrio FROM cat_estatus_visita WHERE clave=$1 AND activo=TRUE', [String(req.body.resultado).slice(0, 30)]);
                estatusRow = er.rows[0] || null;
            }
            catch {
                estatusRow = null;
            }
        }
        const q = await pool.query('SELECT paradas FROM rutas WHERE id=$1', [req.params.id]);
        if (!q.rows.length) {
            res.status(404).json({ error: 'No encontrada' });
            return;
        }
        const paradas = q.rows[0].paradas;
        const idx = parseInt(req.params.idx);
        if (!paradas[idx]) {
            res.status(400).json({ error: 'Índice inválido' });
            return;
        }
        if (visitado !== undefined)
            paradas[idx].visitado = !!visitado;
        if (gps_confirmado !== undefined)
            paradas[idx].gps_confirmado = !!gps_confirmado;
        if (evidencia !== undefined)
            paradas[idx].evidencia = evidencia;
        if (no_abrio !== undefined) {
            paradas[idx].no_abrio = !!no_abrio;
            if (no_abrio) {
                paradas[idx].visitado = true;
            }
        }
        if (estatusRow && estatusRow.marca_no_abrio) {
            paradas[idx].no_abrio = true;
            paradas[idx].visitado = true;
        }
        if (estatusRow && !estatusRow.marca_no_abrio) {
            paradas[idx].no_abrio = false;
        }
        if (estatusRow)
            paradas[idx].resultado = estatusRow.clave;
        else if (req.body.resultado === null)
            delete paradas[idx].resultado;
        await pool.query('UPDATE rutas SET paradas=$1 WHERE id=$2', [JSON.stringify(paradas), req.params.id]);
        // Historial por ciudadano: cada marca de visita en ruta genera una fila en `visitas`
        // tipo 'ruta' con el resultado (abrió / no abrió / estatus), GPS del enlace y referencia a la ruta.
        const cid = paradas[idx] ? (paradas[idx].ciudadano_id || paradas[idx].id) : null;
        if (cid) {
            try {
                if ((visitado === true || no_abrio === true || estatusRow)) {
                    await pool.query("DELETE FROM visitas WHERE ciudadano_id=$1 AND tipo='ruta' AND notas LIKE $2", [cid, 'ruta:' + req.params.id + '%']);
                    const partesNotas = ['ruta:' + req.params.id, 'abrio:' + (paradas[idx].no_abrio ? 'no' : 'si')];
                    if (estatusRow)
                        partesNotas.push('res:' + estatusRow.clave);
                    await pool.query('INSERT INTO visitas (id, ciudadano_id, usuario_id, tipo, lat, lng, notas) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
                        crypto_1.default.randomUUID(), cid, req.user?.userId || null, 'ruta',
                        lat != null ? Number(lat) : null, lng != null ? Number(lng) : null,
                        partesNotas.join('|')
                    ]);
                    // El estatus capturado en ruta alimenta el perfil del ciudadano
                    if (estatusRow) {
                        await pool.query('UPDATE ciudadanos SET motivo_puerta=$2, no_abrio=$3 WHERE id=$1', [cid, estatusRow.clave, estatusRow.marca_no_abrio]);
                    }
                }
                else if (visitado === false && no_abrio !== true) {
                    await pool.query("DELETE FROM visitas WHERE ciudadano_id=$1 AND tipo='ruta' AND notas LIKE $2", [cid, 'ruta:' + req.params.id + '%']);
                }
            }
            catch (e) {
                console.warn('visita ruta:', e?.message);
            }
        }
        res.json({ message: 'Parada actualizada' });
    }
    catch (e) {
        res.status(500).json({ error: 'Error: ' + (e.message || '') });
    }
});
app.post('/api/rutas/mision', authenticateToken, async (req, res) => {
    try {
        const { seccion_id, tipo } = req.body;
        if (!seccion_id) {
            res.status(400).json({ error: 'seccion_id requerido' });
            return;
        }
        const centroid = await routingService.obtenerCentroideSeccion(seccion_id.toString());
        const mision = await routingService.calcularRutaOptima(centroid || { lat: 20.6434, lng: -100.9929 }, seccion_id.toString(), tipo === 'seguros' ? 'seguros' : 'encuesta');
        res.json(mision);
    }
    catch (e) {
        res.status(500).json({ error: 'Error al calcular misión: ' + (e.message || '') });
    }
});
app.post('/api/rutas/optimizar', authenticateToken, async (req, res) => {
    try {
        const { origen_lat, origen_lng, seccion_id, tipo } = req.body;
        if (!origen_lat || !origen_lng || !seccion_id) {
            res.status(400).json({ error: 'Faltan datos' });
            return;
        }
        const ruta = await routingService.calcularRutaOptima({ lat: origen_lat, lng: origen_lng }, seccion_id.toString(), tipo === 'seguros' ? 'seguros' : 'encuesta');
        res.json(ruta);
    }
    catch {
        res.status(500).json({ error: 'Error' });
    }
});
app.get('/api/rutas/paradas/:seccionId', authenticateToken, async (req, res) => {
    try {
        const tipo = (req.query.tipo === 'seguros' ? 'seguros' : 'encuesta');
        const paradas = await routingService['obtenerParadas'](req.params.seccionId, tipo);
        res.json(paradas);
    }
    catch {
        res.status(500).json({ error: 'Error' });
    }
});
app.get('/api/geo/geocercas/:seccionId?', authenticateToken, async (req, res) => {
    try {
        const geocercas = await eventService.obtenerGeocercasActivas(req.params.seccionId);
        res.json(geocercas);
    }
    catch {
        res.status(500).json({ error: 'Error' });
    }
});
app.post('/api/geo/proximidad', authenticateToken, async (req, res) => {
    try {
        const { ciudadano_id, geocerca_id } = req.body;
        if (!ciudadano_id || !geocerca_id) {
            res.status(400).json({ error: 'Faltan datos' });
            return;
        }
        const distancia = await eventService.proximidadCiudadano(ciudadano_id, geocerca_id);
        res.json({ distancia });
    }
    catch {
        res.status(500).json({ error: 'Error' });
    }
});
app.post('/api/geo/ubicacion', async (req, res) => {
    try {
        const { latitude, longitude, accuracy } = req.body;
        const authHeader = req.headers['authorization'];
        if (!authHeader) {
            res.status(401).json({ error: 'No autorizado' });
            return;
        }
        const decoded = jsonwebtoken_1.default.verify(authHeader.split(' ')[1], JWT_SECRET);
        await pool.query('INSERT INTO ubicaciones_enlace (user_id, lat, lng, precision) VALUES ($1,$2,$3,$4)', [decoded.userId, latitude, longitude, accuracy || 0]);
        res.json({ success: true });
    }
    catch {
        res.status(500).json({ error: 'Error al registrar ubicación' });
    }
});
app.get('/api/partidos', authenticateToken, async (_req, res) => {
    const result = await pool.query('SELECT id, nombre, abreviatura, color, es_favorito FROM partidos_politicos ORDER BY es_favorito DESC, nombre');
    res.json(result.rows);
});
app.post('/api/partidos', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    const { nombre, abreviatura, color, es_favorito } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const r = await client.query('INSERT INTO partidos_politicos (nombre, abreviatura, color, es_favorito) VALUES ($1,$2,$3,$4) RETURNING id', [nombre, abreviatura, color || '#999999', !!es_favorito]);
        if (es_favorito)
            await client.query('UPDATE partidos_politicos SET es_favorito = (id = $1)', [r.rows[0].id]);
        await client.query('COMMIT');
    }
    catch (e) {
        await client.query('ROLLBACK');
        throw e;
    }
    finally {
        client.release();
    }
    res.status(201).json({ message: 'Partido guardado' });
});
app.put('/api/partidos/:id', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    const { nombre, abreviatura, color, es_favorito } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (es_favorito) {
            await client.query('UPDATE partidos_politicos SET es_favorito = (id = $1)', [req.params.id]);
        }
        await client.query('UPDATE partidos_politicos SET nombre=$1, abreviatura=$2, color=$3 WHERE id=$4', [nombre, abreviatura, color, req.params.id]);
        await client.query('COMMIT');
    }
    catch (e) {
        await client.query('ROLLBACK');
        throw e;
    }
    finally {
        client.release();
    }
    res.json({ message: 'Partido actualizado' });
});
app.delete('/api/partidos/:id', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    await pool.query('DELETE FROM partidos_politicos WHERE id=$1', [req.params.id]);
    res.json({ message: 'Partido eliminado' });
});
app.get('/api/casillas', authenticateToken, async (req, res) => {
    try {
        const { seccion_id } = req.query;
        const user = req.user;
        let query = `SELECT c.id, c.seccion_id, c.nombre, c.direccion, c.lat, c.lng, c.meta_votos, m.nombre as municipio
                 FROM casillas c
                 JOIN secciones_electorales s ON s.id = c.seccion_id
                 JOIN municipios m ON m.id = s.municipio_id`;
        const params = [];
        const conds = [];
        if (user.rol === 'enlace') {
            const secs = await getUserSecciones(user.userId);
            if (!secs.length) {
                res.json([]);
                return;
            }
            params.push(secs);
            conds.push(`c.seccion_id = ANY($${params.length})`);
        }
        if (seccion_id) {
            params.push(seccion_id);
            conds.push(`c.seccion_id = $${params.length}`);
        }
        if (conds.length)
            query += ' WHERE ' + conds.join(' AND ');
        query += ' ORDER BY c.seccion_id, c.nombre';
        const result = await pool.query(query, params);
        res.json(result.rows);
    }
    catch (e) {
        console.error('GET /api/casillas error:', e?.message || e);
        res.status(500).json({ error: 'Error al obtener casillas' });
    }
});
app.post('/api/casillas', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        const { seccion_id, nombre, direccion, lat, lng, meta_votos } = req.body;
        if (!seccion_id || !nombre) {
            res.status(400).json({ error: 'seccion_id y nombre requeridos' });
            return;
        }
        await pool.query('INSERT INTO casillas (seccion_id, nombre, direccion, lat, lng, meta_votos) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (seccion_id,nombre) DO UPDATE SET direccion=$3, lat=$4, lng=$5, meta_votos=$6', [seccion_id, nombre, direccion || '', lat != null ? parseFloat(lat) : null, lng != null ? parseFloat(lng) : null, meta_votos || 0]);
        res.status(201).json({ message: 'Casilla guardada' });
    }
    catch (e) {
        console.error('POST /api/casillas error:', e?.message || e);
        res.status(500).json({ error: 'Error al guardar casilla' });
    }
});
app.put('/api/casillas/:id', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        const { nombre, direccion, seccion_id, lat, lng, meta_votos } = req.body;
        await pool.query('UPDATE casillas SET seccion_id=$1, nombre=$2, direccion=$3, lat=$4, lng=$5, meta_votos=$6 WHERE id=$7', [seccion_id, nombre, direccion || '', lat != null ? parseFloat(lat) : null, lng != null ? parseFloat(lng) : null, meta_votos || 0, req.params.id]);
        res.json({ message: 'Casilla actualizada' });
    }
    catch (e) {
        console.error('PUT /api/casillas error:', e?.message || e);
        res.status(500).json({ error: 'Error al actualizar casilla' });
    }
});
app.delete('/api/casillas/:id', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        await pool.query('DELETE FROM casillas WHERE id=$1', [req.params.id]);
        res.json({ message: 'Casilla eliminada' });
    }
    catch (e) {
        console.error('DELETE /api/casillas error:', e?.message || e);
        res.status(500).json({ error: 'Error al eliminar casilla' });
    }
});
app.get('/api/resultados', authenticateToken, async (req, res) => {
    try {
        const { seccion_id, casilla_id, tipo } = req.query;
        let query = `SELECT r.id, r.casilla_id, r.partido_id, r.votos, r.tipo, c.seccion_id,
                 p.nombre as partido, p.abreviatura, p.color
                 FROM resultados_casilla r
                 JOIN casillas c ON c.id = r.casilla_id
                 JOIN partidos_politicos p ON p.id = r.partido_id`;
        const params = [];
        const conds = [];
        if (tipo) {
            params.push(tipo);
            conds.push(`r.tipo = $${params.length}`);
        }
        if (casilla_id) {
            params.push(casilla_id);
            conds.push(`r.casilla_id = $${params.length}`);
        }
        else if (seccion_id) {
            params.push(seccion_id);
            conds.push(`c.seccion_id = $${params.length}`);
        }
        if (conds.length)
            query += ' WHERE ' + conds.join(' AND ');
        query += ' ORDER BY c.seccion_id, c.nombre, p.nombre';
        const result = await pool.query(query, params);
        res.json(result.rows);
    }
    catch (e) {
        console.error('GET /api/resultados error:', e?.message || e);
        res.status(500).json({ error: 'Error al obtener resultados' });
    }
});
app.post('/api/resultados', authenticateToken, async (req, res) => {
    try {
        const { casilla_id, partido_id, votos, tipo } = req.body;
        await pool.query(`INSERT INTO resultados_casilla (casilla_id, partido_id, votos, tipo)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (casilla_id, partido_id, tipo) DO UPDATE SET votos=$3`, [casilla_id, partido_id, votos, tipo || 'presidente_municipal']);
        res.status(201).json({ message: 'Resultado guardado' });
    }
    catch (e) {
        console.error('POST /api/resultados error:', e?.message || e);
        res.status(500).json({ error: 'Error al guardar resultado' });
    }
});
app.delete('/api/resultados/:id', authenticateToken, async (req, res) => {
    try {
        await pool.query('DELETE FROM resultados_casilla WHERE id=$1', [req.params.id]);
        res.json({ message: 'Resultado eliminado' });
    }
    catch (e) {
        console.error('DELETE /api/resultados error:', e?.message || e);
        res.status(500).json({ error: 'Error al eliminar resultado' });
    }
});
// ---- Votos (ya votaron) ----
async function votacionActiva() {
    const cfg = await pool.query("SELECT valor FROM configuracion WHERE clave='fecha_eleccion'");
    const valor = cfg.rows[0]?.valor;
    if (!valor || !/^\d{4}-\d{2}-\d{2}$/.test(valor))
        return { fecha: null, activa: false };
    const hoy = await pool.query("SELECT (NOW() AT TIME ZONE 'America/Mexico_City')::date::text AS d");
    return { fecha: valor, activa: String(hoy.rows[0].d) === valor };
}
app.get('/api/reportes/votacion-estado', authenticateToken, async (_req, res) => {
    try {
        const st = await votacionActiva();
        res.json(st);
    }
    catch (e) {
        console.error('GET /api/reportes/votacion-estado error:', e?.message || e);
        res.status(500).json({ error: 'Error' });
    }
});
app.post('/api/votos', authenticateToken, async (req, res) => {
    try {
        const st = await votacionActiva();
        if (!st.activa) {
            res.status(403).json({ error: st.fecha ? `La votación solo se registra el día de la elección (${st.fecha})` : 'Configura el día de la elección para habilitar el registro de votos' });
            return;
        }
        const { ciudadano_id, comprometido_id } = req.body;
        if (!ciudadano_id && !comprometido_id) {
            res.status(400).json({ error: 'ciudadano_id o comprometido_id requerido' });
            return;
        }
        const ref = ciudadano_id ? { tabla: 'ciudadanos', col: 'ciudadano_id', id: ciudadano_id } : { tabla: 'ciudadanos_comprometidos', col: 'comprometido_id', id: comprometido_id };
        const per = await pool.query(`SELECT c.intencion_voto_presidente as partido_id, c.casilla_id
       FROM ${ref.tabla} c WHERE c.id=$1`, [ref.id]);
        if (!per.rows.length) {
            res.status(404).json({ error: 'No encontrado' });
            return;
        }
        await pool.query(`INSERT INTO votos (ciudadano_id, comprometido_id, partido_id, casilla_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT DO NOTHING`, [ciudadano_id || null, comprometido_id || null, per.rows[0].partido_id || null, per.rows[0].casilla_id || null]);
        res.status(201).json({ votado: true });
        try {
            io.emit('actualizar-votos', { casilla_id: per.rows[0].casilla_id });
        }
        catch (e) {
            console.warn('io.emit error:', e);
        }
    }
    catch (e) {
        console.error('POST /api/votos error:', e?.message || e);
        res.status(500).json({ error: 'Error al marcar voto' });
    }
});
app.delete('/api/votos/:tipo/:id', authenticateToken, async (req, res) => {
    try {
        const st = await votacionActiva();
        if (!st.activa) {
            res.status(403).json({ error: st.fecha ? `La votación solo se registra el día de la elección (${st.fecha})` : 'Configura el día de la elección para habilitar el registro de votos' });
            return;
        }
        const { tipo, id } = req.params;
        if (tipo !== 'ciudadano' && tipo !== 'comprometido') {
            res.status(400).json({ error: 'tipo inválido' });
            return;
        }
        const col = tipo === 'ciudadano' ? 'ciudadano_id' : 'comprometido_id';
        await pool.query(`DELETE FROM votos WHERE ${col}=$1`, [id]);
        res.json({ votado: false });
        try {
            io.emit('actualizar-votos', {});
        }
        catch (e) {
            console.warn('io.emit error:', e);
        }
    }
    catch (e) {
        console.error('DELETE /api/votos error:', e?.message || e);
        res.status(500).json({ error: 'Error' });
    }
});
// Votantes esperados por casilla (ciudadanos + comprometidos asignados)
app.get('/api/casillas/:id/votantes', authenticateToken, async (req, res) => {
    try {
        const casillaId = req.params.id;
        const user = req.user;
        const c = await pool.query('SELECT id, seccion_id, nombre, direccion, meta_votos FROM casillas WHERE id=$1', [casillaId]);
        if (!c.rows.length) {
            res.status(404).json({ error: 'Casilla no encontrada' });
            return;
        }
        if (user.rol === 'enlace') {
            const perm = await pool.query('SELECT 1 FROM usuarios_secciones WHERE usuario_id=$1 AND seccion_id=$2', [user.userId, c.rows[0].seccion_id]);
            if (!perm.rows.length) {
                res.status(403).json({ error: 'No tienes permiso sobre esa casilla' });
                return;
            }
        }
        if (user.rol === 'representante') {
            const perm = await pool.query('SELECT 1 FROM representantes_casillas WHERE representante_id=$1 AND casilla_id=$2', [user.userId, casillaId]);
            if (!perm.rows.length) {
                res.status(403).json({ error: 'No tienes permiso sobre esa casilla' });
                return;
            }
        }
        const [ciud, comp, fav] = await Promise.all([
            pool.query(`SELECT c.id, c.nombre, c.telefono, c.casilla_id, c.prioridad,
                c.intencion_voto_presidente as partido_id, pp.nombre as partido_nombre, pp.abreviatura, pp.color,
                (v.ciudadano_id IS NOT NULL) as ya_voto
         FROM ciudadanos c
         LEFT JOIN partidos_politicos pp ON pp.id = c.intencion_voto_presidente
         LEFT JOIN votos v ON v.ciudadano_id = c.id
         WHERE c.casilla_id = $1 ORDER BY c.nombre`, [casillaId]),
            pool.query(`SELECT c.id, c.nombre, c.telefono, c.casilla_id,
                c.intencion_voto_presidente as partido_id, pp.nombre as partido_nombre, pp.abreviatura, pp.color,
                (v.comprometido_id IS NOT NULL) as ya_voto
         FROM ciudadanos_comprometidos c
         LEFT JOIN partidos_politicos pp ON pp.id = c.intencion_voto_presidente
         LEFT JOIN votos v ON v.comprometido_id = c.id
         WHERE c.casilla_id = $1 ORDER BY c.nombre`, [casillaId]),
            pool.query('SELECT id, nombre, abreviatura, color FROM partidos_politicos WHERE es_favorito LIMIT 1')
        ]);
        const votados = await pool.query('SELECT ciudadano_id, comprometido_id, partido_id FROM votos WHERE casilla_id=$1', [casillaId]);
        const votosFavorito = fav.rows.length ? votados.rows.filter(v => v.partido_id === fav.rows[0].id).length : 0;
        res.json({
            casilla: c.rows[0],
            partido_favorito: fav.rows[0] || null,
            votantes: [...ciud.rows.map((r) => ({ ...r, tipo: 'ciudadano' })),
                ...comp.rows.map((r) => ({ ...r, tipo: 'comprometido' }))],
            conteo: {
                esperados: ciud.rows.length + comp.rows.length,
                votados: votados.rows.length,
                votos_favorito: votosFavorito,
                meta: c.rows[0].meta_votos || 0
            }
        });
    }
    catch (e) {
        console.error('GET /api/casillas/:id/votantes error:', e?.message || e);
        res.status(500).json({ error: 'Error' });
    }
});
// Reporte de votación por sección/casilla
app.get('/api/reportes/votacion', authenticateToken, async (req, res) => {
    try {
        const { seccion_id } = req.query;
        let query = `SELECT c.id as seccion_id, cas.id as casilla_id, cas.nombre as casilla, cas.meta_votos,
        COALESCE(v.cnt,0) as votos, COALESCE(v.fav,0) as votos_favorito
      FROM casillas cas
      JOIN secciones_electorales c ON c.id = cas.seccion_id
      LEFT JOIN LATERAL (
        SELECT count(*)::int cnt, count(*) FILTER (WHERE partido_id = (SELECT id FROM partidos_politicos WHERE es_favorito LIMIT 1))::int fav
        FROM votos WHERE casilla_id = cas.id
      ) v ON true`;
        const params = [];
        if (seccion_id) {
            query += ' WHERE c.id = $1';
            params.push(seccion_id);
        }
        query += ' ORDER BY c.id, cas.nombre';
        const result = await pool.query(query, params);
        const porSeccion = {};
        for (const r of result.rows) {
            if (!porSeccion[r.seccion_id])
                porSeccion[r.seccion_id] = { seccion_id: r.seccion_id, casillas: 0, meta: 0, votos: 0, votos_favorito: 0 };
            porSeccion[r.seccion_id].casillas++;
            porSeccion[r.seccion_id].meta += r.meta_votos || 0;
            porSeccion[r.seccion_id].votos += r.votos;
            porSeccion[r.seccion_id].votos_favorito += r.votos_favorito;
        }
        res.json({ por_casilla: result.rows, por_seccion: Object.values(porSeccion) });
    }
    catch (e) {
        console.error('GET /api/reportes/votacion error:', e?.message || e);
        res.status(500).json({ error: 'Error' });
    }
});
// Votación por hora (últimas 48 h) para gráfica histórica
app.get('/api/reportes/votacion-horaria', authenticateToken, async (req, res) => {
    try {
        const { seccion_id, casilla_id } = req.query;
        const params = [];
        const conds = [];
        if (seccion_id) {
            params.push(seccion_id);
            conds.push(`cas.seccion_id = $${params.length}`);
        }
        if (casilla_id) {
            params.push(casilla_id);
            conds.push(`v.casilla_id = $${params.length}`);
        }
        const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
        const result = await pool.query(`
      SELECT to_char(date_trunc('hour', v.created_at), 'YYYY-MM-DD HH24:00') AS hora,
             count(*)::int AS votos
      FROM votos v JOIN casillas cas ON cas.id = v.casilla_id
      ${where}
      GROUP BY 1 ORDER BY 1 DESC LIMIT 48`, params);
        const rows = result.rows.reverse();
        let acum = 0;
        res.json(rows.map((r) => { acum += Number(r.votos || 0); return { hora: r.hora, votos: Number(r.votos || 0), acumulado: acum }; }));
    }
    catch (e) {
        console.error('GET /api/reportes/votacion-horaria error:', e?.message || e);
        res.status(500).json({ error: 'Error' });
    }
});
// Reporte de tendencias: serie diaria de capturas, seguros y votos en un rango
app.get('/api/reportes/tendencias', authenticateToken, async (req, res) => {
    try {
        const dias = Math.min(Math.max(parseInt(String(req.query.dias || '30')) || 30, 1), 365);
        const seccionId = req.query.seccion_id;
        const municipioId = req.query.municipio_id;
        const params = [];
        let filtroSecCiud = '';
        let filtroSecSeg = '';
        if (seccionId) {
            params.push(seccionId);
            filtroSecCiud = ` AND c.seccion_id=$${params.length}`;
            filtroSecSeg = ` AND c.seccion_id=$${params.length}`;
        }
        else if (municipioId) {
            params.push(municipioId);
            filtroSecCiud = ` AND s.municipio_id=$${params.length}`;
            filtroSecSeg = ` AND s.municipio_id=$${params.length}`;
        }
        const rCapturas = await pool.query(`SELECT date(c.created_at) AS dia, COUNT(*)::int AS total
       FROM ciudadanos c JOIN secciones_electorales s ON s.id=c.seccion_id
       WHERE c.created_at >= NOW() - ($${params.length + 1} || ' days')::interval ${filtroSecCiud}
       GROUP BY 1`, [...params, dias]);
        const rSeguros = await pool.query(`SELECT date(c.created_at) AS dia, COUNT(*)::int AS total
       FROM ciudadanos_comprometidos c JOIN secciones_electorales s ON s.id=c.seccion_id
       WHERE c.created_at >= NOW() - ($${params.length + 1} || ' days')::interval ${filtroSecSeg}
       GROUP BY 1`, [...params, dias]);
        const paramsVotos = [dias];
        let filtroVotos = '';
        if (seccionId) {
            paramsVotos.push(seccionId);
            filtroVotos = ` AND s.id=$${paramsVotos.length}`;
        }
        else if (municipioId) {
            paramsVotos.push(municipioId);
            filtroVotos = ` AND s.municipio_id=$${paramsVotos.length}`;
        }
        const rVotos = await pool.query(`SELECT date(v.created_at) AS dia, COUNT(*)::int AS total
       FROM votos v
       JOIN casillas cas ON cas.id=v.casilla_id
       JOIN secciones_electorales s ON s.id=cas.seccion_id
       WHERE v.created_at >= NOW() - ($1 || ' days')::interval ${filtroVotos}
       GROUP BY 1`, paramsVotos);
        // Serie completa de días
        const mapa = {};
        for (let i = dias - 1; i >= 0; i--) {
            const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
            mapa[d] = { fecha: d, capturas: 0, seguros: 0, votos: 0 };
        }
        rCapturas.rows.forEach((r) => { const k = String(r.dia).slice(0, 10); if (mapa[k])
            mapa[k].capturas = Number(r.total); });
        rSeguros.rows.forEach((r) => { const k = String(r.dia).slice(0, 10); if (mapa[k])
            mapa[k].seguros = Number(r.total); });
        rVotos.rows.forEach((r) => { const k = String(r.dia).slice(0, 10); if (mapa[k])
            mapa[k].votos = Number(r.total); });
        res.json(Object.values(mapa));
    }
    catch (e) {
        console.error('GET /api/reportes/tendencias error:', e?.message || e);
        res.status(500).json({ error: 'Error' });
    }
});
// ---- Incidencias de casilla ----
app.post('/api/incidencias', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { casilla_id, ruta_id, tipo, descripcion, evidencia } = req.body || {};
        if (!tipo) {
            res.status(400).json({ error: 'tipo es requerido' });
            return;
        }
        if (!descripcion || !String(descripcion).trim()) {
            res.status(400).json({ error: 'Describe la incidencia' });
            return;
        }
        let insCasilla = null;
        let insSeccion = null;
        let insRuta = null;
        if (user.rol === 'enlace') {
            if (!ruta_id) {
                res.status(400).json({ error: 'Selecciona tu ruta de barrido' });
                return;
            }
            const rr = await pool.query('SELECT id, enlace_id, seccion_id FROM rutas WHERE id=$1', [ruta_id]);
            if (!rr.rows.length) {
                res.status(404).json({ error: 'Ruta no encontrada' });
                return;
            }
            if (rr.rows[0].enlace_id !== user.userId) {
                res.status(403).json({ error: 'Esa ruta no te pertenece' });
                return;
            }
            insRuta = ruta_id;
            insSeccion = rr.rows[0].seccion_id;
        }
        else if (ruta_id) {
            const rr = await pool.query('SELECT id, enlace_id, seccion_id FROM rutas WHERE id=$1', [ruta_id]);
            if (!rr.rows.length) {
                res.status(404).json({ error: 'Ruta no encontrada' });
                return;
            }
            insRuta = ruta_id;
            insSeccion = rr.rows[0].seccion_id;
        }
        else {
            if (!casilla_id) {
                res.status(400).json({ error: 'Selecciona una casilla' });
                return;
            }
            if (user.rol === 'representante') {
                const perm = await pool.query('SELECT 1 FROM representantes_casillas WHERE representante_id=$1 AND casilla_id=$2', [user.userId, casilla_id]);
                if (!perm.rows.length) {
                    res.status(403).json({ error: 'No tienes permiso sobre esa casilla' });
                    return;
                }
            }
            insCasilla = casilla_id;
        }
        const r = await pool.query(`INSERT INTO incidencias (casilla_id, seccion_id, ruta_id, tipo, descripcion, creado_por, evidencia) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [insCasilla, insSeccion, insRuta, tipo, String(descripcion).trim(), user.userId, evidencia || null]);
        try {
            const det = await pool.query(`SELECT i.id, i.tipo, i.estado, i.descripcion, i.ruta_id, i.created_at, COALESCE(cas.seccion_id, i.seccion_id) AS seccion_id, u.nombre AS creado_por_nombre
         FROM incidencias i LEFT JOIN casillas cas ON cas.id = i.casilla_id LEFT JOIN usuarios u ON u.id = i.creado_por WHERE i.id = $1`, [r.rows[0].id]);
            const sockets = await io.fetchSockets();
            sockets.forEach(s => {
                if (s.rol === 'admin' || s.rol === 'coordinador')
                    s.emit('nueva-incidencia', det.rows[0] || { id: r.rows[0].id, tipo, ruta_id: insRuta, seccion_id: insSeccion });
            });
        }
        catch (e) {
            console.warn('Emitir nueva-incidencia:', e?.message || e);
        }
        res.status(201).json({ id: r.rows[0].id });
    }
    catch (e) {
        console.error('POST /api/incidencias error:', e?.message || e);
        res.status(500).json({ error: 'Error al registrar incidencia' });
    }
});
app.get('/api/incidencias', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { seccion_id, estado } = req.query;
        const params = [];
        const conds = [];
        if (user.rol === 'enlace') {
            params.push(user.userId);
            conds.push(`(i.seccion_id IN (SELECT seccion_id FROM usuarios_secciones WHERE usuario_id = $${params.length}) OR cas.seccion_id IN (SELECT seccion_id FROM usuarios_secciones WHERE usuario_id = $${params.length}))`);
        }
        if (user.rol === 'representante') {
            params.push(user.userId);
            conds.push(`cas.id IN (SELECT casilla_id FROM representantes_casillas WHERE representante_id = $${params.length})`);
        }
        if (seccion_id) {
            params.push(seccion_id);
            conds.push(`(cas.seccion_id = $${params.length} OR i.seccion_id = $${params.length})`);
        }
        if (estado) {
            params.push(estado);
            conds.push(`i.estado = $${params.length}`);
        }
        const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
        const result = await pool.query(`
      SELECT i.id, i.casilla_id, i.ruta_id, i.tipo, i.descripcion, i.estado, i.respuesta, i.evidencia,
             i.created_at, u.nombre as creado_por_nombre, ur.nombre as resuelto_por_nombre,
             cas.nombre as casilla_nombre, COALESCE(cas.seccion_id, i.seccion_id) as seccion_id
      FROM incidencias i
      LEFT JOIN casillas cas ON cas.id = i.casilla_id
      LEFT JOIN usuarios u ON u.id = i.creado_por
      LEFT JOIN usuarios ur ON ur.id = i.resuelto_por
      ${where} ORDER BY i.created_at DESC LIMIT 300`, params);
        res.json(result.rows);
    }
    catch (e) {
        console.error('GET /api/incidencias error:', e?.message || e);
        res.status(500).json({ error: 'Error al listar incidencias' });
    }
});
app.patch('/api/incidencias/:id', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (user.rol !== 'admin' && user.rol !== 'coordinador') {
            res.status(403).json({ error: 'Solo administradores y coordinadores' });
            return;
        }
        const { estado, respuesta } = req.body || {};
        const r = await pool.query(`UPDATE incidencias SET
         estado = COALESCE($2::varchar, estado),
         respuesta = COALESCE($3::text, respuesta),
         resuelto_por = CASE WHEN $2 = 'resuelta' THEN $4 ELSE resuelto_por END,
         resuelto_en = CASE WHEN $2 = 'resuelta' THEN NOW() ELSE resuelto_en END
       WHERE id = $1 RETURNING id`, [req.params.id, estado || null, respuesta ?? null, user.userId]);
        if (!r.rows.length) {
            res.status(404).json({ error: 'No encontrada' });
            return;
        }
        res.json({ ok: true });
    }
    catch (e) {
        console.error('PATCH /api/incidencias error:', e?.message || e);
        res.status(500).json({ error: 'Error al actualizar incidencia' });
    }
});
// PDF votantes por sección/casilla (admin y coordinador) para palomear en papel
app.get('/api/reportes/pdf-votantes', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        const { seccion_id, casilla_id } = req.query;
        let filter = '';
        const params = [];
        if (casilla_id) {
            params.push(casilla_id);
            filter = ` WHERE c.casilla_id = $${params.length}`;
        }
        else if (seccion_id) {
            params.push(seccion_id);
            filter = ` WHERE c.seccion_id = $${params.length}`;
        }
        const rows = (await pool.query(`SELECT c.nombre, c.telefono, c.seccion_id, c.casilla_id, c.vigencia_ine, cs.nombre as casilla_nombre,
              pp.nombre as partido_nombre, pp.abreviatura
       FROM ciudadanos_comprometidos c
       LEFT JOIN casillas cs ON cs.id = c.casilla_id
       LEFT JOIN partidos_politicos pp ON pp.id = c.intencion_voto_presidente
       ${filter} ORDER BY c.casilla_id, c.nombre`, params)).rows;
        const doc = new pdfkit_1.default({ margin: 36, size: 'LETTER' });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=votantes.pdf');
        doc.pipe(res);
        doc.fontSize(15).text('Listado de votantes esperados', { align: 'center' });
        doc.fontSize(9).text(new Date().toLocaleString('es-MX'), { align: 'center' });
        doc.moveDown(0.6);
        const y0 = doc.y;
        for (const r of rows) {
            if (doc.y > 720) {
                doc.addPage();
            }
            doc.fontSize(11);
            doc.text('☐ ', { continued: false, width: 0 });
            const nombre = r.nombre;
            const line = `${nombre} — Sec ${r.seccion_id}${r.casilla_nombre ? ' / ' + r.casilla_nombre : ''}`;
            const detalle = (r.abreviatura ? r.abreviatura : 'Sin partido') + (r.telefono ? ' — ' + r.telefono : '');
            doc.text('☐ ' + line, { width: 480 });
            doc.fontSize(8).fillColor('#777').text('   ' + detalle, { width: 480 }).fillColor('#000');
            doc.moveDown(0.15);
        }
        if (rows.length === 0)
            doc.text('Sin votantes registrados.');
        doc.end();
        try {
            const u = req.user;
            if (u?.nombre)
                await logAuditoria(u.userId, u.nombre, 'pdf_votantes', 'reportes', undefined, { seccion_id: seccion_id || null, casilla_id: casilla_id || null, total: rows.length });
        }
        catch (e) {
            console.warn('auditoria pdf:', e);
        }
        void y0;
    }
    catch (e) {
        console.error('PDF error:', e?.message || e);
        if (!res.headersSent)
            res.status(500).json({ error: 'Error al generar PDF' });
    }
});
// Plantillas de mensaje WhatsApp
app.get('/api/plantillas', authenticateToken, async (_req, res) => {
    const result = await pool.query('SELECT id, nombre, tipo, cuerpo, archivos, creado_en FROM plantillas_mensaje ORDER BY nombre');
    res.json(result.rows);
});
app.get('/api/plantillas-whatsapp', authenticateToken, async (_req, res) => {
    const result = await pool.query('SELECT id, nombre, cuerpo FROM plantillas_whatsapp ORDER BY nombre');
    res.json(result.rows);
});
app.post('/api/plantillas', authenticateToken, async (req, res) => {
    const { nombre, tipo, cuerpo, archivos } = req.body;
    const result = await pool.query('INSERT INTO plantillas_mensaje (nombre, tipo, cuerpo, archivos) VALUES ($1,$2,$3,$4) RETURNING id', [nombre, tipo, cuerpo || '', JSON.stringify(archivos || [])]);
    res.status(201).json({ id: result.rows[0].id, message: 'Plantilla guardada' });
});
app.put('/api/plantillas/:id', authenticateToken, async (req, res) => {
    const { nombre, tipo, cuerpo, archivos } = req.body;
    await pool.query('UPDATE plantillas_mensaje SET nombre=$1, tipo=$2, cuerpo=$3, archivos=$4 WHERE id=$5', [nombre, tipo, cuerpo || '', JSON.stringify(archivos || []), req.params.id]);
    res.json({ message: 'Plantilla actualizada' });
});
app.delete('/api/plantillas/:id', authenticateToken, async (req, res) => {
    await pool.query('DELETE FROM plantillas_mensaje WHERE id=$1', [req.params.id]);
    res.json({ message: 'Plantilla eliminada' });
});
// Filtros para campañas
app.get('/api/filtros-campana', authenticateToken, async (_req, res) => {
    try {
        const result = await pool.query('SELECT * FROM filtros_campana WHERE activo=true ORDER BY orden, nombre');
        res.json(result.rows);
    }
    catch {
        res.status(500).json({ error: 'Error al listar filtros' });
    }
});
app.post('/api/filtros-campana', authenticateToken, async (req, res) => {
    try {
        const { nombre, campo_bd, tipo_input, operador_sql, opciones, orden } = req.body;
        if (!nombre || !campo_bd || !tipo_input || !operador_sql) {
            res.status(400).json({ error: 'Campos requeridos' });
            return;
        }
        const id = crypto_1.default.randomUUID();
        await pool.query('INSERT INTO filtros_campana (id, nombre, campo_bd, tipo_input, operador_sql, opciones, orden) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, nombre, campo_bd, tipo_input, operador_sql, opciones ? JSON.stringify(opciones) : null, orden || 0]);
        res.status(201).json({ id });
    }
    catch {
        res.status(500).json({ error: 'Error al crear filtro' });
    }
});
app.put('/api/filtros-campana/:id', authenticateToken, async (req, res) => {
    try {
        const { nombre, campo_bd, tipo_input, operador_sql, opciones, activo, orden } = req.body;
        await pool.query('UPDATE filtros_campana SET nombre=$1, campo_bd=$2, tipo_input=$3, operador_sql=$4, opciones=$5, activo=$6, orden=$7 WHERE id=$8', [nombre, campo_bd, tipo_input, operador_sql, opciones ? JSON.stringify(opciones) : null, activo !== false, orden || 0, req.params.id]);
        res.json({ message: 'Filtro actualizado' });
    }
    catch {
        res.status(500).json({ error: 'Error al actualizar filtro' });
    }
});
app.delete('/api/filtros-campana/:id', authenticateToken, async (req, res) => {
    try {
        await pool.query('DELETE FROM filtros_campana WHERE id=$1', [req.params.id]);
        res.json({ message: 'Filtro eliminado' });
    }
    catch {
        res.status(500).json({ error: 'Error al eliminar filtro' });
    }
});
// Campañas
async function construirFiltrosCampana(filtros) {
    const defs = (await pool.query('SELECT * FROM filtros_campana')).rows;
    const defMap = {};
    for (const fd of defs)
        defMap[fd.id] = fd;
    const byCol = {};
    for (const f of (filtros || [])) {
        const def = defMap[f.campo];
        if (!def)
            continue;
        const col = def.campo_bd;
        const op = def.operador_sql;
        let valor = f.valor;
        if (def.tipo_input === 'boolean' && op === '=') {
            if (valor === 'si' || valor === 'true')
                valor = true;
            else if (valor === 'no' || valor === 'false')
                valor = false;
        }
        if (!byCol[col])
            byCol[col] = { col, items: [] };
        byCol[col].items.push({ op, valor });
    }
    const conditions = [];
    const params = [];
    let idx = 1;
    for (const key of Object.keys(byCol)) {
        const { col, items } = byCol[key];
        const sub = [];
        for (const it of items) {
            const { op, valor } = it;
            const arr = Array.isArray(valor) ? valor : (op === 'IN' ? [valor] : null);
            if (arr) {
                const clean = arr.filter((v) => v !== '' && v != null);
                if (!clean.length)
                    continue;
                sub.push(`ciudadanos.${col} = ANY($${idx++})`);
                params.push(clean);
                continue;
            }
            if (op === 'LIKE') {
                sub.push(`ciudadanos.${col} ILIKE $${idx++}`);
                params.push(`%${valor}%`);
            }
            else if (op === 'BETWEEN') {
                const parts = String(valor || '').split('-');
                if (parts.length === 2) {
                    sub.push(`ciudadanos.${col} BETWEEN $${idx++} AND $${idx++}`);
                    params.push(parseInt(parts[0]), parseInt(parts[1]));
                }
            }
            else if (op === 'IS_NULL') {
                sub.push(valor === 'si' ? `ciudadanos.${col} IS NULL` : `ciudadanos.${col} IS NOT NULL`);
            }
            else if (op === '>=') {
                sub.push(`ciudadanos.${col} >= $${idx++}`);
                params.push(valor);
            }
            else if (op === '<=') {
                sub.push(`ciudadanos.${col} <= $${idx++}`);
                params.push(valor);
            }
            else {
                sub.push(`ciudadanos.${col} ${op} $${idx++}`);
                params.push(valor);
            }
        }
        if (sub.length)
            conditions.push('(' + sub.join(' OR ') + ')');
    }
    return { where: conditions.length ? 'WHERE ' + conditions.join(' AND ') : '', params };
}
app.get('/api/campanas', authenticateToken, async (_req, res) => {
    const result = await pool.query(`
    SELECT c.*, p.nombre as plantilla_nombre
    FROM campanas c LEFT JOIN plantillas_mensaje p ON p.id = c.plantilla_id
    ORDER BY c.creado_en DESC
  `);
    res.json(result.rows);
});
app.post('/api/campanas', authenticateToken, async (req, res) => {
    const { nombre, plantilla_id, filtros, scheduled_at, tipo, encuesta_id } = req.body;
    let total = 0;
    if ((tipo || 'whatsapp') === 'whatsapp') {
        try {
            const { where, params } = await construirFiltrosCampana(filtros || []);
            const countResult = await pool.query(`SELECT COUNT(*) FROM ciudadanos ${where}`, params);
            total = parseInt(countResult.rows[0].count);
        }
        catch (e) {
            console.warn('total campaña:', e);
        }
    }
    const result = await pool.query('INSERT INTO campanas (nombre, plantilla_id, filtros, scheduled_at, status, total_ciudadanos, tipo, encuesta_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [nombre, plantilla_id || null, JSON.stringify(filtros || []), scheduled_at || null, 'pending', total, tipo || 'whatsapp', encuesta_id || null]);
    res.status(201).json({ id: result.rows[0].id, message: 'Campaña guardada' });
});
app.put('/api/campanas/:id', authenticateToken, async (req, res) => {
    try {
        const { nombre, plantilla_id, filtros, scheduled_at, status, encuesta_lanzada, tipo, encuesta_id } = req.body;
        const user = req.user;
        if (req.body.encuesta_barrido !== undefined && !esAdminOCoordinador(user)) {
            res.status(403).json({ error: 'Solo coordinadores y administradores' });
            return;
        }
        const actual = (await pool.query('SELECT * FROM campanas WHERE id=$1', [req.params.id])).rows[0];
        if (!actual) {
            res.status(404).json({ error: 'Campaña no encontrada' });
            return;
        }
        const nombreFinal = nombre !== undefined ? nombre : (actual?.nombre ?? null);
        const plantillaFinal = plantilla_id !== undefined && plantilla_id ? plantilla_id : (actual?.plantilla_id ?? null);
        const filtrosFinal = filtros !== undefined ? filtros : (actual?.filtros ?? []);
        const fechaFinal = scheduled_at !== undefined ? scheduled_at : (actual?.scheduled_at ?? null);
        const statusFinal = status !== undefined ? status : (actual?.status ?? 'pending');
        const tipoFinal = tipo !== undefined ? tipo : (actual?.tipo || 'whatsapp');
        const encuestaFinal = encuesta_id ? encuesta_id : (actual?.encuesta_id || null);
        let totalFinal = actual?.total_ciudadanos ?? 0;
        if (tipoFinal === 'whatsapp') {
            try {
                const { where, params } = await construirFiltrosCampana(filtrosFinal || []);
                const countResult = await pool.query(`SELECT COUNT(*) FROM ciudadanos ${where}`, params);
                totalFinal = parseInt(countResult.rows[0].count);
            }
            catch (e) {
                console.warn('total campaña:', e);
            }
        }
        else
            totalFinal = 0;
        await pool.query('UPDATE campanas SET nombre=$1, plantilla_id=$2, filtros=$3, scheduled_at=$4, status=$5, encuesta_lanzada=$6, tipo=$7, encuesta_id=$8, total_ciudadanos=$9 WHERE id=$10', [nombreFinal, plantillaFinal, JSON.stringify(filtrosFinal || []), fechaFinal, statusFinal, !!encuesta_lanzada, tipoFinal, encuestaFinal, totalFinal, req.params.id]);
        if (req.body.encuesta_barrido !== undefined) {
            // Una sola encuesta de barrido: desmarca las demás
            await pool.query("UPDATE campanas SET encuesta_barrido = (id = $1) WHERE id = $1 OR encuesta_barrido = TRUE", [req.params.id]);
            const u = user;
            if (u?.nombre)
                await logAuditoria(u.userId, u.nombre, 'encuesta_barrido', 'campanas', req.params.id, { encuesta_barrido: !!req.body.encuesta_barrido });
        }
        res.json({ message: 'Campaña actualizada' });
    }
    catch (e) {
        console.error('PUT campana:', e);
        res.status(500).json({ error: 'Error al actualizar campaña' });
    }
});
app.delete('/api/campanas/:id', authenticateToken, async (req, res) => {
    await pool.query('DELETE FROM campanas WHERE id=$1', [req.params.id]);
    res.json({ message: 'Campaña eliminada' });
});
app.post('/api/campanas/preview', authenticateToken, async (req, res) => {
    try {
        const { filtros } = req.body;
        const { where, params } = await construirFiltrosCampana(filtros || []);
        const countResult = await pool.query(`SELECT COUNT(*) FROM ciudadanos ${where}`, params);
        const total = parseInt(countResult.rows[0].count);
        const dataResult = await pool.query(`SELECT ciudadanos.id, ciudadanos.nombre, ciudadanos.seccion_id, ciudadanos.telefono FROM ciudadanos ${where} ORDER BY ciudadanos.nombre LIMIT 500`, params);
        res.json({ total, ciudadanos: dataResult.rows });
    }
    catch (error) {
        console.error('Preview error:', error);
        res.status(500).json({ error: 'Error al previsualizar' });
    }
});
// Detectar sección por coordenadas (PostGIS)
app.get('/api/detectar-seccion', authenticateToken, async (req, res) => {
    try {
        const lat = parseFloat(req.query.lat);
        const lng = parseFloat(req.query.lng);
        if (isNaN(lat) || isNaN(lng)) {
            res.status(400).json({ error: 'lat y lng requeridos' });
            return;
        }
        // 1) Nearest within 10m buffer (more tolerant of imprecise boundaries)
        let result = await pool.query(`SELECT s.seccion, se.municipio_id
       FROM seccion_geo s
       JOIN secciones_electorales se ON se.id = s.seccion
       WHERE ST_DWithin(s.geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 10)
       ORDER BY ST_Distance(s.geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)
       LIMIT 1`, [lng, lat]);
        if (!result.rows.length) {
            // 2) Exact match (fallback for points deep inside a polygon)
            result = await pool.query(`SELECT s.seccion, se.municipio_id
         FROM seccion_geo s
         JOIN secciones_electorales se ON se.id = s.seccion
         WHERE ST_Contains(s.geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))
         LIMIT 1`, [lng, lat]);
        }
        if (!result.rows.length) {
            res.json({ seccion: null });
            return;
        }
        res.json({ seccion: parseInt(result.rows[0].seccion), municipio_id: result.rows[0].municipio_id });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/secciones/:municipioId/geometrias', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const muniId = parseInt(req.params.municipioId);
        // INE stores 2-digit municipio code; our DB uses 5-digit (11 + INE code)
        const ineMuni = muniId % 100;
        const params = [ineMuni];
        let extra = '';
        if (user?.rol === 'enlace' && req.query.todas !== '1') {
            const secs = await getUserSecciones(user.userId);
            if (!secs.length) {
                res.json({ type: 'FeatureCollection', features: [] });
                return;
            }
            params.push(secs);
            extra = ` AND s.seccion = ANY($${params.length})`;
        }
        const result = await pool.query(`SELECT s.seccion, ST_AsGeoJSON(s.geom)::jsonb as geometry
       FROM seccion_geo s
       WHERE s.municipio = $1${extra}`, params);
        if (!result.rows.length) {
            res.json({ type: 'FeatureCollection', features: [] });
            return;
        }
        const features = result.rows.map((r) => ({
            type: 'Feature',
            properties: { seccion: Math.round(r.seccion) },
            geometry: r.geometry
        }));
        res.json({ type: 'FeatureCollection', features });
    }
    catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error al obtener geometrias' });
    }
});
app.get('/api/geocercas/:eventoId/secciones-alcanzadas', async (req, res) => {
    try {
        const { eventoId } = req.params;
        const evtResult = await pool.query(`SELECT ST_X(ubicacion::geometry) as lng, ST_Y(ubicacion::geometry) as lat, radio_geocerca FROM eventos WHERE id = $1`, [eventoId]);
        if (!evtResult.rows.length) {
            res.json({ secciones: [] });
            return;
        }
        const evt = evtResult.rows[0];
        const result = await pool.query(`SELECT DISTINCT s.seccion
       FROM seccion_geo s
       WHERE ST_DWithin(s.geom::geography, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)`, [evt.lng, evt.lat, evt.radio_geocerca]);
        res.json({ secciones: result.rows.map((r) => Math.round(r.seccion)) });
    }
    catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Error al obtener secciones alcanzadas' });
    }
});
// Ubicación de enlaces
app.post('/api/ubicacion', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { lat, lng, precision } = req.body;
        if (lat == null || lng == null) {
            res.status(400).json({ error: 'lat y lng requeridos' });
            return;
        }
        await pool.query('INSERT INTO ubicaciones_enlace (user_id, lat, lng, precision) VALUES ($1,$2,$3,$4)', [user.userId, lat, lng, precision || 0]);
        res.json({ message: 'Ubicación guardada' });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/ubicaciones', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (user.rol !== 'admin' && user.rol !== 'coordinador') {
            res.status(403).json({ error: 'No autorizado' });
            return;
        }
        // Clean locations older than 24h
        await pool.query("DELETE FROM ubicaciones_enlace WHERE creado_en < NOW() - INTERVAL '24 hours'");
        // Get latest location per user with enlace role
        const result = await pool.query(`
      SELECT DISTINCT ON (u.id) u.id as user_id, u.nombre, u.telefono, ub.lat, ub.lng, ub.precision, ub.creado_en
      FROM usuarios u
      JOIN ubicaciones_enlace ub ON ub.user_id = u.id
      WHERE u.rol = 'enlace'
      ORDER BY u.id, ub.creado_en DESC
    `);
        res.json(result.rows);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Push subscriptions
app.post('/api/push/subscribe', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { endpoint, keys } = req.body;
        if (!endpoint || !keys?.auth || !keys?.p256dh) {
            res.status(400).json({ error: 'endpoint, keys.auth y keys.p256dh requeridos' });
            return;
        }
        await pool.query(`INSERT INTO push_subscriptions (user_id, endpoint, keys_auth, keys_p256dh, user_agent) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, endpoint) DO UPDATE SET keys_auth=EXCLUDED.keys_auth, keys_p256dh=EXCLUDED.keys_p256dh, user_agent=EXCLUDED.user_agent, creado_en=NOW()`, [user.userId, endpoint, keys.auth, keys.p256dh, req.headers['user-agent'] || '']);
        res.json({ message: 'Suscripción guardada' });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.delete('/api/push/unsubscribe', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { endpoint } = req.body;
        await pool.query('DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2', [user.userId, endpoint]);
        res.json({ message: 'Suscripción eliminada' });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Internal: send push to a user (can be called from other parts of the app)
async function sendPushToUser(userId, title, body, url = '/') {
    if (!vapidPublicKey || !vapidPrivateKey)
        return;
    try {
        const subs = await pool.query('SELECT endpoint, keys_auth, keys_p256dh FROM push_subscriptions WHERE user_id=$1', [userId]);
        for (const row of subs.rows) {
            try {
                await web_push_1.default.sendNotification({
                    endpoint: row.endpoint,
                    keys: { auth: row.keys_auth, p256dh: row.keys_p256dh }
                }, JSON.stringify({ title, body, url }), { TTL: 86400 });
            }
            catch (err) {
                if (err.statusCode === 410 || err.statusCode === 404) {
                    pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [row.endpoint]).catch(() => { });
                }
            }
        }
    }
    catch (e) {
        console.warn('sendPushToUser error:', e);
    }
}
async function sendPushToRole(rol, title, body, url = '/') {
    try {
        const users = await pool.query('SELECT id FROM usuarios WHERE rol=$1', [rol]);
        for (const u of users.rows) {
            await sendPushToUser(u.id, title, body, url);
        }
    }
    catch (e) {
        console.warn('sendPushToRole error:', e);
    }
}
// Endpoint for frontend to trigger push notifications
app.post('/api/push/send-to-role', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (user.rol !== 'admin' && user.rol !== 'coordinador' && user.rol !== 'enlace') {
            res.status(403).json({ error: 'No autorizado' });
            return;
        }
        const { rol, title, body, url } = req.body;
        await sendPushToRole(rol, title, body, url || '/');
        res.json({ message: 'Notificación enviada' });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Check for upcoming events every 5 minutes
setInterval(async () => {
    try {
        const events = await pool.query(`SELECT id, nombre FROM eventos
       WHERE fecha_inicio BETWEEN NOW() AND NOW() + INTERVAL '24 hours'
       AND notificado_proximo = FALSE`);
        for (const ev of events.rows) {
            await sendPushToRole('admin', 'Evento próximo', `"${ev.nombre}" inicia en menos de 24 horas`, '/eventos');
            await sendPushToRole('coordinador', 'Evento próximo', `"${ev.nombre}" inicia en menos de 24 horas`, '/eventos');
            await pool.query('UPDATE eventos SET notificado_proximo = TRUE WHERE id = $1', [ev.id]);
        }
    }
    catch (e) {
        console.error('Worker notificado_proximo error:', e);
    }
}, 300000);
// Alertas de votación: 80%, 100% de meta y secciones estancadas (una vez por día por sección/tipo)
async function chequearAlertasVotacion() {
    try {
        const st = await votacionActiva();
        if (!st.activa)
            return;
        const info = await pool.query(`
      SELECT s.seccion_id AS id, sum(s.meta_votos) AS meta,
             count(v.id)::int AS votos, max(v.created_at) AS ultimo_voto
      FROM casillas s
      LEFT JOIN votos v ON v.casilla_id = s.id
      GROUP BY s.seccion_id`);
        const ahora = new Date();
        for (const r of info.rows) {
            const meta = Number(r.meta || 0);
            if (meta <= 0)
                continue;
            const pct = Math.round((Number(r.votos || 0) / meta) * 100);
            let tipo = null, mensaje = null;
            if (pct >= 100) {
                tipo = 'meta-100';
                mensaje = `La sección ${r.id} alcanzó el 100% de su meta (${r.votos}/${meta} votos). ¡Excelente! 📣`;
            }
            else if (pct >= 80) {
                tipo = 'meta-80';
                mensaje = `La sección ${r.id} va al ${pct}% de su meta (${r.votos}/${meta} votos). ¡Casi!`;
            }
            else if (r.votos > 0 && ahora.getHours() >= 12 && r.ultimo_voto && (ahora.getTime() - new Date(r.ultimo_voto).getTime()) > 2 * 3600 * 1000) {
                tipo = 'estancada';
                mensaje = `La sección ${r.id} lleva ${pct}% de su meta sin nuevos votos en 2 horas (${r.votos}/${meta}). ¡Avisa a tu brigada!`;
            }
            if (!tipo || !mensaje)
                continue;
            const ins = await pool.query(`INSERT INTO alertas_votacion (seccion_id, tipo, mensaje) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`, [r.id, tipo, mensaje]);
            if (ins.rows.length)
                await sendPushToRole('admin', '⚠️ Alerta de votación', mensaje, '/reportes');
        }
    }
    catch (e) {
        console.warn('chequearAlertasVotacion error:', e?.message || e);
    }
}
setInterval(chequearAlertasVotacion, 300000);
chequearAlertasVotacion();
// Process pending WhatsApp alerts every 30 seconds
setInterval(async () => {
    try {
        const alerts = await pool.query(`SELECT a.id, a.ciudadano_id, a.telefono_ciudadano, a.evento_id,
              e.plantilla_id, p.cuerpo as plantilla_cuerpo, p.nombre as plantilla_nombre,
              c.nombre as ciudadano_nombre, e.nombre as evento_nombre
       FROM alertas_whatsapp a
       JOIN eventos e ON e.id = a.evento_id
       LEFT JOIN plantillas_whatsapp p ON p.id = e.plantilla_id
       LEFT JOIN ciudadanos c ON c.id = a.ciudadano_id
       WHERE a.enviado = FALSE AND a.retry_count < a.max_retries
       ORDER BY a.timestamp_deteccion ASC
       LIMIT 20`);
        for (const al of alerts.rows) {
            try {
                if (!al.telefono_ciudadano) {
                    await pool.query('UPDATE alertas_whatsapp SET enviado = TRUE, mensaje_enviado = $1 WHERE id = $2', ['Sin telefono', al.id]);
                    continue;
                }
                if (!al.plantilla_cuerpo) {
                    await pool.query('UPDATE alertas_whatsapp SET enviado = TRUE, mensaje_enviado = $1 WHERE id = $2', ['Evento sin plantilla asignada', al.id]);
                    continue;
                }
                const mensaje = al.plantilla_cuerpo
                    .replace(/\{nombre\}/g, al.ciudadano_nombre || 'Ciudadano')
                    .replace(/\{evento\}/g, al.evento_nombre || '');
                const cfgRows = await pool.query("SELECT clave, valor FROM configuracion WHERE clave IN ('twilio_sid','twilio_token','twilio_whatsapp')");
                const cfgMap = {};
                cfgRows.rows.forEach((r) => cfgMap[r.clave] = r.valor);
                const twilioSid = cfgMap['twilio_sid'];
                const twilioToken = cfgMap['twilio_token'];
                const twilioWhatsApp = cfgMap['twilio_whatsapp'];
                if (twilioSid && twilioToken && twilioWhatsApp) {
                    const num = al.telefono_ciudadano.startsWith('+') ? al.telefono_ciudadano : '+52' + al.telefono_ciudadano;
                    await axios_1.default.post(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, new URLSearchParams({ From: 'whatsapp:' + twilioWhatsApp, To: 'whatsapp:' + num, Body: mensaje }), { auth: { username: twilioSid, password: twilioToken }, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
                }
                await pool.query('UPDATE alertas_whatsapp SET enviado = TRUE, timestamp_envio = NOW(), mensaje_enviado = $1 WHERE id = $2', [mensaje, al.id]);
            }
            catch (e) {
                console.error('Error enviando alerta WhatsApp:', e);
                await pool.query('UPDATE alertas_whatsapp SET retry_count = retry_count + 1 WHERE id = $1', [al.id]);
            }
        }
    }
    catch (e) {
        console.error('Worker alertas_whatsapp error:', e);
    }
}, 30000);
// Process scheduled event alerts (1 week before, 1 day before, 3 hours before, at start)
const OFFSET_MAP = {
    '1semana': '-7 days',
    '1dia': '-1 day',
    '3horas': '-3 hours',
    'inicio': '0'
};
setInterval(async () => {
    try {
        const events = await pool.query(`      SELECT id, nombre, fecha_inicio, plantilla_id, alertar_config, alertar_enviados, seccion_id, alertar_solo_simpatizantes,
             ST_X(ubicacion::geometry) as lng, ST_Y(ubicacion::geometry) as lat, radio_geocerca
       FROM eventos
       WHERE plantilla_id IS NOT NULL
         AND alertar_config != '[]'::jsonb
         AND jsonb_array_length(alertar_config) > 0`);
        for (const ev of events.rows) {
            const cfg = ev.alertar_config || [];
            const sent = ev.alertar_enviados || [];
            const pending = cfg.filter((c) => !sent.includes(c));
            if (!pending.length)
                continue;
            if (!ev.fecha_inicio)
                continue;
            const eventTime = new Date(ev.fecha_inicio).getTime();
            const now = Date.now();
            for (const tipo of pending) {
                const offsetStr = OFFSET_MAP[tipo];
                if (!offsetStr)
                    continue;
                const offsetMs = parsePostgresInterval(offsetStr);
                const targetTime = eventTime + offsetMs;
                if (now < targetTime)
                    continue;
                const plantillaRes = await pool.query('SELECT cuerpo, nombre FROM plantillas_whatsapp WHERE id=$1', [ev.plantilla_id]);
                const plantilla = plantillaRes.rows[0];
                if (!plantilla)
                    continue;
                let ciudadanos = [];
                if (ev.lat && ev.lng) {
                    ciudadanos = (await pool.query(`SELECT id, nombre, telefono FROM ciudadanos
             WHERE telefono IS NOT NULL AND telefono != ''
             AND ST_DWithin(ubicacion, ST_SetSRID(ST_MakePoint($1,$2),4326), $3)`, [ev.lng, ev.lat, ev.radio_geocerca || 500])).rows;
                }
                else if (ev.seccion_id) {
                    ciudadanos = (await pool.query(`SELECT id, nombre, telefono FROM ciudadanos WHERE seccion_id=$1 AND telefono IS NOT NULL AND telefono != ''`, [ev.seccion_id])).rows;
                }
                if (!ciudadanos.length) {
                    await pool.query('UPDATE eventos SET alertar_enviados = alertar_enviados || $1::jsonb WHERE id=$2', [JSON.stringify([tipo]), ev.id]);
                    continue;
                }
                for (const c of ciudadanos) {
                    const mensaje = plantilla.cuerpo
                        .replace(/\{nombre\}/g, c.nombre || 'Ciudadano')
                        .replace(/\{evento\}/g, ev.nombre || '');
                    await pool.query(`INSERT INTO alertas_whatsapp (ciudadano_id, evento_id, telefono_ciudadano, mensaje_enviado, enviado, timestamp_envio)
             VALUES ($1,$2,$3,$4,TRUE,NOW())`, [c.id, ev.id, c.telefono, mensaje]);
                    const cfgRows = await pool.query("SELECT clave, valor FROM configuracion WHERE clave IN ('twilio_sid','twilio_token','twilio_whatsapp')");
                    const cfgMap = {};
                    cfgRows.rows.forEach((r) => cfgMap[r.clave] = r.valor);
                    const twilioSid = cfgMap['twilio_sid'], twilioToken = cfgMap['twilio_token'], twilioWhatsApp = cfgMap['twilio_whatsapp'];
                    if (twilioSid && twilioToken && twilioWhatsApp) {
                        const num = c.telefono.startsWith('+') ? c.telefono : '+52' + c.telefono;
                        try {
                            await axios_1.default.post(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, new URLSearchParams({ From: 'whatsapp:' + twilioWhatsApp, To: 'whatsapp:' + num, Body: mensaje }), { auth: { username: twilioSid, password: twilioToken }, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
                        }
                        catch (e) {
                            console.error('Error Twilio en worker programado:', e);
                        }
                    }
                }
                await pool.query('UPDATE eventos SET alertar_enviados = alertar_enviados || $1::jsonb WHERE id=$2', [JSON.stringify([tipo]), ev.id]);
            }
        }
    }
    catch (e) {
        console.error('Worker alertas programadas error:', e);
    }
}, 60000);
function parsePostgresInterval(str) {
    const parts = str.split(' ');
    let ms = 0;
    for (let i = 0; i < parts.length; i += 2) {
        const val = parseInt(parts[i]);
        const unit = parts[i + 1];
        if (unit === 'days' || unit === 'day')
            ms += val * 86400000;
        else if (unit === 'hours' || unit === 'hour')
            ms += val * 3600000;
        else if (unit === 'minutes' || unit === 'minute')
            ms += val * 60000;
    }
    return ms;
}
const port = parseInt(PORT);
server.listen(port, () => console.log(`Server running on port ${port}`));
// ============ NUEVAS FEATURES: visitas, avance de barrido, encuestas, etc. ============
// Historial de visitas de un ciudadano
app.get('/api/ciudadanos/:id/visitas', authenticateToken, async (req, res) => {
    try {
        const rows = await pool.query(`SELECT v.id, v.tipo, v.lat, v.lng, v.notas, v.created_at,
              u.nombre as usuario_nombre
       FROM visitas v
       LEFT JOIN usuarios u ON u.id = v.usuario_id
       WHERE v.ciudadano_id = $1
       ORDER BY v.created_at DESC LIMIT 100`, [req.params.id]);
        // Resultado legible para visitas de ruta (abrió / no abrió) y próxima re-visita sugerida (+60 días)
        const out = rows.rows.map((v) => {
            let resultado = null;
            if (v.tipo === 'ruta') {
                const m = String(v.notas || '').match(/abrio:(si|no)/);
                if (m)
                    resultado = m[1] === 'no' ? 'no_abrio' : 'abrio';
            }
            return { ...v, resultado };
        });
        const ultimaRuta = out.find((v) => v.tipo === 'ruta');
        const proximaRevisita = ultimaRuta ? new Date(new Date(ultimaRuta.created_at).getTime() + 60 * 86400000).toISOString() : null;
        res.json({ visitas: out, proxima_revisita_sugerida: proximaRevisita, dias_revisita: 60 });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Reporte de re-visitas: resumen de cobertura y ciudadanos sin visita reciente
app.get('/api/reportes/revisitas', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const condsSec = [];
        const paramsSec = [];
        if (user.rol === 'enlace') {
            const secs = await getUserSecciones(user.userId);
            if (!secs.length) {
                res.json({ resumen: {}, lista: [] });
                return;
            }
            paramsSec.push(secs);
            condsSec.push(`c.seccion_id = ANY($${paramsSec.length})`);
        }
        if (req.query.municipio_id) {
            paramsSec.push(req.query.municipio_id);
            condsSec.push(`c.seccion_id IN (SELECT id FROM secciones_electorales WHERE municipio_id = $${paramsSec.length})`);
        }
        const whereC = condsSec.length ? 'AND ' + condsSec.join(' AND ') : '';
        const resumenQ = await pool.query(`WITH ult AS (
         SELECT DISTINCT ON (v.ciudadano_id) v.ciudadano_id, v.created_at, v.notas
         FROM visitas v WHERE v.tipo='ruta' ORDER BY v.ciudadano_id, v.created_at DESC
       )
       SELECT
         COUNT(c.id)::int AS total,
         COUNT(u.ciudadano_id)::int AS visitados_ruta,
         COUNT(*) FILTER (WHERE u.notas LIKE '%|abrio:no')::int AS ultima_no_abrio,
         COUNT(*) FILTER (WHERE u.created_at < NOW() - ($${paramsSec.length + 1} * INTERVAL '1 day') OR u.ciudadano_id IS NULL)::int AS sin_visita_reciente,
         (SELECT COUNT(DISTINCT er.ciudadano_id)::int FROM encuesta_respuestas er) AS encuestados
       FROM ciudadanos c
       LEFT JOIN ult u ON u.ciudadano_id = c.id
       WHERE c.no_abrio IS NOT TRUE ${whereC}`, [...paramsSec, parseInt(String(req.query.dias || '60')) || 60]);
        const listaQ = await pool.query(`WITH ult AS (
         SELECT DISTINCT ON (v.ciudadano_id) v.ciudadano_id, v.created_at, v.notas
         FROM visitas v WHERE v.tipo='ruta' ORDER BY v.ciudadano_id, v.created_at DESC
       )
       SELECT c.id, c.nombre, c.telefono, c.calle, c.numero, c.colonia,
              s.id AS seccion_num, s.id AS seccion_id,
              u.created_at AS ultima_visita,
              CASE WHEN u.notas LIKE '%|abrio:no' THEN 'no_abrio' WHEN u.ciudadano_id IS NULL THEN 'nunca' ELSE 'abrio' END AS ultimo_resultado,
              EXTRACT(DAY FROM NOW() - u.created_at)::int AS dias_desde_visita
       FROM ciudadanos c
       LEFT JOIN ult u ON u.ciudadano_id = c.id
       LEFT JOIN secciones_electorales s ON s.id = c.seccion_id
       WHERE COALESCE(c.no_abrio,FALSE) = FALSE ${whereC}
         AND (u.ciudadano_id IS NULL OR u.created_at < NOW() - ($${paramsSec.length + 1} * INTERVAL '1 day'))
       ORDER BY u.created_at ASC NULLS FIRST
       LIMIT 500`, [...paramsSec, parseInt(String(req.query.dias || '60')) || 60]);
        res.json({ resumen: resumenQ.rows[0] || {}, lista: listaQ.rows, dias: parseInt(String(req.query.dias || '60')) || 60 });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Avance de barrido: total y visitados recientes por sección (filtrado por rol)
app.get('/api/geo/avance-barrido', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const qm = req.query.municipio_id;
        const conds = [];
        const params = [];
        if (user.rol === 'enlace') {
            const secs = await getUserSecciones(user.userId);
            if (!secs.length) {
                res.json([]);
                return;
            }
            params.push(secs);
            conds.push(`s.id = ANY($${params.length})`);
        }
        if (qm) {
            params.push(qm);
            conds.push(`s.municipio_id = $${params.length}`);
        }
        const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
        const rows = await pool.query(`WITH vis AS (SELECT DISTINCT ciudadano_id FROM visitas WHERE created_at >= NOW() - INTERVAL '24 hours')
       SELECT s.id as seccion_id, s.id as seccion_num, m.nombre as municipio, m.id as municipio_id,
              COUNT(c.id) as total_ciudadanos,
              COUNT(v.ciudadano_id) as visitados_24h,
              AVG(ST_Y(c.ubicacion::geometry)) as centro_lat,
              AVG(ST_X(c.ubicacion::geometry)) as centro_lng
       FROM secciones_electorales s
       JOIN municipios m ON m.id = s.municipio_id
       LEFT JOIN ciudadanos c ON c.seccion_id = s.id
       LEFT JOIN vis v ON v.ciudadano_id = c.id
       ${where}
       GROUP BY s.id, m.nombre, m.id
       ORDER BY seccion_num`, params);
        res.json(rows.rows);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Encuestas: CRUD de preguntas por campaña
app.get('/api/encuestas/preguntas', authenticateToken, async (req, res) => {
    try {
        const campanaId = req.query.campana_id;
        const user = req.user;
        const incluirInactivas = req.query.todas === '1' && user?.rol === 'admin';
        const params = [];
        let where = incluirInactivas ? 'WHERE 1=1' : 'WHERE p.activa = TRUE';
        if (campanaId) {
            params.push(campanaId);
            where += ` AND p.campana_id = $${params.length}`;
        }
        else if (user?.rol !== 'admin') {
            where += ' AND (c.encuesta_lanzada = TRUE OR c.encuesta_barrido = TRUE)';
        }
        const rows = await pool.query(`SELECT p.id, p.campana_id, p.pregunta, p.tipo, p.opciones, p.obligatoria, p.orden, p.activa, c.nombre as campana_nombre, c.encuesta_lanzada, c.encuesta_barrido
       FROM encuesta_preguntas p JOIN campanas c ON c.id = p.campana_id
       ${where} ORDER BY p.orden ASC, p.created_at ASC`, params);
        res.json(rows.rows);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/encuestas/preguntas', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        const { campana_id, pregunta, tipo, opciones, obligatoria, orden } = req.body;
        if (!campana_id || !pregunta) {
            res.status(400).json({ error: 'campana_id y pregunta requeridos' });
            return;
        }
        const id = crypto_1.default.randomUUID();
        await pool.query(`INSERT INTO encuesta_preguntas (id, campana_id, pregunta, tipo, opciones, obligatoria, orden)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, campana_id, pregunta, tipo || 'texto', opciones ? JSON.stringify(opciones) : null, !!obligatoria, orden || 0]);
        const u = req.user;
        if (u?.nombre)
            await logAuditoria(u.userId, u.nombre, 'crear_pregunta_encuesta', 'encuesta_preguntas', id, { pregunta });
        res.status(201).json({ id });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.put('/api/encuestas/preguntas/:id', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        const { pregunta, tipo, opciones, obligatoria, orden, activa } = req.body;
        const parts = [];
        const params = [];
        const p = (v) => { params.push(v); return '$' + params.length; };
        if (pregunta != null) {
            parts.push('pregunta=' + p(pregunta));
        }
        if (tipo != null) {
            parts.push('tipo=' + p(tipo));
        }
        if (opciones != null) {
            parts.push('opciones=' + p(JSON.stringify(opciones)));
        }
        if (obligatoria != null) {
            parts.push('obligatoria=' + p(!!obligatoria));
        }
        if (orden != null) {
            parts.push('orden=' + p(orden));
        }
        if (activa != null) {
            parts.push('activa=' + p(!!activa));
        }
        if (!parts.length) {
            res.status(400).json({ error: 'Sin cambios' });
            return;
        }
        params.push(req.params.id);
        await pool.query('UPDATE encuesta_preguntas SET ' + parts.join(',') + ' WHERE id=$' + params.length, params);
        res.json({ message: 'Pregunta actualizada' });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.delete('/api/encuestas/preguntas/:id', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        await pool.query('DELETE FROM encuesta_preguntas WHERE id=$1', [req.params.id]);
        res.json({ message: 'Pregunta eliminada' });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Registrar respuestas de encuesta para un ciudadano
app.post('/api/encuestas/respuestas', authenticateToken, async (req, res) => {
    try {
        const { ciudadano_id, campana_id, respuestas } = req.body;
        if (!ciudadano_id || !campana_id || !Array.isArray(respuestas)) {
            res.status(400).json({ error: 'ciudadano_id, campana_id y respuestas[] requeridos' });
            return;
        }
        const user = req.user;
        for (const r of respuestas) {
            if (!r.pregunta_id)
                continue;
            await pool.query(`INSERT INTO encuesta_respuestas (id, ciudadano_id, campana_id, pregunta_id, valor, usuario_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (ciudadano_id, pregunta_id) DO UPDATE SET valor = EXCLUDED.valor, usuario_id = EXCLUDED.usuario_id`, [crypto_1.default.randomUUID(), ciudadano_id, campana_id, r.pregunta_id, r.valor || '', user?.userId || null]);
        }
        try {
            await pool.query('INSERT INTO visitas (id, ciudadano_id, usuario_id, tipo) VALUES ($1,$2,$3,$4)', [crypto_1.default.randomUUID(), ciudadano_id, user?.userId || null, 'encuesta']);
        }
        catch (e) {
            console.warn('visita encuesta:', e);
        }
        res.json({ message: 'Encuesta registrada' });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Respuestas existentes de un ciudadano (para prellenar)
app.get('/api/encuestas/respuestas', authenticateToken, async (req, res) => {
    try {
        const { ciudadano_id, campana_id } = req.query;
        const params = [];
        const conds = [];
        if (ciudadano_id) {
            params.push(ciudadano_id);
            conds.push(`r.ciudadano_id = $${params.length}`);
        }
        if (campana_id) {
            params.push(campana_id);
            conds.push(`r.campana_id = $${params.length}`);
        }
        const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
        const rows = await pool.query(`SELECT r.id, r.ciudadano_id, r.campana_id, r.pregunta_id, r.valor, r.created_at, p.pregunta
       FROM encuesta_respuestas r JOIN encuesta_preguntas p ON p.id = r.pregunta_id
       ${where} ORDER BY r.created_at DESC`, params);
        res.json(rows.rows);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Reportes de encuesta: agregaciones por pregunta y opción
app.get('/api/encuestas/reportes/:campanaId', authenticateToken, async (req, res) => {
    try {
        const campanaId = req.params.campanaId;
        const camp = (await pool.query('SELECT id, nombre FROM campanas WHERE id=$1', [campanaId])).rows[0];
        if (!camp) {
            res.status(404).json({ error: 'Campaña no encontrada' });
            return;
        }
        const preguntas = (await pool.query(`SELECT id, pregunta, tipo, opciones FROM encuesta_preguntas WHERE campana_id=$1 ORDER BY orden ASC, created_at ASC`, [campanaId])).rows;
        const respuestas = (await pool.query(`SELECT r.pregunta_id, r.valor FROM encuesta_respuestas r WHERE r.campana_id=$1`, [campanaId])).rows;
        const porPregunta = [];
        for (const p of preguntas) {
            const conRespuesta = respuestas.filter(r => r.pregunta_id === p.id);
            const conteo = {};
            conRespuesta.forEach(r => { conteo[r.valor || '(sin respuesta)'] = (conteo[r.valor || '(sin respuesta)'] || 0) + 1; });
            const opciones = p.tipo === 'opciones' && Array.isArray(p.opciones) ? p.opciones : [];
            const opcionesBase = p.tipo === 'si_no' ? ['Si', 'No'] : opciones;
            const filas = opcionesBase.length
                ? opcionesBase.map((o) => ({ opcion: o, count: conteo[o] || 0, pct: conRespuesta.length ? Math.round(((conteo[o] || 0) / conRespuesta.length) * 100) : 0 }))
                : Object.entries(conteo).map(([opcion, count]) => ({ opcion, count, pct: conRespuesta.length ? Math.round((count / conRespuesta.length) * 100) : 0 }));
            porPregunta.push({
                pregunta_id: p.id,
                pregunta: p.pregunta,
                tipo: p.tipo,
                respondidas: conRespuesta.length,
                total_ciudadanos: respuestas.length ? null : 0,
                opciones: filas
            });
        }
        res.json({ campana: camp.nombre, total_respuestas: respuestas.length, preguntas: porPregunta });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// ===== Encuesta pública (sin login): formulario para el ciudadano =====
function crearTokenEncuesta(campanaId, ciudadanoId, demo) {
    const payload = Buffer.from(JSON.stringify({ c: campanaId, u: ciudadanoId || null, d: !!demo })).toString('base64url');
    const firma = crypto_1.default.createHmac('sha256', JWT_SECRET).update(payload).digest('base64url');
    return payload + '.' + firma;
}
function verificarTokenEncuesta(token) {
    try {
        const [payload, firma] = token.split('.');
        if (!payload || !firma)
            return null;
        const esperada = crypto_1.default.createHmac('sha256', JWT_SECRET).update(payload).digest('base64url');
        const a = Buffer.from(firma, 'base64url');
        const b = Buffer.from(esperada, 'base64url');
        if (a.length !== b.length || !crypto_1.default.timingSafeEqual(a, b))
            return null;
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (!data.c)
            return null;
        return { c: data.c, u: data.u || null, d: !!data.d };
    }
    catch {
        return null;
    }
}
async function getUrlPublica() {
    try {
        const r = await pool.query("SELECT valor FROM configuracion WHERE clave='url_publica'");
        return (r.rows[0]?.valor || 'https://www.prioridadterritorial.com').replace(/\/+$/, '');
    }
    catch {
        return 'https://www.prioridadterritorial.com';
    }
}
app.get('/api/publico/encuesta/:token', async (req, res) => {
    try {
        const data = verificarTokenEncuesta(req.params.token);
        if (!data) {
            res.status(400).json({ error: 'Enlace inválido' });
            return;
        }
        const camp = (await pool.query('SELECT id, nombre, tipo, encuesta_lanzada FROM campanas WHERE id=$1', [data.c])).rows[0];
        if (!camp || camp.tipo !== 'encuesta') {
            res.status(404).json({ error: 'Encuesta no disponible' });
            return;
        }
        if (!data.d && !camp.encuesta_lanzada) {
            res.status(400).json({ error: 'Encuesta no disponible en este momento' });
            return;
        }
        let ciudadano = null;
        if (data.u) {
            ciudadano = (await pool.query('SELECT id, nombre FROM ciudadanos WHERE id=$1', [data.u])).rows[0] || null;
        }
        const preguntas = (await pool.query(`SELECT id, pregunta, tipo, opciones, obligatoria FROM encuesta_preguntas WHERE campana_id=$1 AND activa=TRUE ORDER BY orden ASC, created_at ASC`, [data.c])).rows;
        if (!preguntas.length) {
            res.status(404).json({ error: 'Esta encuesta aún no tiene preguntas' });
            return;
        }
        res.json({ campana: camp.nombre, demo: !!data.d, ciudadano_nombre: ciudadano?.nombre || null, preguntas });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/publico/encuesta/:token', async (req, res) => {
    try {
        const data = verificarTokenEncuesta(req.params.token);
        if (!data) {
            res.status(400).json({ error: 'Enlace inválido' });
            return;
        }
        const { respuestas, saltar } = req.body;
        if (saltar === true) {
            if (data.d) {
                res.json({ message: 'Registrado (modo demo)' });
                return;
            }
            const camp = (await pool.query('SELECT id, nombre, tipo, encuesta_lanzada FROM campanas WHERE id=$1', [data.c])).rows[0];
            if (!camp || camp.tipo !== 'encuesta') {
                res.status(404).json({ error: 'Encuesta no disponible' });
                return;
            }
            if (!camp.encuesta_lanzada) {
                res.status(400).json({ error: 'Encuesta no disponible en este momento' });
                return;
            }
            if (!data.u) {
                res.status(400).json({ error: 'Enlace sin ciudadano' });
                return;
            }
            try {
                await pool.query('INSERT INTO visitas (id, ciudadano_id, usuario_id, tipo, notas) VALUES ($1,$2,NULL,$3,$4)', [crypto_1.default.randomUUID(), data.u, 'encuesta', 'rechazada: el ciudadano no quiso responder']);
            }
            catch (e) {
                console.warn('visita encuesta publica:', e);
            }
            res.json({ message: 'Entendido, gracias por tu tiempo' });
            return;
        }
        if (!Array.isArray(respuestas)) {
            res.status(400).json({ error: 'respuestas[] requerido' });
            return;
        }
        const camp = (await pool.query('SELECT id, nombre, tipo, encuesta_lanzada FROM campanas WHERE id=$1', [data.c])).rows[0];
        if (!camp || camp.tipo !== 'encuesta') {
            res.status(404).json({ error: 'Encuesta no disponible' });
            return;
        }
        if (data.d) {
            res.json({ message: 'Respuesta registrada (modo demo)' });
            return;
        }
        if (!camp.encuesta_lanzada) {
            res.status(400).json({ error: 'Encuesta no disponible en este momento' });
            return;
        }
        if (!data.u) {
            res.status(400).json({ error: 'Enlace sin ciudadano' });
            return;
        }
        for (const r of respuestas) {
            if (!r.pregunta_id)
                continue;
            await pool.query(`INSERT INTO encuesta_respuestas (id, ciudadano_id, campana_id, pregunta_id, valor, usuario_id)
         VALUES ($1,$2,$3,$4,$5,NULL)
         ON CONFLICT (ciudadano_id, pregunta_id) DO UPDATE SET valor = EXCLUDED.valor, usuario_id = NULL`, [crypto_1.default.randomUUID(), data.u, data.c, r.pregunta_id, r.valor || '']);
        }
        try {
            await pool.query('INSERT INTO visitas (id, ciudadano_id, usuario_id, tipo, notas) VALUES ($1,$2,NULL,$3,$4)', [crypto_1.default.randomUUID(), data.u, 'encuesta', 'auto' + new Date().toISOString()]);
        }
        catch (e) {
            console.warn('visita encuesta publica:', e);
        }
        res.json({ message: 'Respuesta registrada, gracias por participar' });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Genera el enlace público de prueba para una campaña encuesta (solo admin)
app.post('/api/campanas/:id/enlace-demo', authenticateToken, requireAdminOCoordinador, async (req, res) => {
    try {
        const camp = (await pool.query('SELECT id, nombre, tipo FROM campanas WHERE id=$1', [req.params.id])).rows[0];
        if (!camp || camp.tipo !== 'encuesta') {
            res.status(404).json({ error: 'Campaña no encontrada o no es de encuesta' });
            return;
        }
        const url = await getUrlPublica();
        const token = crearTokenEncuesta(camp.id, null, true);
        res.json({ url: `${url}/encuesta.html?t=${token}` });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Enlace público por ciudadano para una campaña encuesta (para el mensaje WhatsApp)
app.post('/api/campanas/:id/enlace-ciudadano', authenticateToken, async (req, res) => {
    try {
        const camp = (await pool.query('SELECT id, nombre, tipo, encuesta_lanzada FROM campanas WHERE id=$1', [req.params.id])).rows[0];
        if (!camp || camp.tipo !== 'encuesta') {
            res.status(404).json({ error: 'Campaña no encontrada o no es de encuesta' });
            return;
        }
        const { ciudadano_id } = req.body;
        if (!ciudadano_id) {
            res.status(400).json({ error: 'ciudadano_id requerido' });
            return;
        }
        const url = await getUrlPublica();
        const token = crearTokenEncuesta(camp.id, ciudadano_id, false);
        res.json({ url: `${url}/encuesta.html?t=${token}`, campana: camp.nombre });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Aviso de reconexión de brigadista (lo llama la app tras sincronizar cola pendiente)
app.post('/api/sync/reconexion', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const { pendientes } = req.body;
        if (user.rol === 'admin') {
            res.json({ message: 'ok' });
            return;
        }
        await sendPushToRole('admin', 'Brigadista reconectado', `${user.nombre || 'Un brigadista'} está en línea (${pendientes || 0} pendientes sincronizados)`, '/mapa');
        res.json({ message: 'Notificación enviada' });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Exportar ciudadanos a Excel (xlsx real, sin dependencias extra: generamos un XML de hoja de cálculo)
app.get('/api/exportar/excel', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        const tipo = String(req.query.tipo || 'ciudadanos');
        const XLSX = require('xlsx');
        const nombreExpr = (tbl) => `
      CASE WHEN ${tbl}.apellido_paterno IS NOT NULL OR ${tbl}.apellido_materno IS NOT NULL THEN ${tbl}.nombre
           WHEN array_length(p.t, 1) >= 3 THEN array_to_string(p.t[1:(array_length(p.t, 1) - 2)], ' ')
           WHEN array_length(p.t, 1) = 2 THEN p.t[1]
           ELSE ${tbl}.nombre END`;
        const apellidosExpr = (tbl) => `
      COALESCE(${tbl}.apellido_paterno, CASE WHEN array_length(p.t, 1) >= 3 THEN p.t[array_length(p.t, 1) - 1] WHEN array_length(p.t, 1) = 2 THEN p.t[2] END) as apellido_paterno,
      COALESCE(${tbl}.apellido_materno, CASE WHEN array_length(p.t, 1) >= 3 THEN p.t[array_length(p.t, 1)] END) as apellido_materno`;
        const joinPartes = (tbl, alias) => `
      JOIN (SELECT id, string_to_array(btrim(regexp_replace(${tbl}.nombre, '\\s+', ' ', 'g')), ' ') AS t FROM ${tbl}) p ON p.id = ${alias}.id`;
        const excelResponse = (sheetName, filename, header, rows) => {
            const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
            ws['!cols'] = header.map((h, i) => {
                const maxLen = rows.reduce((m, r) => Math.max(m, String(r[i] ?? '').length), h.length);
                return { wch: Math.min(Math.max(maxLen + 2, h.length + 2), 40) };
            });
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
            const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(buf);
        };
        if (tipo === 'respuestas') {
            const campanaId = String(req.query.campana_id || '');
            if (!campanaId) {
                res.status(400).json({ error: 'campana_id requerido' });
                return;
            }
            const preguntas = (await pool.query(`SELECT id, pregunta FROM encuesta_preguntas WHERE campana_id=$1 ORDER BY orden ASC, created_at ASC`, [campanaId])).rows;
            const data = (await pool.query(`SELECT c.id, ${nombreExpr('c')} as nombre, ${apellidosExpr('c')}, c.telefono, s.id as seccion_num, m.nombre as municipio, r.pregunta_id, r.valor
         FROM encuesta_respuestas r
         JOIN ciudadanos c ON c.id = r.ciudadano_id
         ${joinPartes('ciudadanos', 'c')}
         LEFT JOIN secciones_electorales s ON s.id = c.seccion_id
         LEFT JOIN municipios m ON m.id = s.municipio_id
         WHERE r.campana_id = $1
         ORDER BY c.nombre, r.created_at`, [campanaId])).rows;
            const porCiudadano = new Map();
            for (const r of data) {
                if (!porCiudadano.has(r.id))
                    porCiudadano.set(r.id, { r, vals: {} });
                porCiudadano.get(r.id).vals[r.pregunta_id] = r.valor;
            }
            const header = ['Nombre', 'Apellido paterno', 'Apellido materno', 'Telefono', 'Seccion', 'Municipio', ...preguntas.map((p) => String(p.pregunta || ''))];
            const body = Array.from(porCiudadano.values()).map(({ r, vals }) => {
                return [r.nombre, r.apellido_paterno, r.apellido_materno, r.telefono, r.seccion_num, r.municipio, ...preguntas.map((p) => vals[p.id] ?? '')];
            });
            excelResponse('Respuestas', 'respuestas-encuesta.xlsx', header, body);
            return;
        }
        if (tipo === 'encuesta' || tipo === 'general') {
            const campanaId = String(req.query.campana_id || '');
            const rowsCampanaQuery = campanaId
                ? `WHERE ce.campana_id = $1`
                : '';
            const rows = (await pool.query(`SELECT c.id, ${nombreExpr('c')} as nombre, ${apellidosExpr('c')}, c.telefono, c.no_abrio, c.edad, c.sexo, c.motivo_puerta,
                cd.nombre as discapacidad, co2.nombre as ocupacion,
                s.id as seccion_num, m.nombre as municipio,
                u.nombre as capturado_por, cam.nombre as encuesta_nombre, c.created_at, c.updated_at
         FROM ciudadanos c
         ${joinPartes('ciudadanos', 'c')}
         LEFT JOIN ciudadanos_encuestas ce ON ce.ciudadano_id = c.id
         LEFT JOIN campanas cam ON cam.id = ce.campana_id
         LEFT JOIN secciones_electorales s ON s.id = c.seccion_id
         LEFT JOIN municipios m ON m.id = s.municipio_id
         LEFT JOIN usuarios u ON u.id = c.created_by
         LEFT JOIN cat_discapacidades cd ON cd.id = c.discapacidad_id
         LEFT JOIN cat_ocupaciones co2 ON co2.id = c.ocupacion_id
         ${rowsCampanaQuery}
         ORDER BY c.created_at DESC`, campanaId ? [campanaId] : [])).rows;
            const header = ['Nombre', 'Apellido paterno', 'Apellido materno', 'Telefono', 'Abrio', 'Motivo puerta', 'Edad', 'Sexo', 'Discapacidad', 'Ocupación', 'Seccion', 'Municipio', 'Encuesta asignada', 'Capturado por', 'Capturado el', 'Actualizado el'];
            const motivoTxt = { no_abrio: 'No abrió', sin_info: 'No proporcionó info', con_prisa: 'Tenía prisa', otro: 'Otro' };
            const body = rows.map(r => {
                return [r.nombre, r.apellido_paterno, r.apellido_materno, r.telefono, r.no_abrio ? 'NO' : 'SI', r.motivo_puerta ? (motivoTxt[r.motivo_puerta] || r.motivo_puerta) : '', r.edad, r.sexo === 'H' ? 'Hombre' : (r.sexo === 'M' ? 'Mujer' : ''), r.discapacidad || '', r.ocupacion || '', r.seccion_num, r.municipio, r.encuesta_nombre, r.capturado_por, r.created_at, r.updated_at];
            });
            excelResponse('Ciudadanos generales', 'ciudadanos-general.xlsx', header, body);
            return;
        }
        if (tipo === 'seguros' || tipo === 'simpatizantes') {
            const rows = (await pool.query(`SELECT ${nombreExpr('c')} as nombre, ${apellidosExpr('c')}, c.telefono, c.correo, c.curp, c.ine, c.vigencia_ine, c.edad, c.sexo,
                cd.nombre as discapacidad, co2.nombre as ocupacion,
                s.id as seccion_num, m.nombre as municipio,
                u.nombre as capturado_por, c.created_at, c.updated_at
         FROM ciudadanos_comprometidos c
         ${joinPartes('ciudadanos_comprometidos', 'c')}
         LEFT JOIN secciones_electorales s ON s.id = c.seccion_id
         LEFT JOIN municipios m ON m.id = s.municipio_id
         LEFT JOIN usuarios u ON u.id = c.created_by
         LEFT JOIN cat_discapacidades cd ON cd.id = c.discapacidad_id
         LEFT JOIN cat_ocupaciones co2 ON co2.id = c.ocupacion_id
         ORDER BY c.created_at DESC`)).rows;
            const header = ['Nombre', 'Apellido paterno', 'Apellido materno', 'Telefono', 'Correo', 'CURP', 'INE', 'Vigencia INE', 'Edad', 'Sexo', 'Discapacidad', 'Ocupación', 'Seccion', 'Municipio', 'Capturado por', 'Capturado el', 'Actualizado el'];
            const body = rows.map(r => {
                return [r.nombre, r.apellido_paterno, r.apellido_materno, r.telefono, r.correo, r.curp, r.ine, r.vigencia_ine, r.edad, r.sexo === 'H' ? 'Hombre' : (r.sexo === 'M' ? 'Mujer' : ''), r.discapacidad || '', r.ocupacion || '', r.seccion_num, r.municipio, r.capturado_por, r.created_at, r.updated_at];
            });
            excelResponse('Simpatizantes', 'simpatizantes.xlsx', header, body);
            return;
        }
        const query = `SELECT ${nombreExpr('c')} as nombre, ${apellidosExpr('c')}, c.telefono, c.calle, c.numero, c.colonia, c.cp, c.edad,
              s.id as seccion_num, m.nombre as municipio, c.prioridad, c.notas,
              c.timestamp_registro
            FROM ciudadanos c
            ${joinPartes('ciudadanos', 'c')}
            JOIN secciones_electorales s ON s.id = c.seccion_id
            JOIN municipios m ON m.id = s.municipio_id`;
        const params = [];
        if (user.rol === 'enlace') {
            const secs = await getUserSecciones(user.userId);
            if (secs.length) {
                params.push(secs);
            }
        }
        const rows = params.length
            ? (await pool.query(query + ' WHERE c.seccion_id = ANY($1) ORDER BY c.nombre', params)).rows
            : (await pool.query(query + ' ORDER BY c.nombre')).rows;
        const header = ['Nombre', 'Apellido paterno', 'Apellido materno', 'Telefono', 'Calle', 'Numero', 'Colonia', 'CP', 'Edad', 'Seccion', 'Municipio', 'Prioridad', 'Notas', 'Registrado'];
        const body = rows.map(r => {
            return [r.nombre, r.apellido_paterno, r.apellido_materno, r.telefono, r.calle, r.numero, r.colonia, r.cp, r.edad, r.seccion_num, r.municipio, r.prioridad, r.notas, r.timestamp_registro];
        });
        excelResponse('Ciudadanos', 'ciudadanos.xlsx', header, body);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Reporte de ciudadanos (General): todos los capturados por barrido o tabla, con su encuesta asignada si aplica
app.get('/api/reportes/capturados-general', authenticateToken, async (req, res) => {
    try {
        const campanaId = String(req.query.campana_id || '');
        const rows = (await pool.query(`SELECT c.id, c.nombre, c.telefono, c.no_abrio, c.edad, c.calle, c.colonia,
              s.id as seccion_num, m.nombre as municipio,
              u.nombre as capturado_por, c.created_at, c.updated_at,
              cam.nombre as encuesta_nombre
       FROM ciudadanos c
       LEFT JOIN ciudadanos_encuestas ce ON ce.ciudadano_id = c.id
       LEFT JOIN campanas cam ON cam.id = ce.campana_id
       LEFT JOIN secciones_electorales s ON s.id = c.seccion_id
       LEFT JOIN municipios m ON m.id = s.municipio_id
       LEFT JOIN usuarios u ON u.id = c.created_by
       ${campanaId ? 'WHERE ce.campana_id = $1' : ''}
       ORDER BY c.created_at DESC`, campanaId ? [campanaId] : [])).rows;
        res.json(rows);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Reporte de ciudadanos: simpatizantes (comprometidos) — admin/coord
app.get('/api/reportes/capturados-seguros', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (!esAdminOCoordinador(user)) {
            res.status(403).json({ error: 'Solo coordinadores y administradores' });
            return;
        }
        const rows = (await pool.query(`SELECT c.id, c.nombre, c.telefono, c.correo, c.curp, c.ine, c.vigencia_ine, c.edad,
              c.calle, c.colonia, s.id as seccion_num, m.nombre as municipio,
              u.nombre as capturado_por, c.created_at, c.updated_at
       FROM ciudadanos_comprometidos c
       LEFT JOIN secciones_electorales s ON s.id = c.seccion_id
       LEFT JOIN municipios m ON m.id = s.municipio_id
       LEFT JOIN usuarios u ON u.id = c.created_by
       ORDER BY c.created_at DESC`)).rows;
        res.json(rows);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Reporte de cumplimiento de rutas — admin/coord
app.get('/api/reportes/rutas', authenticateToken, async (req, res) => {
    try {
        const user = req.user;
        if (!esAdminOCoordinador(user)) {
            res.status(403).json({ error: 'Solo coordinadores y administradores' });
            return;
        }
        const rows = (await pool.query(`SELECT r.id, r.enlace_id, u.nombre AS enlace_nombre, r.seccion_id, s.id AS seccion_num,
              m.nombre AS municipio, r.tipo, r.estado, r.creado_en, r.completado_en,
              r.distancia_total_km, r.tiempo_total_minutos, r.encuesta_campana_id,
              c.nombre AS encuesta_nombre, r.paradas
       FROM rutas r
       JOIN usuarios u ON u.id = r.enlace_id
       JOIN secciones_electorales s ON s.id = r.seccion_id
       LEFT JOIN municipios m ON m.id = s.municipio_id
       LEFT JOIN campanas c ON c.id = r.encuesta_campana_id
       ORDER BY r.creado_en DESC`)).rows;
        const visitadosIds = new Set();
        const visitadosPorRuta = new Map();
        const rutas = rows.map((r) => {
            const paradas = r.paradas || [];
            const visitadas = paradas.filter((p) => p.visitado);
            const visitados = visitadas.map((p) => p.id).filter(Boolean);
            visitadosPorRuta.set(r.id, visitados);
            visitados.forEach((id) => visitadosIds.add(id));
            const total = paradas.length;
            const visit = visitadas.length;
            return {
                id: r.id,
                enlace_id: r.enlace_id,
                enlace_nombre: r.enlace_nombre,
                seccion_id: r.seccion_id,
                seccion_num: r.seccion_num,
                municipio: r.municipio,
                tipo: r.tipo,
                estado: r.estado,
                creado_en: r.creado_en,
                completado_en: r.completado_en,
                distancia_total_km: Number(r.distancia_total_km || 0),
                tiempo_total_minutos: r.tiempo_total_minutos || 0,
                encuesta_campana_id: r.encuesta_campana_id,
                encuesta_nombre: r.encuesta_nombre,
                paradas_total: total,
                paradas_visitadas: visit,
                paradas_con_gps: visitadas.filter((p) => p.gps_confirmado).length,
                paradas_con_foto: visitadas.filter((p) => p.evidencia).length,
                paradas_no_abrio: paradas.filter((p) => p.no_abrio).length,
                pct_visitadas: total ? Math.round(visit / total * 100) : 0,
                atrasada: r.estado !== 'completada' && new Date(r.creado_en) < new Date(Date.now() - 24 * 3600 * 1000)
            };
        });
        let contestaron = new Set();
        if (visitadosIds.size) {
            const cr = await pool.query('SELECT DISTINCT ciudadano_id FROM encuesta_respuestas WHERE ciudadano_id = ANY($1)', [Array.from(visitadosIds)]);
            contestaron = new Set(cr.rows.map((x) => x.ciudadano_id));
        }
        rutas.forEach((r) => {
            const ids = visitadosPorRuta.get(r.id) || [];
            r.contestaron = ids.filter((id) => contestaron.has(id)).length;
        });
        const enlaceIds = [...new Set(rows.map((r) => r.enlace_id))];
        let incidenciasPorEnlace = {};
        if (enlaceIds.length) {
            const ir = await pool.query(`SELECT i.creado_por, i.tipo, i.estado, i.descripcion, i.created_at, i.ruta_id, COALESCE(ca.seccion_id, i.seccion_id) as seccion_id
         FROM incidencias i LEFT JOIN casillas ca ON ca.id = i.casilla_id
         WHERE i.creado_por = ANY($1)
         ORDER BY i.created_at DESC`, [enlaceIds]);
            ir.rows.forEach((x) => { (incidenciasPorEnlace[x.creado_por] = incidenciasPorEnlace[x.creado_por] || []).push(x); });
        }
        const totalR = rutas.length;
        const completadas = rutas.filter((r) => r.estado === 'completada').length;
        const enProgreso = rutas.filter((r) => r.estado === 'en_progreso').length;
        const pendientes = rutas.filter((r) => r.estado === 'pendiente').length;
        const paradasTotal = rutas.reduce((s, r) => s + r.paradas_total, 0);
        const paradasVisitadas = rutas.reduce((s, r) => s + r.paradas_visitadas, 0);
        const paradasNoAbrio = rutas.reduce((s, r) => s + r.paradas_no_abrio, 0);
        const porEnlace = {};
        rutas.forEach((r) => {
            const e = porEnlace[r.enlace_id] || (porEnlace[r.enlace_id] = { enlace_id: r.enlace_id, nombre: r.enlace_nombre, total: 0, completadas: 0, en_progreso: 0, pendientes: 0, visitadas: 0, paradas: 0 });
            e.total++;
            e[r.estado] = (e[r.estado] || 0) + 1;
            e.visitadas += r.paradas_visitadas;
            e.paradas += r.paradas_total;
        });
        const enlaces = Object.values(porEnlace).map((e) => ({ ...e, pct: e.total ? Math.round(e.completadas / e.total * 100) : 0 }));
        res.json({
            resumen: {
                total: totalR,
                completadas,
                en_progreso: enProgreso,
                pendientes,
                pct_completadas: totalR ? Math.round(completadas / totalR * 100) : 0,
                paradas_total: paradasTotal,
                paradas_visitadas: paradasVisitadas,
                paradas_no_abrio: paradasNoAbrio,
                pct_visitadas: paradasTotal ? Math.round(paradasVisitadas / paradasTotal * 100) : 0,
                atrasadas: rutas.filter((r) => r.atrasada).length,
                enlaces
            },
            rutas,
            incidenciasPorEnlace
        });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.get('/api/backup', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const tables = (await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name NOT LIKE 'pg_%' ORDER BY table_name`)).rows.map((r) => r.table_name);
        const chunks = [`-- Backup Colmena ${new Date().toISOString()}`, 'BEGIN;'];
        for (const t of tables) {
            try {
                const data = (await pool.query(`SELECT * FROM ${t}`)).rows;
                if (!data.length)
                    continue;
                const cols = Object.keys(data[0]);
                const lines = data.map(row => {
                    const vals = cols.map(c => {
                        const v = row[c];
                        if (v === null || v === undefined)
                            return 'NULL';
                        if (typeof v === 'object')
                            return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
                        if (typeof v === 'number')
                            return String(v);
                        return `'${String(v).replace(/'/g, "''")}'`;
                    });
                    return `INSERT INTO ${t} (${cols.join(',')}) VALUES (${vals.join(',')});`;
                });
                chunks.push(...lines);
            }
            catch (e) {
                console.warn('backup skip tabla', t, e);
            }
        }
        chunks.push('COMMIT;');
        const sql = chunks.join('\n');
        const name = `colmena_backup_${new Date().toISOString().slice(0, 10)}.sql`;
        res.setHeader('Content-Type', 'application/sql');
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        res.send(Buffer.from(sql, 'utf8'));
        const u = req.user;
        if (u?.nombre)
            await logAuditoria(u.userId, u.nombre, 'descargar_backup', 'backup', undefined, { tablas: tables.length });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Log de auditoría (solo admin)
app.get('/api/auditoria', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const limit = Math.min(parseInt(String(req.query.limit || '200')), 1000);
        const rows = await pool.query(`SELECT a.id, a.usuario_nombre, a.accion, a.entidad, a.entidad_id, a.detalle, a.created_at
       FROM auditoria a ORDER BY a.created_at DESC LIMIT $1`, [limit]);
        res.json(rows.rows);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
//# sourceMappingURL=index.js.map