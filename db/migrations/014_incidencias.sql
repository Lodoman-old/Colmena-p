-- Incidencias de casilla reportadas por brigadas
CREATE TABLE IF NOT EXISTS incidencias (
  id bigserial PRIMARY KEY,
  casilla_id integer NOT NULL REFERENCES casillas(id) ON DELETE CASCADE,
  tipo varchar(50) NOT NULL,
  descripcion text NOT NULL,
  estado varchar(20) NOT NULL DEFAULT 'abierta',
  respuesta text,
  creado_por uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  resuelto_por uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  resuelto_en timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incidencias_estado_idx ON incidencias (estado);
CREATE INDEX IF NOT EXISTS incidencias_casilla_idx ON incidencias (casilla_id);