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

ALTER TABLE campanas ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE campanas ADD COLUMN IF NOT EXISTS encuesta_id UUID REFERENCES campanas(id) ON DELETE SET NULL;
ALTER TABLE rutas ADD COLUMN IF NOT EXISTS encuesta_campana_id UUID REFERENCES campanas(id) ON DELETE SET NULL;
ALTER TABLE rutas ADD COLUMN IF NOT EXISTS polyline JSONB;
CREATE INDEX IF NOT EXISTS idx_campanas_tipo ON campanas(tipo);
CREATE INDEX IF NOT EXISTS idx_rutas_encuesta ON rutas(encuesta_campana_id);

INSERT INTO configuracion (clave, valor, descripcion) VALUES ('url_publica', 'http://192.168.0.16', 'URL publica del sistema (para enlaces de encuesta)')
ON CONFLICT (clave) DO NOTHING;
`).catch((e) => console.warn('Migration (visitas/encuestas/auditoria):', e?.message));
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
app.use('/api/', (0, express_rate_limit_1.default)({ windowMs: 15 * 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false, skipFailedRequests: true, message: { error: 'Demasiadas solicitudes, intente más tarde' } }));
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
async function getUserSecciones(userId) {
    try {
        const r = await pool.query('SELECT seccion_id FROM usuarios_secciones WHERE usuario_id = $1', [userId]);
        return r.rows.map((x) => x.seccion_id);
    }
    catch {
        return [];
    }
}
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        res.status(400).json({ error: 'Correo/usuario y contrasena requeridos' });
        return;
    }
    try {
        const result = await pool.query(`SELECT id, nombre, email, username, password_hash, rol, municipio_id, telefono FROM usuarios WHERE email = $1 OR nombre = $1`, [email]);
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
        await logAuditoria(user.id, user.nombre, 'login', 'usuarios', user.id).catch(() => { });
        res.json({ token, user: { id: user.id, nombre: user.nombre, email: user.email, username: user.username, rol: user.rol, municipio_id: user.municipio_id, telefono: user.telefono, secciones } });
    }
    catch (error) {
        console.error('Error en login:', error);
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
app.post('/api/auth/logout', (_req, res) => res.json({ message: 'Sesion cerrada' }));
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
app.get('/api/usuarios', authenticateToken, requireAdmin, async (_req, res) => {
    try {
        const result = await pool.query(`
      SELECT u.id, u.nombre, u.email, u.username, u.rol, u.municipio_id, u.telefono, m.nombre as municipio,
      COALESCE(json_agg(json_build_object('id', us.seccion_id)) FILTER (WHERE us.seccion_id IS NOT NULL), '[]') as secciones
      FROM usuarios u
      LEFT JOIN municipios m ON m.id = u.municipio_id
      LEFT JOIN usuarios_secciones us ON us.usuario_id = u.id
      GROUP BY u.id, u.nombre, u.email, u.username, u.rol, u.municipio_id, u.telefono, m.nombre
      ORDER BY u.nombre
    `);
        res.json(result.rows.map((r) => ({ ...r, secciones: r.secciones.map((s) => s.id) })));
    }
    catch {
        res.status(500).json({ error: 'Error al obtener usuarios' });
    }
});
app.post('/api/usuarios', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { nombre, email, username, password, rol, municipio_id, telefono, secciones } = req.body;
        if (!nombre || !email || !password || !rol) {
            res.status(400).json({ error: 'Faltan datos' });
            return;
        }
        const hash = await bcryptjs_1.default.hash(password, 10);
        const user = await pool.query('INSERT INTO usuarios (nombre, email, username, password_hash, rol, municipio_id, telefono) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [nombre, email, username || null, hash, rol, municipio_id || null, telefono || '']);
        const userId = user.rows[0].id;
        if (secciones?.length) {
            if (rol === 'coordinador') {
                const ocupadas = (await pool.query('SELECT seccion_id FROM usuarios_secciones WHERE seccion_id = ANY($1) AND usuario_id != $2', [secciones, userId])).rows.map((r) => r.seccion_id);
                if (ocupadas.length) {
                    res.status(409).json({ error: `Secciones ya asignadas a otro coordinador: ${ocupadas.join(', ')}` });
                    return;
                }
            }
            const vals = secciones.map((_, i) => `($1,$${i + 2})`).join(',');
            await pool.query(`INSERT INTO usuarios_secciones (usuario_id, seccion_id) VALUES ${vals} ON CONFLICT DO NOTHING`, [userId, ...secciones]);
        }
        res.json({ id: userId, nombre, email, rol });
    }
    catch (e) {
        res.status(500).json({ error: e.message || 'Error al crear usuario' });
    }
});
app.put('/api/usuarios/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { nombre, email, username, password, rol, municipio_id, telefono, secciones } = req.body;
        if (password) {
            const hash = await bcryptjs_1.default.hash(password, 10);
            await pool.query('UPDATE usuarios SET nombre=$1, email=$2, username=$3, password_hash=$4, rol=$5, municipio_id=$6, telefono=$7 WHERE id=$8', [nombre, email, username || null, hash, rol, municipio_id || null, telefono || '', req.params.id]);
        }
        else {
            await pool.query('UPDATE usuarios SET nombre=$1, email=$2, username=$3, rol=$4, municipio_id=$5, telefono=$6 WHERE id=$7', [nombre, email, username || null, rol, municipio_id || null, telefono || '', req.params.id]);
        }
        await pool.query('DELETE FROM usuarios_secciones WHERE usuario_id=$1', [req.params.id]);
        if (secciones?.length) {
            if (rol === 'coordinador') {
                const ocupadas = (await pool.query('SELECT seccion_id FROM usuarios_secciones WHERE seccion_id = ANY($1) AND usuario_id != $2', [secciones, req.params.id])).rows.map((r) => r.seccion_id);
                if (ocupadas.length) {
                    res.status(409).json({ error: `Secciones ya asignadas a otro coordinador: ${ocupadas.join(', ')}` });
                    return;
                }
            }
            const vals = secciones.map((_, i) => `($1,$${i + 2})`).join(',');
            await pool.query(`INSERT INTO usuarios_secciones (usuario_id, seccion_id) VALUES ${vals} ON CONFLICT DO NOTHING`, [req.params.id, ...secciones]);
        }
        res.json({ message: 'Usuario actualizado' });
    }
    catch (e) {
        res.status(500).json({ error: e.message || 'Error al actualizar' });
    }
});
app.delete('/api/usuarios/:id', authenticateToken, requireAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM rutas WHERE enlace_id=$1 OR admin_id=$1', [req.params.id]);
        await client.query('DELETE FROM eventos WHERE creado_por=$1', [req.params.id]);
        await client.query('DELETE FROM ubicaciones_enlace WHERE user_id=$1', [req.params.id]);
        await client.query('DELETE FROM push_subscriptions WHERE user_id=$1', [req.params.id]);
        await client.query('DELETE FROM notificaciones WHERE usuario_id=$1', [req.params.id]);
        await client.query('DELETE FROM usuarios_secciones WHERE usuario_id=$1', [req.params.id]);
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
app.post('/api/usuarios/:id/reset-password', authenticateToken, requireAdmin, async (req, res) => {
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
app.post('/api/estados', authenticateToken, requireAdmin, async (req, res) => {
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
app.put('/api/estados/:id', authenticateToken, requireAdmin, async (req, res) => {
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
app.delete('/api/estados/:id', authenticateToken, requireAdmin, async (req, res) => {
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
        const result = await pool.query('SELECT id, nombre, lat, lng FROM municipios WHERE estado_id = $1 ORDER BY nombre', [req.params.estadoId]);
        res.json(result.rows);
    }
    catch {
        res.status(500).json({ error: 'Error al obtener municipios' });
    }
});
app.post('/api/municipios', authenticateToken, requireAdmin, async (req, res) => {
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
app.put('/api/municipios/:id', authenticateToken, requireAdmin, async (req, res) => {
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
app.delete('/api/municipios/:id', authenticateToken, requireAdmin, async (req, res) => {
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
        let query = `SELECT s.id, s.municipio_id, s.tipo, m.nombre as municipio, m.estado_id
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
        else if (user.rol === 'coordinador') {
            const mRes = await pool.query('SELECT municipio_id FROM usuarios WHERE id=$1', [user.userId]);
            const muniId = mRes.rows[0]?.municipio_id;
            if (muniId) {
                params.push(muniId);
                query += ` WHERE s.municipio_id = $${params.length}`;
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
        const soloExclusivo = rol === 'coordinador';
        const result = await pool.query(`
      SELECT s.id, s.tipo,
        ${soloExclusivo ? `(SELECT us.usuario_id FROM usuarios_secciones us JOIN usuarios u ON u.id = us.usuario_id WHERE us.seccion_id = s.id AND u.rol = 'coordinador' ${excluir_usuario ? 'AND us.usuario_id != $2' : ''}) as asignada_a` : 'NULL as asignada_a'}
      FROM secciones_electorales s WHERE s.municipio_id = $1 ORDER BY s.id`, soloExclusivo && excluir_usuario ? [req.params.municipioId, excluir_usuario] : [req.params.municipioId]);
        res.json(result.rows);
    }
    catch (e) {
        console.error('Error en /api/secciones/:municipioId', e.message || e);
        res.status(500).json({ error: 'Error al obtener secciones' });
    }
});
app.post('/api/secciones', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { id, municipio_id, tipo } = req.body;
        if (!id || !municipio_id) {
            res.status(400).json({ error: 'id y municipio_id requeridos' });
            return;
        }
        await pool.query('INSERT INTO secciones_electorales (id, municipio_id, tipo) VALUES ($1,$2,$3) ON CONFLICT (id) DO UPDATE SET municipio_id=$2, tipo=$3', [id, municipio_id, tipo || 'urbana']);
        res.status(201).json({ message: 'Sección guardada' });
    }
    catch {
        res.status(500).json({ error: 'Error al guardar sección' });
    }
});
app.put('/api/secciones/:id', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const { municipio_id, tipo } = req.body;
        await pool.query('UPDATE secciones_electorales SET municipio_id=$1, tipo=$2 WHERE id=$3', [municipio_id, tipo, req.params.id]);
        res.json({ message: 'Sección actualizada' });
    }
    catch {
        res.status(500).json({ error: 'Error al actualizar' });
    }
});
app.delete('/api/secciones/:id', authenticateToken, requireAdmin, async (req, res) => {
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
        const outputPath = path_1.default.join(__dirname, '../uploads/evidencias', filename);
        await (0, sharp_1.default)(buf).resize(1200, 1200, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toFile(outputPath);
        res.json({ url: '/uploads/evidencias/' + filename });
    }
    catch {
        res.status(500).json({ error: 'Error al subir imagen' });
    }
});
app.post('/api/ciudadanos', authenticateToken, async (req, res) => {
    try {
        const { seccion_id, numero_hogar, nombre, telefono, calle, numero, colonia, cp, lat, lng, simpatizante, prioridad, intencion_voto_presidente, intencion_voto_diputado, notas, edad, idempotency_key } = req.body;
        if (!seccion_id || !nombre) {
            res.status(400).json({ error: 'seccion_id y nombre requeridos' });
            return;
        }
        // Idempotency check: if key provided and already processed, return existing record
        if (idempotency_key) {
            const existing = await pool.query('SELECT id FROM ciudadanos WHERE idempotency_key=$1', [idempotency_key]);
            if (existing.rows.length) {
                res.status(200).json({ id: existing.rows[0].id, message: 'Ya existe (idempotente)' });
                try {
                    io.emit('nuevo-ciudadano', { seccion_id, lat, lng, nombre });
                }
                catch (e) {
                    console.warn('io.emit error:', e);
                }
                return;
            }
        }
        const id = crypto_1.default.randomUUID();
        await pool.query(`INSERT INTO ciudadanos (id, seccion_id, numero_hogar, nombre, telefono, calle, numero, colonia, cp, ubicacion, simpatizante, prioridad, intencion_voto_presidente, intencion_voto_diputado, notas, edad, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,ST_SetSRID(ST_MakePoint($10,$11),4326),$12,$13,$14,$15,$16,$17,$18)`, [id, seccion_id, numero_hogar || null, nombre, telefono || null, calle || null, numero || null, colonia || null, cp || null, lng || -100.9929, lat || 20.6434, !!simpatizante, prioridad || 0, intencion_voto_presidente || null, intencion_voto_diputado || null, notas || null, edad ? parseInt(edad) : null, idempotency_key || null]);
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
        const { nombre, telefono, seccion_id, calle, numero, colonia, cp, lat, lng, simpatizante, prioridad, numero_hogar, intencion_voto_presidente, intencion_voto_diputado, notas, edad } = req.body;
        const parts = [];
        const params = [];
        const p = (v) => { params.push(v); return '$' + params.length; };
        const cols = ['nombre', 'telefono', 'seccion_id', 'calle', 'numero', 'colonia', 'cp'];
        const vals = [nombre || null, telefono || null, seccion_id || null, calle || null, numero || null, colonia || null, cp || null];
        parts.push(cols.map((c, i) => c + '=COALESCE(' + p(vals[i]) + ',' + c + ')').join(','));
        if (lat != null && lng != null && !Number.isNaN(+lat) && !Number.isNaN(+lng)) {
            parts.push('ubicacion=ST_SetSRID(ST_MakePoint(' + p(+lng) + ',' + p(+lat) + '),4326)');
        }
        const cols2 = ['simpatizante', 'prioridad', 'numero_hogar', 'intencion_voto_presidente', 'intencion_voto_diputado', 'notas', 'edad'];
        const vals2 = [simpatizante != null ? !!simpatizante : null, prioridad || 0, numero_hogar || null, intencion_voto_presidente || null, intencion_voto_diputado || null, notas || null, edad || null];
        parts.push(cols2.map((c, i) => c + '=COALESCE(' + p(vals2[i]) + ',' + c + ')').join(','));
        params.push(req.params.id);
        await pool.query('UPDATE ciudadanos SET ' + parts.join(',') + ' WHERE id=$' + params.length, params);
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
        const user = req.user;
        const seccionId = req.query.seccion_id;
        let query = `SELECT c.id, c.seccion_id, c.numero_hogar, c.nombre, c.telefono, c.calle, c.numero, c.colonia, c.cp, c.edad, c.notas,
                  ST_X(c.ubicacion::geometry) as lng, ST_Y(c.ubicacion::geometry) as lat,
                  c.simpatizante, c.prioridad, c.timestamp_registro,
                  c.intencion_voto_presidente, pp.nombre as partido_presidente_nombre, pp.color as partido_presidente_color, pp.abreviatura as partido_presidente_abreviatura,
                  c.intencion_voto_diputado, pd.nombre as partido_diputado_nombre, pd.color as partido_diputado_color, pd.abreviatura as partido_diputado_abreviatura,
                  s.id as seccion_num, m.nombre as municipio, e.nombre as estado
                FROM ciudadanos c
                JOIN secciones_electorales s ON s.id = c.seccion_id
                JOIN municipios m ON m.id = s.municipio_id
                JOIN estados e ON e.id = m.estado_id
                LEFT JOIN partidos_politicos pp ON pp.id = c.intencion_voto_presidente
                LEFT JOIN partidos_politicos pd ON pd.id = c.intencion_voto_diputado`;
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
        else if (user.rol === 'coordinador') {
            const mRes = await pool.query('SELECT municipio_id FROM usuarios WHERE id=$1', [user.userId]);
            const muniId = mRes.rows[0]?.municipio_id;
            if (muniId) {
                params.push(muniId);
                conds.push(`s.municipio_id = $${params.length}`);
            }
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
        if (user.rol === 'coordinador') {
            const mRes = await pool.query('SELECT municipio_id FROM usuarios WHERE id=$1', [user.userId]);
            const muniId = mRes.rows[0]?.municipio_id;
            if (!muniId) {
                res.json([]);
                return;
            }
            params.push(muniId);
            where = ` WHERE s.municipio_id = $${params.length} `;
        }
        params.push(2);
        const query = `SELECT LOWER(TRIM(c.nombre)) as grupo_clave,
      array_agg(c.id) as ids, array_agg(c.nombre) as nombres, array_agg(c.edad) as edades,
      array_agg(c.calle) as calles, array_agg(c.numero) as numeros, array_agg(c.colonia) as colonias,
      array_agg(c.cp) as cps, array_agg(c.telefono) as telefonos,
      array_agg(c.simpatizante) as simpatizantes, array_agg(c.prioridad) as prioridades,
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
                telefono: r.telefonos[i], simpatizante: r.simpatizantes[i], prioridad: r.prioridades[i],
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
        c.intencion_voto_diputado, pd.nombre as partido_diputado_nombre, pd.color as partido_diputado_color, pd.abreviatura as partido_diputado_abreviatura
       FROM ciudadanos c
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
        else if (user.rol === 'coordinador') {
            const mRes = await pool.query('SELECT municipio_id FROM usuarios WHERE id=$1', [user.userId]);
            const muniId = mRes.rows[0]?.municipio_id;
            if (muniId) {
                params.push(muniId);
                query += ` WHERE e.seccion_id IN (SELECT id FROM secciones_electorales WHERE municipio_id = $${params.length})`;
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
        const simpFilter = ev.alertar_solo_simpatizantes ? ' AND simpatizante = TRUE' : '';
        let ciudadanos;
        if (ev.lat && ev.lng) {
            ciudadanos = (await pool.query(`SELECT id, nombre, telefono FROM ciudadanos WHERE telefono IS NOT NULL AND telefono != '' AND ST_DWithin(ubicacion, ST_SetSRID(ST_MakePoint($1,$2),4326), $3)${simpFilter}`, [ev.lng, ev.lat, ev.radio_geocerca || 500])).rows;
        }
        else if (ev.seccion_id) {
            ciudadanos = (await pool.query(`SELECT id, nombre, telefono FROM ciudadanos WHERE seccion_id=$1 AND telefono IS NOT NULL AND telefono != ''${simpFilter}`, [ev.seccion_id])).rows;
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
        else if (user.rol === 'coordinador') {
            const mRes = await pool.query('SELECT municipio_id FROM usuarios WHERE id=$1', [user.userId]);
            if (mRes.rows[0]?.municipio_id) {
                params.push(mRes.rows[0].municipio_id);
                query += ' WHERE r.seccion_id IN (SELECT id FROM secciones_electorales WHERE municipio_id = $1)';
            }
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
        const { enlace_ids, seccion_id, solo_simpatizantes, encuesta_campana_id } = req.body;
        if (!enlace_ids?.length || !seccion_id) {
            res.status(400).json({ error: 'enlace_ids[] y seccion_id requeridos' });
            return;
        }
        if (encuesta_campana_id) {
            const ec = (await pool.query('SELECT tipo FROM campanas WHERE id=$1', [encuesta_campana_id])).rows[0];
            if (!ec || ec.tipo !== 'encuesta') {
                res.status(400).json({ error: 'La encuesta asignada no existe o no es tipo encuesta' });
                return;
            }
        }
        if (user.rol === 'coordinador') {
            const mRes = await pool.query('SELECT municipio_id FROM usuarios WHERE id=$1', [user.userId]);
            const muniId = mRes.rows[0]?.municipio_id;
            const ok = (await pool.query('SELECT id FROM secciones_electorales WHERE id=$1 AND municipio_id=$2', [seccion_id, muniId])).rows.length > 0;
            if (!ok) {
                res.status(403).json({ error: 'La seccion no pertenece a tu municipio' });
                return;
            }
        }
        const countRes = await pool.query(`SELECT COUNT(*) FROM ciudadanos WHERE seccion_id=$1${solo_simpatizantes ? ' AND simpatizante=true' : ''}`, [seccion_id]);
        if (parseInt(countRes.rows[0].count) === 0) {
            res.status(400).json({ error: `No hay ciudadanos${solo_simpatizantes ? ' simpatizantes' : ''} en esta seccion para asignar` });
            return;
        }
        const misiones = await routingService.repartirRutas(seccion_id.toString(), !!solo_simpatizantes, enlace_ids.length);
        const ids = [];
        for (let i = 0; i < enlace_ids.length; i++) {
            const mision = misiones[i] || { paradas: [], distancia_total_km: 0, tiempo_total_minutos: 0 };
            const r = await pool.query(`INSERT INTO rutas (admin_id, enlace_id, seccion_id, solo_simpatizantes, paradas, distancia_total_km, tiempo_total_minutos, encuesta_campana_id, polyline)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [user.userId, enlace_ids[i], seccion_id, !!solo_simpatizantes, JSON.stringify(mision.paradas || []),
                mision.distancia_total_km || 0, mision.tiempo_total_minutos || 0, encuesta_campana_id || null,
                mision.polyline ? JSON.stringify(mision.polyline) : null]);
            ids.push(r.rows[0].id);
        }
        const sockets = await io.fetchSockets();
        enlace_ids.forEach((eid) => sockets.forEach(s => { if (s.userId === eid)
            s.emit('nueva-ruta', { ids }); }));
        // Send push notification to each enlace
        for (const eid of enlace_ids) {
            await sendPushToUser(eid, 'Nueva ruta asignada', 'Se te ha asignado una ruta de cambaceo', '/mi-ruta');
        }
        res.status(201).json({ ids, message: `Rutas creadas para ${enlace_ids.length} enlace(s) con paradas distribuidas` });
    }
    catch (e) {
        res.status(500).json({ error: 'Error al crear rutas: ' + (e.message || '') });
    }
});
app.get('/api/rutas/:id', authenticateToken, async (req, res) => {
    try {
        const r = await pool.query(`SELECT r.*, u.nombre as enlace_nombre, c.nombre as encuesta_campana_nombre, c.encuesta_lanzada FROM rutas r JOIN usuarios u ON u.id = r.enlace_id LEFT JOIN campanas c ON c.id = r.encuesta_campana_id WHERE r.id=$1`, [req.params.id]);
        if (!r.rows.length) {
            res.status(404).json({ error: 'No encontrada' });
            return;
        }
        res.json(r.rows[0]);
    }
    catch {
        res.status(500).json({ error: 'Error' });
    }
});
app.delete('/api/rutas/:id', authenticateToken, requireAdmin, async (req, res) => {
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
        const { visitado, gps_confirmado, evidencia } = req.body;
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
        paradas[idx].visitado = !!visitado;
        paradas[idx].gps_confirmado = !!gps_confirmado;
        if (evidencia !== undefined)
            paradas[idx].evidencia = evidencia;
        await pool.query('UPDATE rutas SET paradas=$1 WHERE id=$2', [JSON.stringify(paradas), req.params.id]);
        res.json({ message: 'Parada actualizada' });
    }
    catch (e) {
        res.status(500).json({ error: 'Error: ' + (e.message || '') });
    }
});
app.post('/api/rutas/mision', authenticateToken, async (req, res) => {
    try {
        const { seccion_id, solo_simpatizantes } = req.body;
        if (!seccion_id) {
            res.status(400).json({ error: 'seccion_id requerido' });
            return;
        }
        const centroid = await routingService.obtenerCentroideSeccion(seccion_id.toString());
        const mision = await routingService.calcularRutaOptima(centroid || { lat: 20.6434, lng: -100.9929 }, seccion_id.toString(), solo_simpatizantes || false);
        res.json(mision);
    }
    catch (e) {
        res.status(500).json({ error: 'Error al calcular misión: ' + (e.message || '') });
    }
});
app.post('/api/rutas/optimizar', authenticateToken, async (req, res) => {
    try {
        const { origen_lat, origen_lng, seccion_id, solo_simpatizantes } = req.body;
        if (!origen_lat || !origen_lng || !seccion_id) {
            res.status(400).json({ error: 'Faltan datos' });
            return;
        }
        const ruta = await routingService.calcularRutaOptima({ lat: origen_lat, lng: origen_lng }, seccion_id.toString(), solo_simpatizantes || false);
        res.json(ruta);
    }
    catch {
        res.status(500).json({ error: 'Error' });
    }
});
app.get('/api/rutas/paradas/:seccionId', authenticateToken, async (req, res) => {
    try {
        const paradas = await routingService['obtenerParadas'](req.params.seccionId, false);
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
    const result = await pool.query('SELECT id, nombre, abreviatura, color FROM partidos_politicos ORDER BY nombre');
    res.json(result.rows);
});
app.post('/api/partidos', authenticateToken, requireAdmin, async (req, res) => {
    const { nombre, abreviatura, color } = req.body;
    await pool.query('INSERT INTO partidos_politicos (nombre, abreviatura, color) VALUES ($1,$2,$3)', [nombre, abreviatura, color || '#999999']);
    res.status(201).json({ message: 'Partido guardado' });
});
app.put('/api/partidos/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { nombre, abreviatura, color } = req.body;
    await pool.query('UPDATE partidos_politicos SET nombre=$1, abreviatura=$2, color=$3 WHERE id=$4', [nombre, abreviatura, color, req.params.id]);
    res.json({ message: 'Partido actualizado' });
});
app.delete('/api/partidos/:id', authenticateToken, requireAdmin, async (req, res) => {
    await pool.query('DELETE FROM partidos_politicos WHERE id=$1', [req.params.id]);
    res.json({ message: 'Partido eliminado' });
});
app.get('/api/casillas', authenticateToken, async (req, res) => {
    const { seccion_id } = req.query;
    let query = `SELECT c.id, c.seccion_id, c.nombre, c.direccion, m.nombre as municipio
               FROM casillas c
               JOIN secciones_electorales s ON s.id = c.seccion_id
               JOIN municipios m ON m.id = s.municipio_id`;
    const params = [];
    if (seccion_id) {
        query += ' WHERE c.seccion_id = $1';
        params.push(seccion_id);
    }
    query += ' ORDER BY c.seccion_id, c.nombre';
    const result = await pool.query(query, params);
    res.json(result.rows);
});
app.post('/api/casillas', authenticateToken, requireAdmin, async (req, res) => {
    const { seccion_id, nombre, direccion } = req.body;
    if (!seccion_id || !nombre) {
        res.status(400).json({ error: 'seccion_id y nombre requeridos' });
        return;
    }
    await pool.query('INSERT INTO casillas (seccion_id, nombre, direccion) VALUES ($1,$2,$3) ON CONFLICT (seccion_id,nombre) DO UPDATE SET direccion=$3', [seccion_id, nombre, direccion || '']);
    res.status(201).json({ message: 'Casilla guardada' });
});
app.put('/api/casillas/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { nombre, direccion, seccion_id } = req.body;
    await pool.query('UPDATE casillas SET seccion_id=$1, nombre=$2, direccion=$3 WHERE id=$4', [seccion_id, nombre, direccion || '', req.params.id]);
    res.json({ message: 'Casilla actualizada' });
});
app.delete('/api/casillas/:id', authenticateToken, requireAdmin, async (req, res) => {
    await pool.query('DELETE FROM casillas WHERE id=$1', [req.params.id]);
    res.json({ message: 'Casilla eliminada' });
});
app.get('/api/resultados', authenticateToken, async (req, res) => {
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
});
app.post('/api/resultados', authenticateToken, async (req, res) => {
    const { casilla_id, partido_id, votos, tipo } = req.body;
    await pool.query(`INSERT INTO resultados_casilla (casilla_id, partido_id, votos, tipo)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (casilla_id, partido_id, tipo) DO UPDATE SET votos=$3`, [casilla_id, partido_id, votos, tipo || 'presidente_municipal']);
    res.status(201).json({ message: 'Resultado guardado' });
});
app.delete('/api/resultados/:id', authenticateToken, async (req, res) => {
    await pool.query('DELETE FROM resultados_casilla WHERE id=$1', [req.params.id]);
    res.json({ message: 'Resultado eliminado' });
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
    const countResult = await pool.query('SELECT COUNT(*) FROM ciudadanos');
    const total = parseInt(countResult.rows[0].count);
    const result = await pool.query('INSERT INTO campanas (nombre, plantilla_id, filtros, scheduled_at, status, total_ciudadanos, tipo, encuesta_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [nombre, plantilla_id || null, JSON.stringify(filtros || []), scheduled_at || null, 'pending', total, tipo || 'whatsapp', encuesta_id || null]);
    res.status(201).json({ id: result.rows[0].id, message: 'Campaña guardada' });
});
app.put('/api/campanas/:id', authenticateToken, async (req, res) => {
    const { nombre, plantilla_id, filtros, scheduled_at, status, encuesta_lanzada, tipo, encuesta_id } = req.body;
    const actual = (await pool.query('SELECT tipo, encuesta_id FROM campanas WHERE id=$1', [req.params.id])).rows[0];
    const tipoFinal = tipo !== undefined ? tipo : (actual?.tipo || 'whatsapp');
    const encuestaFinal = encuesta_id !== undefined ? encuesta_id : (actual?.encuesta_id || null);
    await pool.query('UPDATE campanas SET nombre=$1, plantilla_id=$2, filtros=$3, scheduled_at=$4, status=$5, encuesta_lanzada=$6, tipo=$7, encuesta_id=$8 WHERE id=$9', [nombre, plantilla_id || null, JSON.stringify(filtros || []), scheduled_at || null, status || 'pending', !!encuesta_lanzada, tipoFinal, encuestaFinal, req.params.id]);
    res.json({ message: 'Campaña actualizada' });
});
app.delete('/api/campanas/:id', authenticateToken, async (req, res) => {
    await pool.query('DELETE FROM campanas WHERE id=$1', [req.params.id]);
    res.json({ message: 'Campaña eliminada' });
});
app.post('/api/campanas/preview', authenticateToken, async (req, res) => {
    try {
        const { filtros } = req.body;
        const conditions = [];
        const params = [];
        let idx = 1;
        const filtrosDef = await pool.query('SELECT * FROM filtros_campana');
        const defMap = {};
        for (const fd of filtrosDef.rows)
            defMap[fd.id] = fd;
        for (const f of filtros || []) {
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
            if (op === 'LIKE') {
                conditions.push(`ciudadanos.${col} ILIKE $${idx++}`);
                params.push(`%${valor}%`);
            }
            else if (op === 'IN') {
                const vals = Array.isArray(valor) ? valor : [valor];
                const placeholders = vals.map(() => `$${idx++}`).join(',');
                conditions.push(`ciudadanos.${col} IN (${placeholders})`);
                params.push(...vals);
            }
            else if (op === 'BETWEEN') {
                const parts = (valor || '').split('-');
                if (parts.length === 2) {
                    conditions.push(`ciudadanos.${col} BETWEEN $${idx++} AND $${idx++}`);
                    params.push(parseInt(parts[0]), parseInt(parts[1]));
                }
            }
            else if (op === 'IS_NULL') {
                if (valor === 'si')
                    conditions.push(`ciudadanos.${col} IS NULL`);
                else
                    conditions.push(`ciudadanos.${col} IS NOT NULL`);
            }
            else if (op === '>=') {
                conditions.push(`ciudadanos.${col} >= $${idx++}`);
                params.push(valor);
            }
            else if (op === '<=') {
                conditions.push(`ciudadanos.${col} <= $${idx++}`);
                params.push(valor);
            }
            else {
                conditions.push(`ciudadanos.${col} ${op} $${idx++}`);
                params.push(valor);
            }
        }
        const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
        const countResult = await pool.query(`SELECT COUNT(*) FROM ciudadanos ${where}`, params);
        const total = parseInt(countResult.rows[0].count);
        const dataResult = await pool.query(`SELECT ciudadanos.id, ciudadanos.nombre, ciudadanos.seccion_id, ciudadanos.telefono, ciudadanos.simpatizante FROM ciudadanos ${where} ORDER BY ciudadanos.nombre LIMIT 500`, params);
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
app.get('/api/secciones/:municipioId/geometrias', async (req, res) => {
    try {
        const muniId = parseInt(req.params.municipioId);
        // INE stores 2-digit municipio code; our DB uses 5-digit (11 + INE code)
        const ineMuni = muniId % 100;
        const result = await pool.query(`SELECT s.seccion, ST_AsGeoJSON(s.geom)::jsonb as geometry
       FROM seccion_geo s
       WHERE s.municipio = $1`, [ineMuni]);
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
                    const simpFilter = ev.alertar_solo_simpatizantes ? ' AND simpatizante = TRUE' : '';
                    ciudadanos = (await pool.query(`SELECT id, nombre, telefono FROM ciudadanos
             WHERE telefono IS NOT NULL AND telefono != ''
             AND ST_DWithin(ubicacion, ST_SetSRID(ST_MakePoint($1,$2),4326), $3)${simpFilter}`, [ev.lng, ev.lat, ev.radio_geocerca || 500])).rows;
                }
                else if (ev.seccion_id) {
                    const simpFilter = ev.alertar_solo_simpatizantes ? ' AND simpatizante = TRUE' : '';
                    ciudadanos = (await pool.query(`SELECT id, nombre, telefono FROM ciudadanos WHERE seccion_id=$1 AND telefono IS NOT NULL AND telefono != ''${simpFilter}`, [ev.seccion_id])).rows;
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
        res.json(rows.rows);
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
        else if (user.rol === 'coordinador') {
            const mRes = await pool.query('SELECT municipio_id FROM usuarios WHERE id=$1', [user.userId]);
            params.push(mRes.rows[0]?.municipio_id || null);
            conds.push(`s.municipio_id = $${params.length}`);
        }
        if (qm) {
            params.push(qm);
            conds.push(`s.municipio_id = $${params.length}`);
        }
        const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
        const rows = await pool.query(`WITH vis AS (SELECT ciudadano_id FROM visitas WHERE created_at >= NOW() - INTERVAL '24 hours')
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
            where += ' AND c.encuesta_lanzada = TRUE';
        }
        const rows = await pool.query(`SELECT p.id, p.campana_id, p.pregunta, p.tipo, p.opciones, p.obligatoria, p.orden, p.activa, c.nombre as campana_nombre, c.encuesta_lanzada
       FROM encuesta_preguntas p JOIN campanas c ON c.id = p.campana_id
       ${where} ORDER BY p.orden ASC, p.created_at ASC`, params);
        res.json(rows.rows);
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
app.post('/api/encuestas/preguntas', authenticateToken, requireAdmin, async (req, res) => {
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
app.put('/api/encuestas/preguntas/:id', authenticateToken, requireAdmin, async (req, res) => {
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
app.delete('/api/encuestas/preguntas/:id', authenticateToken, requireAdmin, async (req, res) => {
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
        return (r.rows[0]?.valor || 'http://192.168.0.16').replace(/\/+$/, '');
    }
    catch {
        return 'http://192.168.0.16';
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
app.post('/api/campanas/:id/enlace-demo', authenticateToken, requireAdmin, async (req, res) => {
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
        const query = `SELECT c.nombre, c.telefono, c.calle, c.numero, c.colonia, c.cp, c.edad,
              s.id as seccion_num, m.nombre as municipio, c.simpatizante, c.prioridad, c.notas,
              c.timestamp_registro
            FROM ciudadanos c
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
        const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const header = ['Nombre', 'Telefono', 'Calle', 'Numero', 'Colonia', 'CP', 'Edad', 'Seccion', 'Municipio', 'Simpatizante', 'Prioridad', 'Notas', 'Registrado'];
        const headCells = header.map(h => `<Cell ss:StyleID="h"><Data ss:Type="String">${esc(h)}</Data></Cell>`).join('');
        const body = rows.map(r => {
            const vals = [r.nombre, r.telefono, r.calle, r.numero, r.colonia, r.cp, r.edad, r.seccion_num, r.municipio, r.simpatizante ? 'SI' : 'NO', r.prioridad, r.notas, r.timestamp_registro];
            return '<Row>' + vals.map(v => `<Cell><Data ss:Type="String">${esc(v)}</Data></Cell>`).join('') + '</Row>';
        }).join('');
        const xml = `<?xml version="1.0"?><?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles><Style ss:ID="h"><Font ss:Bold="1"/></Style></Styles>
 <Worksheet ss:Name="Ciudadanos"><Table>${headCells}${body}</Table></Worksheet></Workbook>`;
        res.setHeader('Content-Type', 'application/vnd.ms-excel');
        res.setHeader('Content-Disposition', 'attachment; filename="ciudadanos.xls"');
        res.send(Buffer.from(xml, 'utf8'));
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// Backup descargable (dump SQL portable de todas las tablas)
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