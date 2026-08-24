-- Rutas de encuesta crean paradas sinteticas (no existen en ciudadanos).
-- Drop FK constraints para que encuesta_respuestas y visitas no fallen
-- al recibir IDs de paradas sinteticas.
ALTER TABLE encuesta_respuestas DROP CONSTRAINT IF EXISTS encuesta_respuestas_ciudadano_id_fkey;
ALTER TABLE visitas DROP CONSTRAINT IF EXISTS visitas_ciudadano_id_fkey;
