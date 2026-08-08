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
  ubicacion: { lat: number; lng: number };
  radio_geocerca: number;
  seccion_id: string;
  creado_por: string;
}

export interface Geocerca {
  id: string;
  evento_id: string;
  nombre: string;
  descripcion: string;
  ubicacion: { lat: number; lng: number };
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

export class EventService {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async crearEventoConGeocerca(input: EventoInput): Promise<Evento> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `INSERT INTO eventos (nombre, descripcion, fecha_inicio, fecha_fin,
          ubicacion, radio_geocerca, seccion_id, creado_por)
         VALUES ($1, $2, $3, $4,
           ST_SetSRID(ST_MakePoint($5, $6), 4326), $7, $8, $9)
         RETURNING id, nombre, descripcion, fecha_inicio, fecha_fin,
           ST_X(ubicacion::geometry) as lng, ST_Y(ubicacion::geometry) as lat,
           radio_geocerca, seccion_id, creado_por`,
        [
          input.nombre,
          input.descripcion || '',
          input.fecha_inicio,
          input.fecha_fin,
          input.lng, input.lat,
          input.radio_geocerca,
           input.seccion_id,
          input.creado_por
        ]
      );

      await client.query('COMMIT');

      const row = result.rows[0];
      return {
        id: row.id,
        nombre: row.nombre,
        descripcion: row.descripcion,
        fecha_inicio: row.fecha_inicio,
        fecha_fin: row.fecha_fin,
        ubicacion: { lat: row.lat, lng: row.lng },
        radio_geocerca: row.radio_geocerca,
        seccion_id: row.seccion_id,
        creado_por: row.creado_por
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async ciudadanosEnRadio(eventoId: string): Promise<CiudadanoEnRadio[]> {
    const result = await this.pool.query(
      `SELECT
        c.id as ciudadano_id,
        c.nombre,
        c.telefono,
        ST_Distance(c.ubicacion::geometry, e.ubicacion::geometry) as distancia_metros,
        c.simpatizante as es_simpatizante,
        g.id as geocerca_id,
        g.nombre as geocerca_nombre
      FROM eventos e
      JOIN geofences g ON g.evento_id = e.id AND g.activo = TRUE
      JOIN ciudadanos c ON c.seccion_id = e.seccion_id
        AND ST_DWithin(c.ubicacion::geometry, e.ubicacion::geometry, e.radio_geocerca)
      WHERE e.id = $1
      ORDER BY distancia_metros ASC`,
      [eventoId]
    );

    return result.rows.map((row: any) => ({
      ciudadano_id: row.ciudadano_id,
      nombre: row.nombre,
      telefono: row.telefono,
      distancia_metros: Math.round(row.distancia_metros),
      es_simpatizante: row.es_simpatizante,
      geocerca_id: row.geocerca_id,
      geocerca_nombre: row.geocerca_nombre
    }));
  }

  async alertasPendientesEnvio(limite: number = 50): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT a.*, c.nombre as ciudadano_nombre, c.telefono,
        g.nombre as geocerca_nombre, e.nombre as evento_nombre
      FROM alertas_whatsapp a
      JOIN ciudadanos c ON c.id = a.ciudadano_id
      LEFT JOIN geofences g ON g.id = a.geofence_id
      LEFT JOIN eventos e ON e.id = COALESCE(a.evento_id, g.evento_id)
      WHERE a.enviado = FALSE
        AND a.retry_count < a.max_retries
      ORDER BY a.timestamp_deteccion ASC
      LIMIT $1`,
      [limite]
    );

    return result.rows;
  }

  async marcarAlertaEnviada(alertaId: string): Promise<void> {
    await this.pool.query(
      `UPDATE alertas_whatsapp
       SET enviado = TRUE, timestamp_envio = NOW()
       WHERE id = $1`,
      [alertaId]
    );
  }

  async incrementarReintento(alertaId: string): Promise<void> {
    await this.pool.query(
      `UPDATE alertas_whatsapp
       SET retry_count = retry_count + 1,
           error_envio = 'Reintento automático'
       WHERE id = $1`,
      [alertaId]
    );
  }

  async obtenerGeocercasActivas(sectorId?: string): Promise<Geocerca[]> {
    let query = `
      SELECT g.id, g.evento_id, g.nombre, g.descripcion,
             ST_X(g.ubicacion::geometry) as lng,
             ST_Y(g.ubicacion::geometry) as lat,
             g.radio_metros, g.tipo, g.activo, g.creado_en
      FROM geofences g
      WHERE g.activo = TRUE
        AND NOT EXISTS (SELECT 1 FROM eventos ev WHERE ev.id = g.evento_id AND ev.fecha_fin < NOW())
    `;
    const params: any[] = [];

    if (sectorId) {
      query += ` AND g.evento_id IN (SELECT id FROM eventos WHERE seccion_id = $1)`;
      params.push(sectorId);
    }

    query += ` ORDER BY g.creado_en DESC`;

    const result = await this.pool.query(query, params);
    return result.rows.map((row: any) => ({
      id: row.id,
      evento_id: row.evento_id,
      nombre: row.nombre,
      descripcion: row.descripcion,
      ubicacion: { lat: row.lat, lng: row.lng },
      radio_metros: row.radio_metros,
      tipo: row.tipo,
      activo: row.activo,
      creado_en: row.creado_en
    }));
  }

  async desactivarGeocerca(geocercaId: string): Promise<void> {
    await this.pool.query(
      `UPDATE geofences SET activo = FALSE WHERE id = $1`,
      [geocercaId]
    );
  }

  async proximidadCiudadano(
    ciudadanoId: string,
    geocercaId: string
  ): Promise<number | null> {
    const result = await this.pool.query(
      `SELECT ST_Distance(c.ubicacion::geometry, g.ubicacion::geometry) as distancia
       FROM ciudadanos c, geofences g
       WHERE c.id = $1 AND g.id = $2`,
      [ciudadanoId, geocercaId]
    );

    return result.rows.length > 0 ? Math.round(result.rows[0].distancia) : null;
  }
}
