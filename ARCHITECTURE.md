# Sistema Colmena - Arquitectura de Software para Movilización Política PRI

## 1. Resumen Ejecutivo

Plataforma de alta disponibilidad y escalable para movilización política del PRI, diseñada para optimizar la gestión territorial y la coordinación de equipos de campo mediante tecnologías geoespaciales y de automatización de comms.

## 2. Identidad Visual y Branding

### Colores PRI (Primary)
- **Red PRI**: #EF3E18 (rojo institucional)
- **Blanco PRI**: #FFFFFF (blanco institucional)
- **Verde PRI**: #009639 (verde institucional)

### Principios de Diseño
- **Limpieza**: espacios simples, sin desorden visual
- **Usabilidad**: enfoque en trabajadores de campo con interfaces minimalistas
- **Consistencia**: diseño institucional mantenido en Web y App
- **Accesibilidad**: alto contraste y jerarquía visual clara

## 3. Arquitectura de Usuarios y Roles

### Administración (Web)
| Rol | Permisos | Acciones |
|------|----------|----------|
| **Administrador** | Total | Gestión usuarios, configuración sistema, reportes, gestión de territorios, configuración avanzada WhatsApp |

### Coordinador (Web/Móvil)
| Rol | Permisos | Acciones |
|------|----------|----------|
| **Coordinador** | Alto | Gestión de enlaces, asignación misiones, monitoreo en tiempo real, configuración de geocerracas, aprobación de datos |

### Operativo (App Móvil)
| Rol | Permisos | Acciones |
|------|----------|----------|
| **Enlace de Campo** | Básico | Captura hogares con GPS, envío de misiones, comunicación con supervisor, sync automático servidor |

## 4. Gestión de Territorio y Ciudadanos (Fase de Mapeo)

### Estados de Geolocalización por Sector
1. **Sin Datos**: Modo Mapeo activo
   - No disponible: mapa de calor, rutas optimizadas
   - Requerimiento: captura obligatoria de GPS en cada registro

2. **Transición** (>50% georreferenciado):
   - Funcionalidades limitadas habilitadas
   - Notificaciones para acelerar mapeo

3. **Completo** (>70% georreferenciado):
   - Todas las funciones habilitadas
   - Visualización completa de mapas y rutas

### Validación de GPS
```
if (sector.mapping_mode_active) {
    if (!GPS.latitude || !GPS.longitude) {
        reject_record("GPS obligatorio en modo mapeo");
        show_error("Debe capturar ubicación GPS para guardar este hogar");
    }
}
```

### Datos GeoEspaciales Requeridos por Sector
```sql
CREATE TABLE sectores_geometricos {
    id UUID PRIMARY KEY REFERENCES sectores(id),
    bounds GEOMETRY(POLYGON),           -- Contorno del sector
    centroid GEOMETRY(POINT),           -- Centroide del sector
    area_hectareas FLOAT,               -- Área en hectáreas
    tipo_uso_suelo VARCHAR(50),        -- Tipo de suelo (rural/urbano)
    asentamiento VARCHAR(100),         -- Tipo de asentamiento
    actualizado_en TIMESTAMP DEFAULT NOW()
};

-- Índice espacial para queries geográficas rápidas
CREATE INDEX idx_sectores_geometricos_bounds ON sectores_geometricos USING GIST (bounds);
CREATE INDEX idx_sectores_geometricos_centroid ON sectores_geometricos USING GIST (centroid);
```

## 5. Motor de Optimización de Rutas

### Motor de Enrutamiento
- **Tecnología**: OSRM (Open Source Routing Machine) o GraphHopper
- **Cobertura**: Todo México con redes actualizadas
- **API**: REST interface con cacheeo de resultados

### Algoritmo de Misión Diaria
```
input: ubicacion_actual, todas_visitables_puntos
output: mision_ordenada_list

mision = calcular_ruta_optima(
    ubicacion_actual,
    puntos_restantes,
    filtros: anuncios_hogares_simpatizantes,
    max_distancia: 25km,
    peso: eficiencia_tiempo
);

retornar(ordenar_por_distancia(mision));
```

### Pedidos de Trabajo Móviles
- Listas ordenadas de visitas
- Distancia estimada y tiempo
- Prioridad por simpatizante favorable
- Objetos de interés por zona

