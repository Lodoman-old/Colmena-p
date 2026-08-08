import { Pool } from 'pg';
export interface Coordenada {
    lat: number;
    lng: number;
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
}
export interface RutaOptimizada {
    paradas: Parada[];
    distancia_total_km: number;
    tiempo_total_minutos: number;
    polyline: number[][];
    advertencias: string[];
}
export declare class RoutingService {
    private pool;
    constructor(pool: Pool);
    calcularRutaOptima(origen: Coordenada, seccionId: string, soloSimpatizantes?: boolean, maxDistanciaKm?: number): Promise<RutaOptimizada>;
    private obtenerParadas;
    private calcularDistancias;
    repartirRutas(seccionId: string, soloSimpatizantes: boolean, numGrupos: number): Promise<RutaOptimizada[]>;
    private optimizarConOSRM;
    private calcularOrdenTSP;
    obtenerCentroideSeccion(seccionId: string): Promise<Coordenada | null>;
    private distanciaHaversine;
    private toRad;
}
//# sourceMappingURL=Rutas.d.ts.map