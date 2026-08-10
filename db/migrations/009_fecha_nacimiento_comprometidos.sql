-- Fecha de nacimiento para ciudadanos seguros (complemento de edad)
ALTER TABLE ciudadanos_comprometidos ADD COLUMN IF NOT EXISTS fecha_nacimiento date;
CREATE INDEX IF NOT EXISTS idx_comprometidos_curp ON ciudadanos_comprometidos (curp) WHERE curp IS NOT NULL;
