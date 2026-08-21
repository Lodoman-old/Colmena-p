import { Pool } from 'pg';
export declare class NotificacionService {
    private pool;
    private _fcmToken;
    constructor(pool: Pool);
    private getConfig;
    private obtenerAccessTokenFCM;
    enviarPush(tokenFcm: string, titulo: string, cuerpo: string): Promise<void>;
    enviarPushAUsuarios(userIds: string[], titulo: string, cuerpo: string): Promise<void>;
    enviarWhatsApp(telefono: string, mensaje: string): Promise<void>;
}
//# sourceMappingURL=Notificaciones.d.ts.map