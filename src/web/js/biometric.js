const Biometric = (() => {
  const STORAGE_KEY = 'colmena_biometric';

  function getPlugin() {
    if (typeof Capacitor === 'undefined') return null;
    return Capacitor.Plugins?.NativeBiometric || null;
  }

  async function isAvailable() {
    const plugin = getPlugin();
    if (!plugin) return false;
    try {
      const result = await plugin.isAvailable();
      return result.isAvailable;
    } catch { return false; }
  }

  async function verify(reason = 'Acceso a Colmena') {
    const plugin = getPlugin();
    if (!plugin) return false;
    try {
      await plugin.verifyIdentity({ reason, title: 'Colmena', subtitle: 'Autenticación biométrica' });
      return true;
    } catch { return false; }
  }

  async function saveCredentials(token, email) {
    const plugin = getPlugin();
    if (!plugin) return false;
    try {
      await plugin.setCredentials({ username: email, password: token, server: 'colmena' });
      localStorage.setItem(STORAGE_KEY, 'true');
      return true;
    } catch { return false; }
  }

  async function getCredentials() {
    const plugin = getPlugin();
    if (!plugin) return null;
    try {
      return await plugin.getCredentials({ server: 'colmena' });
    } catch { return null; }
  }

  async function deleteCredentials() {
    const plugin = getPlugin();
    if (!plugin) return;
    try {
      await plugin.deleteCredentials({ server: 'colmena' });
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }

  function isEnabled() {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  }

  return { isAvailable, verify, saveCredentials, getCredentials, deleteCredentials, isEnabled };
})();
