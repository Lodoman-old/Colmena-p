-- ============================================================
-- 019: Elimina triggers legacy "modo mapeo" (tabla sectores inexistente)
--      El frontend ya exige GPS o foto de evidencia al guardar.
-- ============================================================

DROP TRIGGER IF EXISTS trg_validar_gps_modo_mapeo ON ciudadanos;
DROP TRIGGER IF EXISTS trg_validar_gps ON ciudadanos;
DROP FUNCTION IF EXISTS validar_gps_modo_mapeo();