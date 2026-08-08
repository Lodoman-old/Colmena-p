import { Pool } from 'pg';
export interface EventoInput {
    nombre: string;
    descripcion?: string;
    fecha_inicio: string;
    fecha_fin: string;
    lat: number;
    lng: number;
    radio_geocerca: number;
    seccion_id: string;
    creado_por: string;
}
export interface Evento {
    id: string;
    nombre: string;
    descripcion: string;
    fecha_inicio: Date;
    fecha_fin: Date;
    ubicacion: {
        lat: number;
        lng: number;
    };
    radio_geocerca: number;
    seccion_id: string;
    creado_por: string;
}
export interface Geocerca {
    id: string;
    evento_id: string;
    nombre: string;
    descripcion: string;
    ubicacion: {
        lat: number;
        lng: number;
    };
    radio_metros: number;
    tipo: string;
    activo: boolean;
    creado_en: Date;
}
export interface CiudadanoEnRadio {
    ciudadano_id: string;
    nombre: string;
    telefono: string;
    distancia_metros: number;
    es_simpatizante: boolean;
    geocerca_id: string;
    geocerca_nombre: string;
}
export declare class EventService {
    private pool;
    constructor(pool: Pool);
    crearEventoConGeocerca(input: EventoInput): Promise<Evento>;
    ciudadanosEnRadio(eventoId: string): Promise<CiudadanoEnRadio[]>;
    alertasPendientesEnvio(limite?: number): Promise<any[]>;
    marcarAlertaEnviada(alertaId: string): Promise<void>;
    incrementarReintento(alertaId: string): Promise<void>;
    obtenerGeocercasActivas(sectorId?: string): Promise<Geocerca[]>;
    desactivarGeocerca(geocercaId: string): Promise<void>;
    proximidadCiudadano(ciudadanoId: string, geocercaId: string): Promise<number | null>;
}
//# sourceMappingURL=Eventos.d.ts.map