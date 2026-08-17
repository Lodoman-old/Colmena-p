-- El trigger legacy validar_gps_modo_mapeo/trg_validar_gps (tabla "sectores"
-- inexistente) fue eliminado en 019; el frontend exige GPS o foto de evidencia.

CREATE OR REPLACE FUNCTION generar_geofences_evento()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.ubicacion IS NOT NULL AND NEW.radio_geocerca IS NOT NULL THEN
        INSERT INTO geofences (evento_id, nombre, descripcion, ubicacion, radio_metros, tipo)
        VALUES (
            NEW.id,
            NEW.nombre || ' - Geofence',
            'Geofence automático generado para evento: ' || NEW.nombre,
            NEW.ubicacion,
            NEW.radio_geocerca,
            'circular'
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_generar_geofences_evento ON eventos;
CREATE TRIGGER trg_generar_geofences_evento
    AFTER INSERT ON eventos
    FOR EACH ROW EXECUTE FUNCTION generar_geofences_evento();

CREATE OR REPLACE FUNCTION detectar_ciudadanos_en_geocerca()
RETURNS TRIGGER AS $$
DECLARE
    ciudadano_record RECORD;
BEGIN
    FOR ciudadano_record IN
        SELECT c.id, c.telefono, c.nombre, g.id as geofence_id, g.evento_id
        FROM ciudadanos c
        JOIN geofences g ON g.activo = TRUE
        WHERE ST_DWithin(c.ubicacion, g.ubicacion, g.radio_metros)
        AND c.id = NEW.id
        AND c.telefono IS NOT NULL AND c.telefono <> ''
        AND NOT EXISTS (
            SELECT 1 FROM alertas_whatsapp a
            WHERE a.ciudadano_id = c.id
            AND a.geofence_id = g.id
            AND a.timestamp_deteccion > NOW() - INTERVAL '24 hours'
        )
    LOOP
        INSERT INTO alertas_whatsapp (ciudadano_id, geofence_id, evento_id, telefono_ciudadano, mensaje_enviado)
        VALUES (
            ciudadano_record.id,
            ciudadano_record.geofence_id,
            ciudadano_record.evento_id,
            ciudadano_record.telefono,
            'Alerta: ' || ciudadano_record.nombre || ' detectado en área de evento'
        );
    END LOOP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_detectar_ciudadanos_geocerca ON ciudadanos;
CREATE TRIGGER trg_detectar_ciudadanos_geocerca
    AFTER INSERT OR UPDATE OF ubicacion ON ciudadanos
    FOR EACH ROW
    WHEN (NEW.ubicacion IS NOT NULL)
    EXECUTE FUNCTION detectar_ciudadanos_en_geocerca();
