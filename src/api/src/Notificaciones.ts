import axios from 'axios';
import { Pool } from 'pg';
import jwt from 'jsonwebtoken';

export class NotificacionService {
  private pool: Pool;
  private _fcmToken: { token: string; exp: number } | null = null;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  private async getConfig(clave: string): Promise<string> {
    try {
      const r = await this.pool.query('SELECT valor FROM configuracion WHERE clave=$1', [clave]);
      return r.rows[0]?.valor || '';
    } catch { return ''; }
  }

  private async obtenerAccessTokenFCM(): Promise<string> {
    try {
      if (this._fcmToken && this._fcmToken.exp > Date.now() + 60000) return this._fcmToken.token;
      const saRaw = await this.getConfig('firebase_service_account');
      if (!saRaw) return '';
      const sa = JSON.parse(saRaw);
      const now = Math.floor(Date.now() / 1000);
      const assertion = jwt.sign(
        {
          iss: sa.client_email,
          sub: sa.client_email,
          aud: 'https://oauth2.googleapis.com/token',
          iat: now,
          exp: now + 3300,
          scope: 'https://www.googleapis.com/auth/firebase.messaging'
        },
        sa.private_key,
        { algorithm: 'RS256' }
      );
      const r = await axios.post('https://oauth2.googleapis.com/token',
        new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const t = r.data.access_token as string;
      this._fcmToken = { token: t, exp: Date.now() + (parseInt(r.data.expires_in || '3300', 10) * 1000) };
      return t;
    } catch (e: any) { console.warn('FCM token:', e?.message || e); return ''; }
  }

  async enviarPush(tokenFcm: string, titulo: string, cuerpo: string): Promise<void> {
    try {
      const saRaw = await this.getConfig('firebase_service_account');
      if (!saRaw || !tokenFcm) return;
      const sa = JSON.parse(saRaw);
      const accessToken = await this.obtenerAccessTokenFCM();
      if (!accessToken) return;
      await axios.post(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
        { message: { token: tokenFcm, notification: { title: titulo, body: cuerpo } } },
        { headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' } }
      );
    } catch (e: any) { console.warn('FCM v1:', e?.response?.data || e?.message || e); }
  }

  async enviarPushAUsuarios(userIds: string[], titulo: string, cuerpo: string): Promise<void> {
    try {
      const saRaw = await this.getConfig('firebase_service_account');
      if (!saRaw) return;
      const tokens = (await this.pool.query('SELECT DISTINCT token_fcm FROM dispositivos WHERE usuario_id = ANY($1)', [userIds])).rows;
      for (const t of tokens) {
        await this.enviarPush(t.token_fcm, titulo, cuerpo);
      }
    } catch {}
  }

  async enviarWhatsApp(telefono: string, mensaje: string): Promise<void> {
    try {
      const sid = await this.getConfig('twilio_sid');
      const token = await this.getConfig('twilio_token');
      const de = await this.getConfig('twilio_whatsapp');
      if (!sid || !token || !de || !telefono) return;
      const num = telefono.startsWith('+') ? telefono : '+52' + telefono;
      await axios.post(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        new URLSearchParams({ From: 'whatsapp:' + de, To: 'whatsapp:' + num, Body: mensaje }),
        { auth: { username: sid, password: token }, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
    } catch {}
  }
}