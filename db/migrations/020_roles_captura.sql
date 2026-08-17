-- 020: roles nuevos (capturista, seccional, representante) + simpatizante simplificado
-- Quita prioridad y nivel de compromiso; agrega vigencia INE y permiso de corrección;
-- relaciona seccionales con sus capturistas y define metas de captura.

ALTER TABLE usuarios DROP CONSTRAINT IF EXISTS usuarios_rol_check;
ALTER TABLE usuarios ADD CONSTRAINT usuarios_rol_check CHECK (rol IN ('admin','coordinador','enlace','capturista','seccional','representante'));

ALTER TABLE ciudadanos_comprometidos DROP COLUMN IF EXISTS prioridad;
ALTER TABLE ciudadanos_comprometidos DROP COLUMN IF EXISTS nivel_compromiso;
ALTER TABLE ciudadanos_comprometidos ADD COLUMN IF NOT EXISTS vigencia_ine date;
ALTER TABLE ciudadanos_comprometidos ADD COLUMN IF NOT EXISTS correccion_solicitada_at timestamptz;
ALTER TABLE ciudadanos_comprometidos ADD COLUMN IF NOT EXISTS correccion_solicitada_by uuid REFERENCES usuarios(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS seccional_capturistas (
    seccional_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    capturista_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    PRIMARY KEY (seccional_id, capturista_id)
);

CREATE TABLE IF NOT EXISTS metas_captura (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    capturista_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    meta integer NOT NULL DEFAULT 0,
    created_by uuid REFERENCES usuarios(id) ON DELETE SET NULL,
    updated_by uuid REFERENCES usuarios(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_metas_captura_capturista ON metas_captura (capturista_id);