## 6. Automatización con API WhatsApp Twilio

### Gestión de Consentimiento
```sql
CREATE TABLE opt_in_consent {
    ciudadano_id UUID PRIMARY KEY,
    telefono VARCHAR(20) UNIQUE,
    opt_in_timestamp TIMESTAMP,
    canal VARCHAR(20) // 'sms', 'whatsapp'
};
```

### Tipos de Mensajes
1. **Perfil Simpatizante Favorable**
   - Bienvenida personalizada
   - Información de eventos próximos
   - Recordatorios de reuniones

2. **Alertas por Geocerca**
   - Si simpatizante favorable detectado en radio de proximidad
   - Mensaje automatizado con k-principal asignado
   - Tiempo real: <2 segundos entre detección y notificación

### Motor de Envío de Mensajes
```
if (es_nuevo_simpatizante) {
    enviar_bienvenida();
} else if (evento_geocerca_activo) {
    if (ciudadano_en_radio_proximidad) {
        if (ciudadano.favorable) {
            enviar_alerta_geocerca();
        }
    }
}
```

## 7. Modelo Entidad-Relación (PostgreSQL/PostGIS)

### Tablas Principales

#### Geofences (Áreas de Eventos)
```sql
CREATE TABLE geofences {
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    evento_id UUID REFERENCES eventos(id) ON DELETE CASCADE,
    nombre VARCHAR(200),
    descripcion TEXT,
    ubicacion GEOMETRY(POINT),
    radio_metros INTEGER,               -- Radio de detección
    tipo VARCHAR(50) CHECK (tipo IN ('circular', 'poligonal')),
    activo BOOLEAN DEFAULT TRUE,
    creado_en TIMESTAMP DEFAULT NOW()
};

-- Índice espacial para detección rápida de proximidad
CREATE INDEX idx_geofences_ubicacion ON geofences USING GIST (ubicacion);
```

#### Alertas WhatsApp
```sql
CREATE TABLE alertas_whatsapp {
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ciudadano_id UUID REFERENCES ciudadanos(id),
    geofence_id UUID REFERENCES geofences(id),
    mensaje_enviado TEXT,
    timestamp_envio TIMESTAMP,
    enviado BOOLEAN DEFAULT FALSE,
    retry_count INTEGER DEFAULT 0,
    CONSTRAINT chk_telefono CHECK (ciudadano_telefono ~ '^[0-9]{10}$')
};
```

### Restricciones de Geolocalización (FASE 2)

#### Validación de GPS Obligatoria en Modo Mapeo
```sql
-- Trigger para validar GPS en modo mapeo
CREATE OR REPLACE FUNCTION validar_gps_modo_mapeo()
RETURNS TRIGGER AS $
BEGIN
    -- Verificar si el sector está en modo mapeo
    DECLARE sector_en_mapeo BOOLEAN;
    BEGIN
        SELECT (hogares_georreferenciados / NULLIF(poblacion_total, 0)) < 0.70
        INTO sector_en_mapeo
        FROM sectores
        WHERE id = NEW.sector_id;

        IF sector_en_mapeo THEN
            IF NEW.ubicacion IS NULL OR
               ST_X(NEW.ubicacion) IS NULL OR
               ST_Y(NEW.ubicacion) IS NULL THEN
                RAISE EXCEPTION 'GPS obligatorio en modo mapeo. La ubicación es requerida para este sector.';
            END IF;

            -- Verificar precisión de GPS (mínimo 3 metros)
            DECLARE precision_gps DECIMAL;
            BEGIN
                SELECT ST_Distance(ubicacion, ST_MakePoint(NEW.ubicacion, NEW.ubicacion)) / 1000
                INTO precision_gps
                FROM ciudadanos
                WHERE id = NEW.id;

                IF precision_gps > 3.0 THEN
                    -- Agregar ruido aleatorio para protección
                    NEW.ubicacion = ST_Transform(ST_AddPoint(NEW.ubicacion, random() * 10 - 5, random() * 10 - 5), 4326);
                END IF;
            END;
        END IF;

        RETURN NEW;
    END;
END;
$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validar_gps_modo_mapeo
    BEFORE INSERT OR UPDATE ON ciudadanos
    FOR EACH ROW EXECUTE FUNCTION validar_gps_modo_mapeo();
```

