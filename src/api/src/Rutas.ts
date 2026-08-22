import axios from 'axios';
import { Pool } from 'pg';

const OSRM_BASE_URL = process.env.OSRM_URL || 'http://osrm:5000';

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

export class RoutingService {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  // Construye el WHERE dinámico para rutas por filtro sobre la tabla ciudadanos.
  // params debe contener ya los parámetros previos ($1 = seccion_id).
  construirWhereFiltros(filtros: FiltrosRuta, params: any[]): { sql: string; algunaCondicion: boolean } {
    const conds: string[] = [];
    if (filtros.sexo === 'H' || filtros.sexo === 'M') {
      params.push(filtros.sexo);
      conds.push(`c.sexo = $${params.length}`);
    }
    if (Array.isArray(filtros.discapacidad_ids) && filtros.discapacidad_ids.length) {
      params.push(filtros.discapacidad_ids.map((x: any) => parseInt(x)).filter((n: number) => !Number.isNaN(n)));
      conds.push(`c.discapacidad_id = ANY($${params.length})`);
    }
    if (Array.isArray(filtros.ocupacion_ids) && filtros.ocupacion_ids.length) {
      params.push(filtros.ocupacion_ids.map((x: any) => parseInt(x)).filter((n: number) => !Number.isNaN(n)));
      conds.push(`c.ocupacion_id = ANY($${params.length})`);
    }
    if (filtros.motivo_puerta_presente) {
      conds.push(`c.motivo_puerta IS NOT NULL`);
    }
    if (filtros.sin_intencion) {
      conds.push(`c.intencion_voto_presidente IS NULL`);
    }
    if (filtros.edad_max != null && !Number.isNaN(parseInt(String(filtros.edad_max)))) {
      params.push(parseInt(String(filtros.edad_max)));
      conds.push(`c.edad <= $${params.length}`);
    }
    if (filtros.indecisos_en_casa) {
      conds.push(`EXISTS (SELECT 1 FROM votantes_casa vch WHERE vch.ciudadano_id = c.id AND vch.pendiente = TRUE)`);
    }
    if (filtros.sin_visita_desde_dias != null && !Number.isNaN(parseInt(String(filtros.sin_visita_desde_dias))) && parseInt(String(filtros.sin_visita_desde_dias)) > 0) {
      params.push(parseInt(String(filtros.sin_visita_desde_dias)));
      conds.push(`NOT EXISTS (SELECT 1 FROM visitas vh WHERE vh.ciudadano_id = c.id AND vh.tipo = 'ruta' AND vh.created_at >= NOW() - ($${params.length} * INTERVAL '1 day'))`);
    }
    return { sql: conds.length ? ' AND ' + conds.join(' AND ') : '', algunaCondicion: conds.length > 0 };
  }

  async calcularRutaOptima(
    origen: Coordenada,
    seccionId: string,
    tipo: 'encuesta' | 'seguros' = 'encuesta',
    maxDistanciaKm: number = 25
  ): Promise<RutaOptimizada> {
    const paradas = await this.obtenerParadas(seccionId, tipo);
    const advertencias: string[] = [];

    if (paradas.length === 0) {
      return {
        paradas: [],
        distancia_total_km: 0,
        tiempo_total_minutos: 0,
        polyline: [],
        advertencias: ['No hay ciudadanos disponibles en este sector']
      };
    }

    const paradasConDistancia = await this.calcularDistancias(origen, paradas);
    const paradasFiltradas = paradasConDistancia.filter(
      p => p.distancia_desde_origen! <= maxDistanciaKm
    );

    if (paradasFiltradas.length !== paradasConDistancia.length) {
      advertencias.push(
        `${paradasConDistancia.length - paradasFiltradas.length} paradas exceden la distancia máxima de ${maxDistanciaKm}km`
      );
    }

    const ordenadas = await this.optimizarConOSRM(origen, paradasFiltradas);

    return {
      paradas: ordenadas.waypoints,
      distancia_total_km: Math.round(ordenadas.distancia_total_km * 100) / 100,
      tiempo_total_minutos: Math.round(ordenadas.tiempo_total_minutos),
      polyline: ordenadas.geometry,
      advertencias
    };
  }

