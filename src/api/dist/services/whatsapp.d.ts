export interface WhatsAppMessage {
    id?: string;
    ciudadano_id: string;
    evento_id: string;
    telefono: string;
    mensaje: string;
    estado: 'pending' | 'sent' | 'failed';
    timestamp?: Date;
    retry_count?: number;
}
export declare class WhatsAppService {
    private client;
    private pool;
    constructor();
    sendMessage(phone: string, message: string, options?: any): Promise<any>;
    sendCampaign(_eventoId: string, seccionId?: number): Promise<{
        sent: number;
        failed: number;
    }>;
    logMessage(phone: string, message: string, estado: 'pending' | 'sent' | 'failed'): Promise<void>;
    setupInbound(phoneNumber: string): Promise<void>;
}
export declare function setupWhatsApp(): Promise<WhatsAppService>;
//# sourceMappingURL=whatsapp.d.ts.map