#### Generación Automática de Geofences
```sql
-- Procedimiento para generar geofences a partir de eventos
CREATE OR REPLACE PROCEDURE generar_geofences_evento(p_evento_id UUID)
AS $$
DECLARE
    v_ubicacion POINT;
    v_radio INTEGER;
    v_nombre TEXT;
BEGIN
    -- Obtener detalles del evento
    SELECT ubicacion, radio_metros, nombre
    INTO v_ubicacion, v_radio, v_nombre
    FROM eventos
    WHERE id = p_evento_id;

    -- Insertar geofence circular
    INSERT INTO geofences (id, evento_id, nombre, descripcion, ubicacion, radio_metros, tipo)
    VALUES (
        gen_random_uuid(),
        p_evento_id,
        v_nombre || ' - Geofence',
        'Geofence automático generado para evento',
        v_ubicacion,
        v_radio,
        'circular'
    );
END;
$$ LANGUAGE plpgsql;
```

#### Índices de Detección de Geofences
```sql
-- Índice espacial para detección rápida de ciudadanos dentro de geofences
CREATE INDEX idx_geofences_ciudadanos_dentro ON alertas_whatsapp
    USING GIST (ubicacion) INCLUDE (ciudadano_id, geofence_id, timestamp_envio)
    WHERE enviado = FALSE;
```

### Tablas Principales

#### Usuarios
```sql
CREATE TABLE usuarios {
    id UUID PRIMARY KEY,
    nombre VARCHAR(100),
    apellido VARCHAR(100),
    telefono VARCHAR(20),
    email VARCHAR(255),
    rol VARCHAR(20), // 'admin', 'coordinador', 'enlace'
    sector_id UUID,
    activo BOOLEAN DEFAULT TRUE
};
```

#### Sectores
```sql
CREATE TABLE sectores {
    id UUID PRIMARY KEY,
    nombre VARCHAR(100) UNIQUE,
    municipio VARCHAR(100),
    estado VARCHAR(50),
    poblacion_total INTEGER,
    hogares_registrados INTEGER,
    hogares_georreferenciados INTEGER,
    bounds GEOMETRY(POLYGON)
};
```

#### Ciudadanos
```sql
CREATE TABLE ciudadanos {
    id UUID PRIMARY KEY,
    sector_id UUID,
    numero_hogar VARCHAR(20),
    nombre VARCHAR(100),
    telefono VARCHAR(20),
    fotografia TEXT,
    ubicacion GEOMETRY(POINT),
    timestamp_registro TIMESTAMP,
    metadata JSONB,
    CONSTRAINT chk_telefono CHECK (telefono ~ '^[0-9]{10}$')
};
```

#### Eventos
```sql
CREATE TABLE eventos {
    id UUID PRIMARY KEY,
    nombre VARCHAR(200),
    descripcion TEXT,
    fecha_inicio TIMESTAMP,
    fecha_fin TIMESTAMP,
    ubicacion GEOMETRY(POINT),
    radio_geocerca INTEGER, // en metros
    sector_id UUID,
    creado_por UUID
};
```

#### Alertas WhatsApp
```sql
CREATE TABLE alertas_whatsapp {
    id UUID PRIMARY KEY,
    ciudadano_id UUID,
    evento_id UUID,
    mensaje_enviado TEXT,
    timestamp_envio TIMESTAMP,
    enviado BOOLEAN DEFAULT FALSE,
    retry_count INTEGER DEFAULT 0
};
```

### Índices
```sql
CREATE INDEX idx_ciudadanos_ubicacion ON ciudadanos USING GIST (ubicacion);
CREATE INDEX idx_eventos_ubicacion ON eventos USING GIST (ubicacion);
CREATE INDEX idx_alertas_ciudadano ON alertas_whatsapp (ciudadano_id);
```

## 8. Arquitectura de Integración

### Sincronización App-Servidor
```
App Móvil <-> API Gateway (Redis Cache) <-> Servidor Principal

(App Móvil)     (API Gateway)      (Servidor Principal)     (Cola WhatsApp)
   |                  |                  |                   |
   | capture_data ---->| sync_local -------> db_masters ------- queue_new
   |<-----------------|<------------------|------------------>|
   | load_mission ---->| get_current_mission|<-- queue_processed --|
```

