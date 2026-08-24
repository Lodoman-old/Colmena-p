-- 029: agregar apellido_paterno/apellido_materno a ciudadanos y comprometidos
-- Estas columnas faltaban en la migracion 008 original y en el schema de ciudadanos.
-- El API las usa para INSERT/SELECT pero solo las creaba inline (frágil).
ALTER TABLE ciudadanos ADD COLUMN IF NOT EXISTS apellido_paterno VARCHAR(100);
ALTER TABLE ciudadanos ADD COLUMN IF NOT EXISTS apellido_materno VARCHAR(100);
ALTER TABLE ciudadanos_comprometidos ADD COLUMN IF NOT EXISTS apellido_paterno VARCHAR(100);
ALTER TABLE ciudadanos_comprometidos ADD COLUMN IF NOT EXISTS apellido_materno VARCHAR(100);
