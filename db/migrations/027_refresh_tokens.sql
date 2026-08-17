-- Refresh tokens para sesion persistente (APK con biometria: 90 dias sin login)
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id bigserial PRIMARY KEY,
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  creado_en timestamptz NOT NULL DEFAULT now(),
  expira_en timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS refresh_tokens_usuario_idx ON refresh_tokens (usuario_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_hash_idx ON refresh_tokens (token_hash);