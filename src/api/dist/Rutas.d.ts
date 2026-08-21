import { Pool } from 'pg';
export interface Coordenada {
    lat: number;
    lng: number;
}
export interface VotanteCasaInfo {
    nombre?: string | null;
    pendiente: boolean;
    pres?: string | null;
    dip?: string | null;
}
export interface Parada {
    id: string;
    nombre: string;
    telefono: string;
    ubicacion: Coordenada;
    es_simpatizante: boolean;
    prioridad: number;
    distancia_desde_origen?: number;
    direccion?: string;
    colonia?: string;
    votantes_casa?: VotanteCasaInfo[];
}
export interface RutaOptimizada {
    paradas: Parada[];
    distancia_total_km: number;
    tiempo_total_minutos: number;
    polyline: number[][];
    advertencias: string[];
}
export interface FiltrosRuta {
    sexo?: string;
    discapacidad_ids?: number[];
    ocupacion_ids?: number[];
    motivo_puerta_presente?: boolean;
    sin_intencion?: boolean;
    edad_max?: number;
    indecisos_en_casa?: boolean;
    sin_visita_desde_dias?: number;
}
export declare class RoutingService {
    private pool;
    constructor(pool: Pool);
    construirWhereFiltros(filtros: FiltrosRuta, params: any[]): {
        sql: string;
        algunaCondicion: boolean;
    };
    calcularRutaOptima(origen: Coordenada, seccionId: string, tipo?: 'encuesta' | 'seguros', maxDistanciaKm?: number): Promise<RutaOptimizada>;
    private obtenerParadas;
    private calcularDistancias;
    repartirRutas(seccionId: string, tipo: 'encuesta' | 'seguros' | 'filtro', numGrupos: number, filtros?: FiltrosRuta): Promise<RutaOptimizada[]>;
    private optimizarConOSRM;
    private calcularOrdenTSP;
    obtenerCentroideSeccion(seccionId: string): Promise<Coordenada | null>;
    private distanciaHaversine;
    private toRad;
}
//# sourceMappingURL=Rutas.d.ts.map