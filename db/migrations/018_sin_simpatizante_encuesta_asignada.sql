-- Elimina el campo simpatizante (la división de tablas ya cubre ese rol)
ALTER TABLE ciudadanos DROP COLUMN IF EXISTS simpatizante;
ALTER TABLE ciudadanos_comprometidos DROP COLUMN IF EXISTS simpatizante;

-- Encuesta asignada a un ciudadano (barrido inicial)
CREATE TABLE IF NOT EXISTS ciudadanos_encuestas (
  ciudadano_id UUID PRIMARY KEY REFERENCES ciudadanos(id) ON DELETE CASCADE,
  campana_id UUID NOT NULL REFERENCES campanas(id) ON DELETE CASCADE,
  asignada_por UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ciudadanos_encuestas_campana ON ciudadanos_encuestas(campana_id);