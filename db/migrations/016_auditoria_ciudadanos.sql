-- 016_auditoria_ciudadanos.sql
-- Campos de auditoría: creador, fecha de creación y última edición para ciudadanos y comprometidos
ALTER TABLE ciudadanos ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE ciudadanos ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE ciudadanos ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE ciudadanos ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES usuarios(id) ON DELETE SET NULL;

ALTER TABLE ciudadanos_comprometidos ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE ciudadanos_comprometidos ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES usuarios(id) ON DELETE SET NULL;
ALTER TABLE ciudadanos_comprometidos ADD COLUMN IF NOT EXISTS updated_at timestamptz;
ALTER TABLE ciudadanos_comprometidos ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES usuarios(id) ON DELETE SET NULL;

-- Backfill: tomar las fechas de captura existentes y el usuario que capturó
UPDATE ciudadanos SET created_at = timestamp_registro WHERE created_at IS NULL;
UPDATE ciudadanos_comprometidos SET created_at = timestamp_registro WHERE created_at IS NULL;
UPDATE ciudadanos_comprometidos SET created_by = capturado_por WHERE created_by IS NULL;
