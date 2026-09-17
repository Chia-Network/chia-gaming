const _raw = typeof window !== 'undefined' ? window.location.hostname : 'localhost';
const _host = _raw === 'localhost' ? '127.0.0.1' : _raw;
const _win = typeof window !== 'undefined' ? (window as any) : {};
const _env = typeof process !== 'undefined' ? process.env : {};
// Jest must receive the random-port simulator URL from its owning launcher.
// Port zero is intentionally unusable so a direct test run cannot reach a
// developer's local-demo simulator on the production default port.
const _simulatorPort = _env.NODE_ENV === 'test' ? 0 : 5800;
export const BLOCKCHAIN_SERVICE_URL =
  _win.__SIM_URL__ || _env.CHIA_GAMING_SIM_URL || `http://${_host}:${_simulatorPort}`;
export const BLOCKCHAIN_WS_URL =
  _win.__SIM_WS_URL__ || _env.CHIA_GAMING_SIM_WS_URL || `ws://${_host}:${_simulatorPort}/ws`;
// Note: The Hub URL is obtained from the "start game" URL / HubPicker