### Servicios Asíncronos
- **Cola de WhatsApp**: RabbitMQ/Kafka para envío masivo
- **Cola de Tareas**: Celery/Beat scheduler para recados periódicos
- **Webhooks**: Eventos de terceros (Twilio, mapas)

### API Gateway
- Autenticación JWT + Rate Limiting
- SSL/TLS con mTLS entre servicios
- Reescritura de URLs para cacheeo

### Esquema de Sincronización
1. Enlace captura hogar con GPS ✅
2. App sincroniza con API Gateway (con retry exponencial)
3. API valida GPS en modo mapeo
4. Datos marcan fila como 'pendiente_aprobacion'
5. Coordinador valida y aprueba
6. Si favorable, envía a cola de WhatsApp

## 9. Plan de Seguridad

### Protección de Datos Personales
1. **Registros Maestros**
   - Ciudadanos: Censo Protección Datos (PDPA)
   - Campo mínimo obligatorio: teléfono, ubicación geoclimática (sin GPS preciso)
   - Retención: 5 años (salvo renuncia expresa)

2. **Cifrado**
   - En tránsito: TLS 1.3 con certificación FIPS
   - En reposo: AES-256 con key management servicio

3. **Control de Acceso**
   - Jerarquía RBAC basada en roles
   - Autenticación MFA para coordinadores/administradores
   - Auditoría de cambios con timestamps

4. **Cumplimiento Normativo**
   - Artículos 6, 7 y 10 GDPR mexicano
   - Consentimiento explícito para cada comunicación
   - Derecho al olvido implementado con eliminación masiva segura

5. **Geolocalización**
   - Límites de precisión de GPS: 3 metros
   - Ruido aleatorio aumentado para protección de ubicación de ciudadanos
   - Solo alta precisión para validaciones operativas (no para perfilado)

## 10. Pilares Técnicos

### Tecnologías Requeridas
- **Base de Datos**: PostgreSQL 15+ con PostGIS
- **Sincronización**: WebSocket + Polling con backoff exponencial
- **Rutas**: OSRM 5.x con caché local TileServer
- **WhatsApp**: Twilio API v2024+
- **Monitorización**: Prometheus + Grafana
- **Contenedores**: Docker Swarm/K3s
- **Redes**: VPC aislada con IPSec

### Escalabilidad
- Estado: Apunto horizontal con Redis
- Base de datos: Read replicas para queries
- Colas: Particionadas para envío masivo
- Cache: CDN edge para assets estáticos

### Métricas de Operación
- Latencia de la app: <500ms
- Disponibilidad objetivo: 99.9%
- Tiempo de recuperación de fallos: <30 segundos
- Reporte de incidentes: SLA integrado

## 11. Plan de Implementación

### Fase 1: Fundamentos (3 meses)
- Infraestructura básica y base de datos
- Gestión de usuarios básica
- Sincronización móvil esencial

### Fase 2: Georreferenciación (4 meses)
- Validación de GPS obligatoria
- Visualización de sector
- Cálculo básico de distancia

### Fase 3: Optimización (3 meses)
- Motor de rutas optimizadas
- Priorización de misiones
- Alertas por geocerca

### Fase 4: Automatización (2 meses)
-Integración completa de WhatsApp
- Monitoreo en tiempo real
- Reportes avanzados

### Fase 5: Producción (1 mes)
- Auditoría de seguridad
- Pruebas de carga
- Documentación y capacitación

## 12. Presupuesto de CapEx vs OpEx

### CapEx (Inicial)
- Servidores: $50,000 MXN/mes
- Licencias: $20,000 MXN/mes
- API OSRM: $10,000 MXN/mes
- Twilio: $15,000 MXN/mes

### OpEx (Mensual)
- Mantenimiento: $30,000 MXN/mes
- Soporte: $25,000 MXN/mes
- Actualización: $15,000 MXN/mes

### ROI Proyectado
- Reducción de 40% en visitas no optimizadas
- Aumento del 25% en captación de simpatizantes
- Reducción del 30% en costos operativos