  private async obtenerParadas(
    seccionId: string,
    tipo: 'encuesta' | 'seguros' | 'filtro',
    filtros?: FiltrosRuta
  ): Promise<Parada[]> {
    let query: string;
    const params: any[] = [seccionId];
    let filtrosSql = '';

    if (tipo === 'seguros') {
      query = `
        SELECT c.id, c.nombre, c.telefono,
               ST_X(c.ubicacion::geometry) as lng,
               ST_Y(c.ubicacion::geometry) as lat,
               true as es_simpatizante,
               0 as prioridad,
               c.calle, c.numero, c.colonia,
               (v.id IS NOT NULL) AS ya_voto
        FROM ciudadanos_comprometidos c
        LEFT JOIN votos v ON v.comprometido_id = c.id
        WHERE c.seccion_id = $1
          AND c.ubicacion IS NOT NULL
      `;
      query += ` ORDER BY c.nombre`;
    } else {
      // Ruta por filtro dirigida a los simpatizantes (voto seguro)
      if (tipo === 'filtro' && (filtros as any)?.destino === 'simpatizantes') {
        query = `
          SELECT c.id, c.nombre, c.telefono,
                 ST_X(c.ubicacion::geometry) as lng,
                 ST_Y(c.ubicacion::geometry) as lat,
                 true as es_simpatizante,
                 0 as prioridad,
                 c.calle, c.numero, c.colonia,
                 (v.id IS NOT NULL) AS ya_voto
          FROM ciudadanos_comprometidos c
          LEFT JOIN votos v ON v.comprometido_id = c.id
          WHERE c.seccion_id = $1
            AND c.ubicacion IS NOT NULL
        `;
        const svd = parseInt((filtros as any)?.sin_visita_desde_dias);
        if (!Number.isNaN(svd) && svd > 0) {
          params.push(svd);
          query += ` AND NOT EXISTS (SELECT 1 FROM visitas v2 WHERE v2.ciudadano_id = c.id AND v2.created_at > NOW() - ($${params.length} || ' days')::interval)`;
        }
        query += ` ORDER BY c.nombre`;
      } else {
      if (tipo === 'filtro' && filtros) {
        const w = this.construirWhereFiltros(filtros, params);
        filtrosSql = w.sql;
      }
      query = `
        SELECT c.id, c.nombre, c.telefono,
               ST_X(c.ubicacion::geometry) as lng,
               ST_Y(c.ubicacion::geometry) as lat,
               false as es_simpatizante,
               c.prioridad,
               c.calle, c.numero, c.colonia,
               (v.id IS NOT NULL) AS ya_voto
        FROM ciudadanos c
        LEFT JOIN votos v ON v.ciudadano_id = c.id
        WHERE c.seccion_id = $1
          AND c.ubicacion IS NOT NULL${filtrosSql}
      `;
      query += ` ORDER BY c.prioridad DESC, c.nombre`;
      }
    }

    const result = await this.pool.query(query, params);

    // Acompañantes en casa: para rutas por filtro se adjuntan con abreviatura
    // de partido para mostrarlos junto a cada parada.
    let vcPorCiudadano = new Map<string, any[]>();
    if (tipo === 'filtro' && result.rows.length) {
      const ids = result.rows.map((r: any) => r.id);
      try {
        const vcs = await this.pool.query(
          `SELECT v.ciudadano_id, v.nombre, v.pendiente,
                  pp.abreviatura AS pres_abbr, pd.abreviatura AS dip_abbr
           FROM votantes_casa v
           LEFT JOIN partidos_politicos pp ON pp.id = v.partido_id
           LEFT JOIN partidos_politicos pd ON pd.id = v.partido_diputado_id
           WHERE v.ciudadano_id = ANY($1::uuid[])`,
          [ids]
        );
        for (const v of vcs.rows) {
          const lista = vcPorCiudadano.get(v.ciudadano_id) || [];
          lista.push({
            nombre: v.nombre || null,
            pendiente: !!v.pendiente,
            pres: v.pres_abbr || null,
            dip: v.dip_abbr || null
          });
          vcPorCiudadano.set(v.ciudadano_id, lista);
        }
      } catch { /* sin acompañantes si falla la consulta auxiliar */ }
    }

    return result.rows.map((row: any) => ({
      id: row.id,
      nombre: row.nombre,
      telefono: row.telefono,
      ubicacion: { lat: row.lat, lng: row.lng },
      es_simpatizante: row.es_simpatizante,
      prioridad: row.prioridad,
      ya_voto: !!row.ya_voto,
      direccion: [row.calle, row.numero].filter(Boolean).join(' '),
      colonia: row.colonia,
      votantes_casa: vcPorCiudadano.get(row.id) || []
    }));
  }

