import axios from 'axios';
import { Pool } from 'pg';

export class NotificacionService {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  private async getConfig(clave: string): Promise<string> {
    try {
      const r = await this.pool.query('SELECT valor FROM configuracion WHERE clave=$1', [clave]);
      return r.rows[0]?.valor || '';
    } catch { return ''; }
  }

  async enviarPush(tokenFcm: string, titulo: string, cuerpo: string): Promise<void> {
    try {
      const serverKey = await this.getConfig('firebase_key');
      if (!serverKey || !tokenFcm) return;
      await axios.post('https://fcm.googleapis.com/fcm/send', {
        to: tokenFcm,
        notification: { title: titulo, body: cuerpo }
      }, { headers: { 'Authorization': 'key=' + serverKey, 'Content-Type': 'application/json' } });
    } catch {}
  }

  async enviarPushAUsuarios(userIds: string[], titulo: string, cuerpo: string): Promise<void> {
    try {
      const serverKey = await this.getConfig('firebase_key');
      if (!serverKey) return;
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
