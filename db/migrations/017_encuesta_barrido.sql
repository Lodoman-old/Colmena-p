-- Encuesta de barrido inicial: una sola campaña marcada como encuesta del barrido
ALTER TABLE campanas ADD COLUMN IF NOT EXISTS encuesta_barrido BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS uq_campanas_encuesta_barrido ON campanas (encuesta_barrido) WHERE encuesta_barrido = TRUE;
