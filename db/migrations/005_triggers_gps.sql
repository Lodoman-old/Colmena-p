CREATE OR REPLACE FUNCTION validar_gps_modo_mapeo()
RETURNS TRIGGER AS $$
DECLARE
    sector_en_mapeo BOOLEAN;
    hogares_geo INTEGER;
    poblacion_total INTEGER;
BEGIN
    SELECT sg.hogares_georreferenciados, s.poblacion_total
    INTO hogares_geo, poblacion_total
    FROM sectores s
    LEFT JOIN (
        SELECT sector_id, COUNT(*) as hogares_georreferenciados
        FROM ciudadanos
        WHERE ubicacion IS NOT NULL
        GROUP BY sector_id
    ) sg ON s.id = sg.sector_id
    WHERE s.id = NEW.sector_id;

    IF poblacion_total IS NOT NULL AND poblacion_total > 0 THEN
        sector_en_mapeo := (COALESCE(hogares_geo, 0)::FLOAT / poblacion_total::FLOAT) < 0.70;

        IF sector_en_mapeo THEN
            IF NEW.ubicacion IS NULL OR
               ST_X(NEW.ubicacion) IS NULL OR
               ST_Y(NEW.ubicacion) IS NULL THEN
                RAISE EXCEPTION 'GPS_OBLIGATORIO: Debe capturar ubicación GPS para guardar este hogar en modo mapeo';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validar_gps_modo_mapeo ON ciudadanos;
CREATE TRIGGER trg_validar_gps_modo_mapeo
    BEFORE INSERT OR UPDATE ON ciudadanos
    FOR EACH ROW EXECUTE FUNCTION validar_gps_modo_mapeo();

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
