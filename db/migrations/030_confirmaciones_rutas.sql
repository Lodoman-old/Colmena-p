-- 030: confirmaciones de simpatizantes en rutas + destino por filtro
-- Esta migracion era inline en index.ts y fallaba por deadlock.
ALTER TABLE ciudadanos_comprometidos ADD COLUMN IF NOT EXISTS estado_confirmacion VARCHAR(20);
ALTER TABLE ciudadanos_comprometidos ADD COLUMN IF NOT EXISTS ultima_confirmacion TIMESTAMPTZ;
ALTER TABLE rutas ADD COLUMN IF NOT EXISTS destino VARCHAR(15);
CREATE TABLE IF NOT EXISTS encuesta_respuestas_comp (
  id UUID PRIMARY KEY,
  ciudadano_id UUID REFERENCES ciudadanos_comprometidos(id) ON DELETE CASCADE,
  campana_id UUID REFERENCES campanas(id) ON DELETE CASCADE,
  pregunta_id UUID REFERENCES encuesta_preguntas(id) ON DELETE CASCADE,
  valor TEXT,
  usuario_id UUID REFERENCES usuarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ciudadano_id, pregunta_id)
);
