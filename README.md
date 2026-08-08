# System Colmena - README

Este proyecto es el **Sistema Colmena**, una plataforma de movilización política del PRI con alta capacidad, diseñada para optimizar la gestión territorial y la coordinación de equipos de campo mediante tecnologías geoespaciales y de automatización de comunicaciones.

## Arquitectura General

### Fases

1. **Fase 1: Fundamentos** (Completada)
   - Configuración de infraestructura básica (Docker/K3s)
   - Configuración inicial de base de datos y datos maestros
   - Servidor API con endpoints esenciales
   - Autenticación JWT + sincronización móvil básica

2. **Fase 2: Georreferenciación** (Próximamente)
   - Validación obligatoria de GPS en modo mapeo
   - Cálculo de distancia entre hogares
   - Visualización básica de sector

3. **Fase 3: Optimización** (Próximamente)
   - Motor de rutas OSRM/GraphHopper
   - Misiones diarias optimizadas
   - Alertas por geocerca

4. **Fase 4: Automatización** (Próximamente)
   - Integración completa de WhatsApp
   - Monitoreo en tiempo real
   - Reportes avanzados

5. **Fase 5: Producción** (Próximamente)
   - Auditoría de seguridad
   - Pruebas de carga
   - Documentación y capacitación

## Tecnologías Principales

### Backend (Node.js)
- Express.js con middleware de seguridad
- PostgreSQL + PostGIS para almacenamiento geoespacial
- Socket.io para sincronización en tiempo real
- Redis para caché y respaldos
- Twilio API para automatización de WhatsApp

### Frontend (Móvil)
- React Native / Flutter (opción)
- Captura de GPS
- Visualización de misiones
- Sync offline

### DevOps
- Docker + K3s para contenedorización
- GitHub Actions para CI/CD
- Prometheus + Grafana para monitoreo

## Comenzando

### Prerrequisitos
- Docker ({latest})
- Node.js 18+
- PostgreSQL 15+

### Instalación Rápida

```bash
# Clonar repositorio
git clone https://github.com/tu-org/system-colmena.git

# Construir e iniciar contenedores
docker-compose -f infrastructure/docker-compose.yml up -d

# Ejecutar migraciones de base de datos (si es necesario)
docker exec colmena-api npm run build

# Iniciar servidor API (opcional - para desarrollo)
cd src/api && npm run dev
```

### Endpoints API (Fase 1)

| Endpoint | Método | Descripción |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/auth/login` | POST | Autenticación usuario |
| `/api/auth/logout` | POST | Cierre de sesión |
| `/api/users` | GET | Lista de usuarios activos |
| `/api/sectores` | GET | Lista de sectores |
| `/api/sync/mobile` | POST | Sincronización móvil esencial |

## Modelo de Datos

### Tablas Principales

#### Usuarios
```sql
CREATE TABLE usuarios {
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre VARCHAR(100) NOT NULL,
    apellido VARCHAR(100) NOT NULL,
    telefono VARCHAR(20),
    email VARCHAR(255) UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    rol VARCHAR(20) CHECK (rol IN ('admin', 'coordinador', 'enlace')),
    sector_asignado UUID,
    activo BOOLEAN DEFAULT TRUE,
    creado_en TIMESTAMP DEFAULT NOW()
};
```

#### Sectores
```sql
CREATE TABLE sectores {
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre VARCHAR(100) UNIQUE NOT NULL,
    municipio VARCHAR(100) NOT NULL,
    estado VARCHAR(50) NOT NULL,
    poblacion_estimada INTEGER,
    metadata JSONB,
    creado_en TIMESTAMP DEFAULT NOW()
};
```

#### Ciudadanos (Hogares)
```sql
CREATE TABLE ciudadanos {
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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

### Restricciones de Geolocalización

- **Modo Mapeo**: Modo para sectores sin coordenadas
- **Validación GPS**: Obligatoria al registrar hogares en modo mapeo
- **Umbral de Transición**: >70% de hogares georreferenciados para activar funciones avanzadas

## Configuración de Seguridad

### Control de Acceso

- **Autenticación**: JWT con MFA para coordinadores/administradores
- **Autorización**: Jerarquía basada en roles (admin > coordinador > enlace)
- **Auditoría**: Seguimiento de todos los cambios de datos

### Protección de Datos

- **En Tránsito**: TLS 1.3 con certificación FIPS
- **En Reposo**: Cifrado AES-256 con administración de claves
- **Retención**: 5 años para datos personales (salvo renuncia)

### Cumplimiento Normativo

- Artículos 6, 7 y 10 GDPR mexicano
- Consentimiento explícito para comunicaciones
- Derecho al olvido implementado con eliminación segura

## Privilegios por Rol

| Rol | Permisos |
|------|----------|
| **Administrador** | Total (Web) |
| **Coordinador** | Alto (Web/Móvil) |
| **Enlace de Campo** | Básico (App Móvil) |

### Administrador
- Gestión completa del sistema
- Gestión de usuarios y configuración avanzada
- Monitoreo de toda la organización

### Coordinador
- Gestión de enlaces y asignación de misiones
- Monitoreo en tiempo real
- Configuración de geocerracas
- Aprobación de datos

### Enlace de Campo
- Captura de hogares con GPS
- Envío de misiones
- Comunicación con supervisor
- Sync automático del servidor

## Configuración del Sistema

### Environment Variables

```env
# Base de Datos
DB_HOST=postgres
DB_PORT=5432
DB_USER=postgres
DB_PASSWORD=tu_contraseña_segura
DB_NAME=colmena_db

# JWT
JWT_SECRET=tu_clave_secreta_super_segura
a JWT_EXPIRES_IN=24h

# Twilio
TWILIO_ACCOUNT_SID=tu_sid
TWILIO_AUTH_TOKEN=tu_token
TWILIO_WHATSAPP_NUMBER=+1234567890

# Redis
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=tu_password_redis

# Servidor
PORT=3000
NODE_ENV=development
```

## Supervisión y Monitoreo

### Métricas de Operación

- **Latencia de la app**: <500ms
- **Disponibilidad objetivo**: 99.9%
- **Tiempo de recuperación de fallos**: <30 segundos
- **Tasa de sync**: >95%

### Health Checks

```bash
# Health check de API
curl http://localhost:3000/api/health

# Estado del servidor Docker
docker ps

# Logs del contenedor
docker logs colmena-api
```

## Plan de Desarrollo

### Iteraciones Actuales

| Iteración | Enfoque | Fecha de Entrega |
|-----------|---------|-----------------|
| **Fase 1** | Fundamentos | Completada |
| **Fase 2** | Georreferenciación | En progreso |
| **Fase 3** | Optimización | Próximamente |
| **Fase 4** | Automatización | Próximamente |
| **Fase 5** | Producción | Próximamente |

### Evoluciones Proyectadas

1. **Fase 2**: Implementar validación obligatoria de GPS
2. **Fase 3**: Optimizar rutas con OSRM
3. **Fase 4**: Implementar comunicaciones automáticas con Twilio
4. **Fase 5**: Implementar monitoreo completo y documentación

## Licencia

MIT

## Contacto

Para preguntas, problemas o colaboraciones, visita nuestro repositorio de GitHub.

---

*System Colmena - Movilizando la democracia con tecnología* 🚀
