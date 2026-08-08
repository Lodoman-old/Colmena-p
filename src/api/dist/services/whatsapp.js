"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.WhatsAppService = void 0;
exports.setupWhatsApp = setupWhatsApp;
const twilio_1 = __importDefault(require("twilio"));
const pg_1 = require("pg");
class WhatsAppService {
    constructor() {
        this.client = (0, twilio_1.default)(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
        this.pool = new pg_1.Pool({
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT || '5432'),
            database: process.env.DB_NAME || 'colmena_db',
            user: process.env.DB_USER || 'postgres',
            password: process.env.DB_PASSWORD || 'password',
        });
    }
    async sendMessage(phone, message, options) {
        try {
            const result = await this.client.messages.create({
                body: message,
                to: `whatsapp:${phone.startsWith('+') ? phone : '+' + phone}`,
                from: process.env.TWILIO_WHATSAPP_NUMBER,
                ...options
            });
            await this.logMessage(phone, message, 'sent');
            return result;
        }
        catch (error) {
            console.error('Error sending WhatsApp message:', error);
            await this.logMessage(phone, message, 'failed');
            throw error;
        }
    }
    async sendCampaign(_eventoId, seccionId) {
        let query = `SELECT c.telefono, c.nombre FROM ciudadanos c WHERE c.telefono IS NOT NULL AND c.simpatizante = TRUE`;
        const params = [];
        if (seccionId) {
            query += ` AND c.seccion_id = $1`;
            params.push(seccionId);
        }
        const { rows } = await this.pool.query(query, params);
        let sent = 0;
        let failed = 0;
        for (const ciudadano of rows) {
            try {
                const mensaje = `¡Hola ${ciudadano.nombre}! Un evento importante está cerca de tu ubicación. ¡Inscríbete!`;
                await this.sendMessage(ciudadano.telefono, mensaje);
                sent++;
            }
            catch (error) {
                failed++;
            }
        }
        return { sent, failed };
    }
    async logMessage(phone, message, estado) {
        await this.pool.query('INSERT INTO alertas_whatsapp (ciudadano_id, telefono, mensaje_enviado, estado) VALUES ((SELECT id FROM ciudadanos WHERE telefono = $1), $1, $2, $3)', [phone, message, estado]);
    }
    async setupInbound(phoneNumber) {
        this.client.inboundMessages.create({
            phoneNumber
        });
    }
}
exports.WhatsAppService = WhatsAppService;
async function setupWhatsApp() {
    return new WhatsAppService();
}
//# sourceMappingURL=whatsapp.js.map