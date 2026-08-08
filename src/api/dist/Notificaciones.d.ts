import { Pool } from 'pg';
export declare class NotificacionService {
    private pool;
    constructor(pool: Pool);
    private getConfig;
    enviarPush(tokenFcm: string, titulo: string, cuerpo: string): Promise<void>;
    enviarPushAUsuarios(userIds: string[], titulo: string, cuerpo: string): Promise<void>;
    enviarWhatsApp(telefono: string, mensaje: string): Promise<void>;
}
//# sourceMappingURL=Notificaciones.d.ts.map