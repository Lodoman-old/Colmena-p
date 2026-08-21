"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotificacionService = void 0;
const axios_1 = __importDefault(require("axios"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
class NotificacionService {
    constructor(pool) {
        this._fcmToken = null;
        this.pool = pool;
    }
    async getConfig(clave) {
        try {
            const r = await this.pool.query('SELECT valor FROM configuracion WHERE clave=$1', [clave]);
            return r.rows[0]?.valor || '';
        }
        catch {
            return '';
        }
    }
    async obtenerAccessTokenFCM() {
        try {
            if (this._fcmToken && this._fcmToken.exp > Date.now() + 60000)
                return this._fcmToken.token;
            const saRaw = await this.getConfig('firebase_service_account');
            if (!saRaw)
                return '';
            const sa = JSON.parse(saRaw);
            const now = Math.floor(Date.now() / 1000);
            const assertion = jsonwebtoken_1.default.sign({
                iss: sa.client_email,
                sub: sa.client_email,
                aud: 'https://oauth2.googleapis.com/token',
                iat: now,
                exp: now + 3300,
                scope: 'https://www.googleapis.com/auth/firebase.messaging'
            }, sa.private_key, { algorithm: 'RS256' });
            const r = await axios_1.default.post('https://oauth2.googleapis.com/token', new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
            const t = r.data.access_token;
            this._fcmToken = { token: t, exp: Date.now() + (parseInt(r.data.expires_in || '3300', 10) * 1000) };
            return t;
        }
        catch (e) {
            console.warn('FCM token:', e?.message || e);
            return '';
        }
    }
    async enviarPush(tokenFcm, titulo, cuerpo) {
        try {
            const saRaw = await this.getConfig('firebase_service_account');
            if (!saRaw || !tokenFcm)
                return;
            const sa = JSON.parse(saRaw);
            const accessToken = await this.obtenerAccessTokenFCM();
            if (!accessToken)
                return;
            await axios_1.default.post(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, { message: { token: tokenFcm, notification: { title: titulo, body: cuerpo } } }, { headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' } });
        }
        catch (e) {
            console.warn('FCM v1:', e?.response?.data || e?.message || e);
        }
    }
    async enviarPushAUsuarios(userIds, titulo, cuerpo) {
        try {
            const saRaw = await this.getConfig('firebase_service_account');
            if (!saRaw)
                return;
            const tokens = (await this.pool.query('SELECT DISTINCT token_fcm FROM dispositivos WHERE usuario_id = ANY($1)', [userIds])).rows;
            for (const t of tokens) {
                await this.enviarPush(t.token_fcm, titulo, cuerpo);
            }
        }
        catch { }
    }
    async enviarWhatsApp(telefono, mensaje) {
        try {
            const sid = await this.getConfig('twilio_sid');
            const token = await this.getConfig('twilio_token');
            const de = await this.getConfig('twilio_whatsapp');
            if (!sid || !token || !de || !telefono)
                return;
            const num = telefono.startsWith('+') ? telefono : '+52' + telefono;
            await axios_1.default.post(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, new URLSearchParams({ From: 'whatsapp:' + de, To: 'whatsapp:' + num, Body: mensaje }), { auth: { username: sid, password: token }, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        }
        catch { }
    }
}
exports.NotificacionService = NotificacionService;
//# sourceMappingURL=Notificaciones.js.map