-- 024: El coordinador ya no tiene secciones (solo enlaces)
DELETE FROM usuarios_secciones WHERE usuario_id IN (SELECT id FROM usuarios WHERE rol = 'coordinador');