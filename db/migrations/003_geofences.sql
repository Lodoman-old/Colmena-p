CREATE TABLE IF NOT EXISTS geofences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evento_id UUID REFERENCES eventos(id) ON DELETE CASCADE,
    nombre VARCHAR(200) NOT NULL,
    descripcion TEXT,
    ubicacion GEOMETRY(POINT, 4326) NOT NULL,
    radio_metros INTEGER NOT NULL CHECK (radio_metros > 0),
    tipo VARCHAR(50) NOT NULL CHECK (tipo IN ('circular', 'poligonal')),
    poligono GEOMETRY(POLYGON, 4326),
    activo BOOLEAN DEFAULT TRUE,
    creado_en TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_geofences_ubicacion
    ON geofences USING GIST (ubicacion);
CREATE INDEX IF NOT EXISTS idx_geofences_evento
    ON geofences (evento_id);
CREATE INDEX IF NOT EXISTS idx_geofences_activo
    ON geofences (activo) WHERE activo = TRUE;
