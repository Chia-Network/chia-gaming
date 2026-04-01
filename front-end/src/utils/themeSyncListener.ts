// Small helper to listen for `theme-sync` messages and apply CSS variables
// and `dark` class to the document root. Import and call `installThemeSyncListener()`
// in any page that may be loaded inside an iframe to accept theme updates from
// the parent.
export function installThemeSyncListener() {
  function handler(ev: MessageEvent) {
    if (!ev.data || ev.data.type !== 'theme-sync') return;
    try {
      const { vars, dark } = ev.data as { vars: Record<string, string>; dark: boolean };
      if (vars && typeof vars === 'object') {
        Object.keys(vars).forEach((k) => {
          try {
            document.documentElement.style.setProperty(k, vars[k]);
          } catch (e) {
            // ignore invalid properties
          }
        });
      }
      if (dark) document.documentElement.classList.add('dark');
      else document.documentElement.classList.remove('dark');
    } catch (e) {
      // ignore malformed messages
    }
  }

  window.addEventListener('message', handler, false);

  return function uninstall() {
    window.removeEventListener('message', handler, false);
  };
}

export default installThemeSyncListener;