  private async calcularDistancias(
    origen: Coordenada,
    paradas: Parada[]
  ): Promise<Parada[]> {
    const coordinates = paradas
      .map(p => `${p.ubicacion.lng},${p.ubicacion.lat}`)
      .join(';');

    const url = `${OSRM_BASE_URL}/table/v1/foot/${origen.lng},${origen.lat};${coordinates}`;

    try {
      const response = await axios.get(url, {
        params: { sources: '0', annotations: 'distance' }
      });

      if (response.data?.distances?.[0]) {
        return paradas.map((p, i) => ({
          ...p,
          distancia_desde_origen: Math.round(
            (response.data.distances[0][i + 1] || 0) / 1000
          )
        }));
      }
    } catch {
      return paradas.map(p => ({
        ...p,
        distancia_desde_origen: this.distanciaHaversine(origen, p.ubicacion)
      }));
    }

    return paradas;
  }

  async repartirRutas(
    seccionId: string,
    tipo: 'encuesta' | 'seguros' | 'filtro',
    numGrupos: number,
    filtros?: FiltrosRuta
  ): Promise<RutaOptimizada[]> {
    const paradas = await this.obtenerParadas(seccionId, tipo, filtros);
    if (!paradas.length || !numGrupos) return [];

    const centroid = await this.obtenerCentroideSeccion(seccionId);
    const origen = centroid || { lat: 20.6434, lng: -100.9929 };

    const conDistancia = await this.calcularDistancias(origen, paradas);
    conDistancia.sort((a, b) => (a.distancia_desde_origen || 0) - (b.distancia_desde_origen || 0));

    const grupos: Parada[][] = Array.from({ length: numGrupos }, () => []);
    conDistancia.forEach((p, i) => grupos[i % numGrupos].push(p));

    const rutas: RutaOptimizada[] = [];
    for (let g = 0; g < numGrupos; g++) {
      if (!grupos[g].length) {
        rutas.push({ paradas: [], distancia_total_km: 0, tiempo_total_minutos: 0, polyline: [], advertencias: ['Sin paradas asignadas'] });
        continue;
      }
      try {
        const ordenada = await this.optimizarConOSRM(origen, grupos[g]);
        rutas.push({
          paradas: ordenada.waypoints,
          distancia_total_km: ordenada.distancia_total_km,
          tiempo_total_minutos: ordenada.tiempo_total_minutos,
          polyline: ordenada.geometry,
          advertencias: []
        });
      } catch {
        rutas.push({ paradas: grupos[g], distancia_total_km: 0, tiempo_total_minutos: grupos[g].length * 10, polyline: [], advertencias: ['Error al optimizar'] });
      }
    }
    return rutas;
  }

  private async optimizarConOSRM(
    origen: Coordenada,
    paradas: Parada[]
  ): Promise<{
    waypoints: Parada[];
    distancia_total_km: number;
    tiempo_total_minutos: number;
    geometry: number[][];
  }> {
    if (paradas.length === 0) {
      return { waypoints: [], distancia_total_km: 0, tiempo_total_minutos: 0, geometry: [] };
    }

    try {
      const ordenIndices = await this.calcularOrdenTSP(paradas);
      const ordenadas = ordenIndices.map(i => paradas[i]);

      let geometry: number[][] = [];
      let distanciaTotal = 0;
      let duracionTotal = 0;

      try {
        const coordsOrdenadas = ordenadas
          .map(p => `${p.ubicacion.lng},${p.ubicacion.lat}`)
          .join(';');
        const routeUrl = `${OSRM_BASE_URL}/route/v1/foot/${coordsOrdenadas}`;
        const routeRes = await axios.get(routeUrl, {
          params: {
            overview: 'full',
            geometries: 'geojson',
            steps: 'false'
          }
        });
        const route = routeRes.data?.routes?.[0];
        if (route?.geometry?.coordinates) {
          geometry = route.geometry.coordinates.map(
            (c: number[]) => [c[1], c[0]]
          );
          distanciaTotal = route.distance || 0;
          duracionTotal = route.duration || 0;
        }
      } catch {
        geometry = [];
      }

      return {
        waypoints: ordenadas,
        distancia_total_km: Math.round(distanciaTotal / 1000),
        tiempo_total_minutos: Math.round(duracionTotal / 60),
        geometry
      };
    } catch {
      return {
        waypoints: paradas,
        distancia_total_km: paradas.reduce(
          (sum, p, i) =>
            sum + this.distanciaHaversine(
              i === 0 ? origen : paradas[i - 1].ubicacion,
              p.ubicacion
            ),
          0
        ),
        tiempo_total_minutos: Math.round(paradas.length * 10),
        geometry: []
      };
    }
  }

