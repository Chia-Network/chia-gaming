const PREFERENCES_KEY = 'appPreferences';

function readDarkPreference() {
  try {
    const raw = localStorage.getItem(PREFERENCES_KEY);
    if (raw === null) return false;

    const preferences = JSON.parse(raw);
    return preferences !== null && typeof preferences === 'object' && preferences.theme === 'dark';
  } catch {
    return false;
  }
}

function applyTheme() {
  const dark = readDarkPreference();
  document.documentElement.classList.toggle('dark', dark);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', dark ? '#0d120f' : '#f9faf8');
}

applyTheme();
window.addEventListener('storage', (event) => {
  if (event.key === PREFERENCES_KEY) applyTheme();
});
