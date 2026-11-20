-- 033_solicitudes_reseteo.sql
-- Solicitudes de restablecimiento de contraseña persistentes.
-- Permiten que el administrador/coordinador las vea aunque no estuviera
-- conectado cuando el usuario las envió.

CREATE TABLE IF NOT EXISTS solicitudes_reseteo (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario_id   uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    email        varchar(255) NOT NULL,
    estado       varchar(20) NOT NULL DEFAULT 'pendiente',
    creada_en    timestamptz NOT NULL DEFAULT now(),
    atendida_en  timestamptz,
    atendida_por uuid REFERENCES usuarios(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_solicitudes_reseteo_pendientes
    ON solicitudes_reseteo (estado, creada_en);

CREATE INDEX IF NOT EXISTS idx_solicitudes_reseteo_usuario
    ON solicitudes_reseteo (usuario_id, estado);
