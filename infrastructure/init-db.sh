#!/bin/bash
set -e

echo "=== CREANDO ESQUEMA COLMENA - Estado > Municipio > Seccion > Ciudadano ==="

ADMIN_PASS="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 14)"
if [ -z "$ADMIN_PASS" ]; then ADMIN_PASS="Colmena2026!"; fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE EXTENSION IF NOT EXISTS postgis_topology;
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS estados (
        id INTEGER PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        abreviatura VARCHAR(10),
        es_default BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS municipios (
        id INTEGER PRIMARY KEY,
        estado_id INTEGER NOT NULL REFERENCES estados(id),
        nombre VARCHAR(150) NOT NULL,
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        es_default BOOLEAN NOT NULL DEFAULT FALSE,
        UNIQUE(estado_id, nombre)
    );

    CREATE TABLE IF NOT EXISTS secciones_electorales (
        id INTEGER PRIMARY KEY,
        municipio_id INTEGER NOT NULL REFERENCES municipios(id),
        tipo VARCHAR(20) DEFAULT 'urbana'
    );

    CREATE TABLE IF NOT EXISTS seccion_geo (
        id_gid integer PRIMARY KEY,
        id numeric(32,10),
        entidad numeric(11,0),
        distrito numeric(11,0),
        distrito_l numeric(11,0),
        municipio numeric(11,0),
        seccion numeric(11,0),
        tipo numeric(11,0),
        control numeric(32,10),
        geometry1_ character varying(15),
        geom geometry(MultiPolygon,4326)
    );
    CREATE INDEX IF NOT EXISTS seccion_geo_geom_geom_idx ON seccion_geo USING GIST (geom);

    CREATE TABLE IF NOT EXISTS partidos_politicos (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(100) NOT NULL,
        abreviatura VARCHAR(20) NOT NULL,
        color VARCHAR(7) DEFAULT '#999999'
    );

    CREATE TABLE IF NOT EXISTS ciudadanos (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        seccion_id INTEGER NOT NULL REFERENCES secciones_electorales(id),
        numero_hogar VARCHAR(20),
        nombre VARCHAR(100) NOT NULL,
        telefono VARCHAR(20),
        calle VARCHAR(150),
        numero VARCHAR(20),
        colonia VARCHAR(100),
        cp VARCHAR(5),
        ubicacion GEOMETRY(POINT, 4326),
        simpatizante BOOLEAN DEFAULT FALSE,
        prioridad INTEGER DEFAULT 0,
        intencion_voto INTEGER REFERENCES partidos_politicos(id),
        edad INTEGER,
        notas TEXT,
        timestamp_registro TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS filtros_campana (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nombre VARCHAR(100) NOT NULL,
        campo_bd VARCHAR(100) NOT NULL,
        tipo_input VARCHAR(20) NOT NULL,
        operador_sql VARCHAR(20) NOT NULL,
        opciones JSONB,
        activo BOOLEAN DEFAULT TRUE,
        orden INT DEFAULT 0,
        creado_en TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS usuarios (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nombre VARCHAR(100) NOT NULL,
        email VARCHAR(255) UNIQUE,
        username VARCHAR(100) UNIQUE,
        password_hash VARCHAR(255),
        telefono VARCHAR(20) DEFAULT '',
        rol VARCHAR(20) NOT NULL CHECK (rol IN ('admin', 'coordinador', 'enlace')),
        municipio_id INTEGER REFERENCES municipios(id)
    );

    CREATE TABLE IF NOT EXISTS usuarios_secciones (
        usuario_id UUID REFERENCES usuarios(id) ON DELETE CASCADE,
        seccion_id INTEGER REFERENCES secciones_electorales(id) ON DELETE CASCADE,
        PRIMARY KEY (usuario_id, seccion_id)
    );

    CREATE TABLE IF NOT EXISTS plantillas_whatsapp (
        id SERIAL PRIMARY KEY,
        nombre VARCHAR(200) NOT NULL,
        cuerpo TEXT NOT NULL DEFAULT '',
        creado_en TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS eventos (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nombre VARCHAR(200) NOT NULL,
        descripcion TEXT,
        fecha_inicio TIMESTAMPTZ,
        fecha_fin TIMESTAMPTZ,
        ubicacion GEOMETRY(POINT, 4326),
        radio_geocerca INTEGER DEFAULT 100,
        seccion_id INTEGER REFERENCES secciones_electorales(id),
        creado_por UUID REFERENCES usuarios(id),
        notificado_proximo BOOLEAN DEFAULT FALSE,
        plantilla_id INTEGER REFERENCES plantillas_whatsapp(id),
        alertar_config JSONB DEFAULT '[]',
        alertar_enviados JSONB DEFAULT '[]',
        alertar_solo_simpatizantes BOOLEAN DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS geofences (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        evento_id UUID REFERENCES eventos(id) ON DELETE CASCADE,
        nombre VARCHAR(200) NOT NULL,
        descripcion TEXT,
        ubicacion GEOMETRY(POINT, 4326) NOT NULL,
        radio_metros INTEGER NOT NULL CHECK (radio_metros > 0),
        tipo VARCHAR(50) NOT NULL CHECK (tipo IN ('circular', 'poligonal')),
        activo BOOLEAN DEFAULT TRUE,
        creado_en TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS alertas_whatsapp (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        ciudadano_id UUID NOT NULL REFERENCES ciudadanos(id) ON DELETE CASCADE,
        geofence_id UUID REFERENCES geofences(id) ON DELETE SET NULL,
        evento_id UUID REFERENCES eventos(id) ON DELETE SET NULL,
        telefono_ciudadano VARCHAR(20) NOT NULL,
        mensaje_enviado TEXT,
        timestamp_deteccion TIMESTAMP DEFAULT NOW(),
        timestamp_envio TIMESTAMP,
        enviado BOOLEAN DEFAULT FALSE,
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 3
    );

    CREATE INDEX IF NOT EXISTS idx_ciudadanos_seccion ON ciudadanos (seccion_id);
    CREATE INDEX IF NOT EXISTS idx_ciudadanos_ubicacion ON ciudadanos USING GIST (ubicacion);
    CREATE INDEX IF NOT EXISTS idx_municipios_estado ON municipios (estado_id);
    CREATE INDEX IF NOT EXISTS idx_secciones_municipio ON secciones_electorales (municipio_id);
    CREATE INDEX IF NOT EXISTS idx_eventos_seccion ON eventos (seccion_id);
    CREATE INDEX IF NOT EXISTS idx_geofences_ubicacion ON geofences USING GIST (ubicacion);
    CREATE TABLE IF NOT EXISTS casillas (
        id SERIAL PRIMARY KEY,
        seccion_id INTEGER NOT NULL REFERENCES secciones_electorales(id),
        nombre VARCHAR(50) NOT NULL,
        direccion TEXT DEFAULT '',
        UNIQUE(seccion_id, nombre)
    );

    CREATE TABLE IF NOT EXISTS resultados_casilla (
        id SERIAL PRIMARY KEY,
        casilla_id INTEGER NOT NULL REFERENCES casillas(id),
        partido_id INTEGER NOT NULL REFERENCES partidos_politicos(id),
        votos INTEGER NOT NULL DEFAULT 0,
        timestamp_registro TIMESTAMP DEFAULT NOW(),
        UNIQUE(casilla_id, partido_id)
    );

    CREATE INDEX IF NOT EXISTS idx_alertas_pendientes ON alertas_whatsapp (enviado, retry_count) WHERE enviado = FALSE AND retry_count < max_retries;

    CREATE TABLE IF NOT EXISTS configuracion (
        id SERIAL PRIMARY KEY,
        clave VARCHAR(100) UNIQUE NOT NULL,
        valor TEXT NOT NULL DEFAULT '',
        descripcion VARCHAR(255)
    );

    CREATE TABLE IF NOT EXISTS dispositivos (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        token_fcm TEXT NOT NULL,
        plataforma VARCHAR(20) DEFAULT 'android',
        actualizado_en TIMESTAMP DEFAULT NOW(),
        UNIQUE(usuario_id, token_fcm)
    );

    CREATE TABLE IF NOT EXISTS rutas (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_id UUID NOT NULL REFERENCES usuarios(id),
        enlace_id UUID NOT NULL REFERENCES usuarios(id),
        seccion_id INTEGER NOT NULL REFERENCES secciones_electorales(id),
        solo_simpatizantes BOOLEAN DEFAULT FALSE,
        paradas JSONB NOT NULL DEFAULT '[]',
        distancia_total_km DECIMAL(10,2) DEFAULT 0,
        tiempo_total_minutos INTEGER DEFAULT 0,
        estado VARCHAR(20) NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','en_progreso','completada')),
        completado_en TIMESTAMP,
        creado_en TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rutas_enlace ON rutas (enlace_id, estado);

    CREATE TABLE IF NOT EXISTS notificaciones (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        usuario_id UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
        tipo VARCHAR(50) NOT NULL,
        mensaje TEXT,
        leida BOOLEAN DEFAULT FALSE,
        creada_en TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS plantillas_mensaje (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nombre VARCHAR(200) NOT NULL,
        tipo VARCHAR(100) NOT NULL,
        cuerpo TEXT NOT NULL DEFAULT '',
        archivos JSONB NOT NULL DEFAULT '[]',
        creado_en TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS campanas (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        nombre VARCHAR(200) NOT NULL,
        plantilla_id UUID REFERENCES plantillas_mensaje(id),
        filtros JSONB NOT NULL DEFAULT '[]',
        scheduled_at TIMESTAMP,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        total_ciudadanos INTEGER DEFAULT 0,
        creado_en TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS ubicaciones_enlace (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES usuarios(id),
        lat DOUBLE PRECISION NOT NULL,
        lng DOUBLE PRECISION NOT NULL,
        precision DOUBLE PRECISION DEFAULT 0,
        creado_en TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ubicaciones_user ON ubicaciones_enlace(user_id);
    CREATE INDEX IF NOT EXISTS idx_ubicaciones_creado ON ubicaciones_enlace(creado_en);

    CREATE TABLE IF NOT EXISTS push_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES usuarios(id),
        endpoint TEXT NOT NULL,
        keys_auth TEXT NOT NULL,
        keys_p256dh TEXT NOT NULL,
        user_agent TEXT DEFAULT '',
        creado_en TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, endpoint)
    );

    ---- TRIGGERS ----

    CREATE OR REPLACE FUNCTION validar_gps_modo_mapeo()
    RETURNS TRIGGER AS \$\$
    BEGIN
        IF NEW.ubicacion IS NULL OR ST_X(NEW.ubicacion) IS NULL OR ST_Y(NEW.ubicacion) IS NULL THEN
            RAISE EXCEPTION 'GPS_OBLIGATORIO: Debe capturar ubicacion GPS';
        END IF;
        RETURN NEW;
    END;
    \$\$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trg_validar_gps ON ciudadanos;
    CREATE TRIGGER trg_validar_gps BEFORE INSERT OR UPDATE ON ciudadanos FOR EACH ROW EXECUTE FUNCTION validar_gps_modo_mapeo();

    CREATE OR REPLACE FUNCTION generar_geofences_evento()
    RETURNS TRIGGER AS \$\$
    BEGIN
        IF NEW.ubicacion IS NOT NULL AND NEW.radio_geocerca IS NOT NULL THEN
            INSERT INTO geofences (evento_id, nombre, descripcion, ubicacion, radio_metros, tipo)
            VALUES (NEW.id, NEW.nombre || ' - Geofence', 'Geofence automatico para: ' || NEW.nombre, NEW.ubicacion, NEW.radio_geocerca, 'circular');
        END IF;
        RETURN NEW;
    END;
    \$\$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trg_generar_geofences_evento ON eventos;
    CREATE TRIGGER trg_generar_geofences_evento AFTER INSERT ON eventos FOR EACH ROW EXECUTE FUNCTION generar_geofences_evento();

    CREATE OR REPLACE FUNCTION actualizar_geofence_evento()
    RETURNS TRIGGER AS \$\$
    BEGIN
        IF OLD.ubicacion IS DISTINCT FROM NEW.ubicacion OR OLD.radio_geocerca IS DISTINCT FROM NEW.radio_geocerca THEN
            UPDATE geofences SET ubicacion = NEW.ubicacion, radio_metros = NEW.radio_geocerca WHERE evento_id = NEW.id;
        END IF;
        RETURN NEW;
    END;
    \$\$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trg_actualizar_geofence_evento ON eventos;
    CREATE TRIGGER trg_actualizar_geofence_evento AFTER UPDATE ON eventos FOR EACH ROW EXECUTE FUNCTION actualizar_geofence_evento();

    ---- SEED: ESTADOS (32) ----
    INSERT INTO estados (id, nombre, abreviatura, es_default) VALUES
        (1,'Aguascalientes','Ags',FALSE),(2,'Baja California','BC',FALSE),(3,'Baja California Sur','BCS',FALSE),
        (4,'Campeche','Camp',FALSE),(5,'Coahuila','Coah',FALSE),(6,'Colima','Col',FALSE),
        (7,'Chiapas','Chis',FALSE),(8,'Chihuahua','Chih',FALSE),(9,'Ciudad de Mexico','CDMX',FALSE),
        (10,'Durango','Dgo',FALSE),(11,'Guanajuato','Gto',TRUE),(12,'Guerrero','Gro',FALSE),
        (13,'Hidalgo','Hgo',FALSE),(14,'Jalisco','Jal',FALSE),(15,'Mexico','EdoMex',FALSE),
        (16,'Michoacan','Mich',FALSE),(17,'Morelos','Mor',FALSE),(18,'Nayarit','Nay',FALSE),
        (19,'Nuevo Leon','NL',FALSE),(20,'Oaxaca','Oax',FALSE),(21,'Puebla','Pue',FALSE),
        (22,'Queretaro','Qro',FALSE),(23,'Quintana Roo','QRoo',FALSE),(24,'San Luis Potosi','SLP',FALSE),
        (25,'Sinaloa','Sin',FALSE),(26,'Sonora','Son',FALSE),(27,'Tabasco','Tab',FALSE),
        (28,'Tamaulipas','Tamps',FALSE),(29,'Tlaxcala','Tlax',FALSE),(30,'Veracruz','Ver',FALSE),
        (31,'Yucatan','Yuc',FALSE),(32,'Zacatecas','Zac',FALSE)
    ON CONFLICT (id) DO NOTHING;

    ---- SEED: MUNICIPIOS DE GUANAJUATO (46) ----
    INSERT INTO municipios (id, estado_id, nombre, lat, lng, es_default) VALUES
        (11001,11,'Abasolo',20.4508,-101.5306,FALSE),(11002,11,'Acambaro',20.0342,-100.7272,FALSE),
        (11003,11,'San Miguel de Allende',20.9150,-100.7439,FALSE),(11004,11,'Apaseo el Alto',20.4583,-100.6222,FALSE),
        (11005,11,'Apaseo el Grande',20.5450,-100.6861,FALSE),(11006,11,'Atarjea',21.2689,-99.7186,FALSE),
        (11007,11,'Celaya',20.5217,-100.8156,FALSE),(11008,11,'Manuel Doblado',20.7286,-101.9486,FALSE),
        (11009,11,'Comonfort',20.7200,-100.7589,FALSE),(11010,11,'Coroneo',20.2014,-100.3644,FALSE),
        (11011,11,'Cortazar',20.3022,-100.9622,FALSE),(11012,11,'Cuaramaro',20.6261,-101.6744,FALSE),
        (11013,11,'Doctor Mora',21.1400,-100.3167,FALSE),(11014,11,'Dolores Hidalgo',21.1606,-100.9361,FALSE),
        (11015,11,'Guanajuato',21.0186,-101.2583,FALSE),(11016,11,'Huanimaro',20.3678,-101.4972,FALSE),
        (11017,11,'Irapuato',20.6767,-101.3567,FALSE),(11018,11,'Jaral del Progreso',20.3742,-101.0653,FALSE),
        (11019,11,'Jerecuaro',20.1500,-100.5083,FALSE),(11020,11,'Leon',21.1236,-101.6850,FALSE),
        (11021,11,'Moroleon',20.1250,-101.1917,FALSE),(11022,11,'Ocampo',21.6486,-101.4789,FALSE),
        (11023,11,'Penjamo',20.4306,-101.7228,FALSE),(11024,11,'Pueblo Nuevo',20.5250,-101.3708,FALSE),
        (11025,11,'Purisima del Rincon',21.0356,-101.8772,FALSE),(11026,11,'Romita',20.8700,-101.5167,FALSE),
        (11027,11,'Salamanca',20.5719,-101.1986,FALSE),(11028,11,'Salvatierra',20.2147,-100.8814,FALSE),
        (11029,11,'San Diego de la Union',21.4667,-100.8722,FALSE),(11030,11,'San Felipe',21.4794,-101.2139,FALSE),
        (11031,11,'San Francisco del Rincon',21.0250,-101.8583,FALSE),(11032,11,'San Jose Iturbide',21.0022,-100.3861,FALSE),
        (11033,11,'San Luis de la Paz',21.2986,-100.5167,FALSE),(11034,11,'Santa Catarina',21.1389,-100.0653,FALSE),
        (11035,11,'Santa Cruz de Juventino Rosas',20.6434,-100.9929,TRUE),
        (11036,11,'Santiago Maravatio',20.1742,-100.9908,FALSE),(11037,11,'Silao',20.9433,-101.4267,FALSE),
        (11038,11,'Tarandacuao',19.9931,-100.6683,FALSE),(11039,11,'Tarimoro',20.2869,-100.7558,FALSE),
        (11040,11,'Tierra Blanca',21.0994,-100.1581,FALSE),(11041,11,'Uriangato',20.1417,-101.1833,FALSE),
        (11042,11,'Valle de Santiago',20.3914,-101.1914,FALSE),(11043,11,'Victoria',21.2097,-100.2142,FALSE),
        (11044,11,'Villagran',20.5122,-100.9950,FALSE),(11045,11,'Xichu',21.2986,-99.9500,FALSE),
        (11046,11,'Yuriria',20.2167,-101.1267,FALSE)
    ON CONFLICT (id) DO NOTHING;

    ---- SEED: SECCIONES ELECTORALES (Santa Cruz de Juventino Rosas - 36 secciones INE) ----
    INSERT INTO secciones_electorales (id, municipio_id, tipo) VALUES
        (2608,11035,'urbana'),(2609,11035,'urbana'),(2610,11035,'urbana'),
        (2611,11035,'urbana'),(2612,11035,'urbana'),(2613,11035,'urbana'),
        (2614,11035,'urbana'),(2615,11035,'urbana'),(2616,11035,'urbana'),
        (2617,11035,'urbana'),(2618,11035,'urbana'),(2619,11035,'urbana'),
        (2620,11035,'urbana'),(2621,11035,'urbana'),(2622,11035,'urbana'),
        (2623,11035,'urbana'),(2624,11035,'urbana'),(2625,11035,'urbana'),
        (2626,11035,'urbana'),(2627,11035,'urbana'),(2628,11035,'urbana'),
        (2629,11035,'urbana'),(2630,11035,'urbana'),(2631,11035,'urbana'),
        (2632,11035,'urbana'),(2633,11035,'urbana'),(2634,11035,'urbana'),
        (2635,11035,'urbana'),(2636,11035,'urbana'),(2637,11035,'urbana'),
        (2638,11035,'urbana'),(2639,11035,'urbana'),(2640,11035,'urbana'),
        (2641,11035,'urbana'),(2642,11035,'urbana'),(2643,11035,'urbana')
    ON CONFLICT (id) DO NOTHING;

    ---- SEED: PARTIDOS POLITICOS ----
    INSERT INTO partidos_politicos (id, nombre, abreviatura, color) VALUES
        (1,'Partido Revolucionario Institucional','PRI','#CC0000'),
        (2,'Partido Acción Nacional','PAN','#0033CC'),
        (3,'Partido de la Revolución Democrática','PRD','#FFD700'),
        (4,'Movimiento Regeneración Nacional','MORENA','#8B0000'),
        (5,'Partido del Trabajo','PT','#B22222'),
        (6,'Partido Verde Ecologista de México','PVEM','#006400'),
        (7,'Movimiento Ciudadano','MC','#FF6600'),
        (8,'Nueva Alianza','NA','#00BFFF'),
        (9,'Independiente','IND','#888888')
    ON CONFLICT (id) DO NOTHING;
    SELECT setval('partidos_politicos_id_seq', (SELECT COALESCE(MAX(id),0) FROM partidos_politicos));

    ---- SEED: CASILLAS (una 'Basica' por seccion) ----
    INSERT INTO casillas (seccion_id, nombre) SELECT id, 'Básica' FROM secciones_electorales ON CONFLICT DO NOTHING;

    ---- SEED: USUARIOS (solo administrador, password aleatoria) ----
    INSERT INTO usuarios (id, nombre, email, password_hash, rol, municipio_id) VALUES
        ('b0000000-0000-0000-0000-000000000001', 'Administrador', 'admin@colmena.app', crypt('$ADMIN_PASS', gen_salt('bf', 10)), 'admin', NULL)
    ON CONFLICT (id) DO NOTHING;

    \echo '========================================================='
    \echo 'ADMIN_PASSWORD=$ADMIN_PASS'
    \echo 'login: admin@colmena.app'
    \echo '========================================================='

    ---- SEED: (sin datos de muestra: sin ciudadanos, sin eventos, sin resultados) ----

    \echo '=== Esquema COLMENA creado exitosamente ==='
EOSQL