  private async calcularOrdenTSP(paradas: Parada[]): Promise<number[]> {
    const n = paradas.length;
    const coords = paradas
      .map(p => `${p.ubicacion.lng},${p.ubicacion.lat}`)
      .join(';');

    let matriz: number[][] = [];
    try {
      const response = await axios.get(`${OSRM_BASE_URL}/table/v1/foot/${coords}`, {
        params: { annotations: 'distance' }
      });
      const distances = response.data?.distances;
      if (distances?.length === n) {
        matriz = distances;
      }
    } catch {}

    const dist = (i: number, j: number): number => {
      if (matriz[i]?.[j] !== undefined && matriz[i]?.[j] !== null) return matriz[i][j];
      return this.distanciaHaversine(paradas[i].ubicacion, paradas[j].ubicacion) * 1000;
    };

    const totalDistancia = (orden: number[]): number => {
      let s = 0;
      for (let i = 0; i < orden.length - 1; i++) s += dist(orden[i], orden[i + 1]);
      return s;
    };

    const visitados = new Set<number>([0]);
    const orden: number[] = [0];
    while (orden.length < n) {
      const ultimo = orden[orden.length - 1];
      let mejor = -1;
      let mejorDist = Infinity;
      for (let i = 0; i < n; i++) {
        if (visitados.has(i)) continue;
        const d = dist(ultimo, i);
        if (d < mejorDist) {
          mejorDist = d;
          mejor = i;
        }
      }
      visitados.add(mejor);
      orden.push(mejor);
    }

    let mejorado = true;
    while (mejorado) {
      mejorado = false;
      for (let i = 1; i < n - 1; i++) {
        for (let k = i + 1; k < n; k++) {
          const antes = dist(orden[i - 1], orden[i]) + dist(orden[k], orden[(k + 1) % n]);
          const despues = dist(orden[i - 1], orden[k]) + dist(orden[i], orden[(k + 1) % n]);
          if (despues < antes) {
            const nuevo = [...orden];
            nuevo.splice(i, k - i + 1, ...orden.slice(i, k + 1).reverse());
            if (totalDistancia(nuevo) < totalDistancia(orden)) {
              orden.splice(i, k - i + 1, ...orden.slice(i, k + 1).reverse());
              mejorado = true;
            }
          }
        }
      }
    }

    return orden;
  }

  async obtenerCentroideSeccion(seccionId: string): Promise<Coordenada | null> {
    try {
      const res = await this.pool.query(`
        SELECT AVG(ST_X(ubicacion::geometry)) as lng, AVG(ST_Y(ubicacion::geometry)) as lat
        FROM ciudadanos WHERE seccion_id = $1 AND ubicacion IS NOT NULL
      `, [seccionId]);
      if (res.rows[0]?.lat && res.rows[0]?.lng) return { lat: parseFloat(res.rows[0].lat), lng: parseFloat(res.rows[0].lng) };
    } catch {}
    return null;
  }

  private distanciaHaversine(a: Coordenada, b: Coordenada): number {
    const R = 6371;
    const dLat = this.toRad(b.lat - a.lat);
    const dLon = this.toRad(b.lng - a.lng);
    const lat1 = this.toRad(a.lat);
    const lat2 = this.toRad(b.lat);

    const sinDLat = Math.sin(dLat / 2);
    const sinDLon = Math.sin(dLon / 2);
    const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;

    return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  private toRad(grados: number): number {
    return (grados * Math.PI) / 180;
  }
}
