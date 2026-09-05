const TRILLION = 1_000_000_000_000n;

export function formatSpacepokerAmount(mojos: bigint): string {
  if (mojos < 1_000_000n) return `${mojos} MOJO`;
  const whole = mojos / TRILLION;
  const frac = mojos % TRILLION;
  if (frac === 0n) return `${whole} XCH`;
  return `${whole}.${frac.toString().padStart(12, '0').replace(/0+$/, '')} XCH`;
}

export function formatSpacepokerMojos(mojos: bigint): string {
  const abs = mojos < 0n ? -mojos : mojos;
  if (abs < 100_000_000n) return `${mojos.toLocaleString()} mojos`;
  const sign = mojos < 0n ? '-' : '';
  const whole = abs / TRILLION;
  const frac = (abs % TRILLION).toString().padStart(12, '0').slice(0, 4);
  return `${sign}${whole.toLocaleString()}.${frac} XCH`;
}

export function formatSpacepokerXch(mojos: bigint): string {
  const sign = mojos < 0n ? '-' : '';
  const abs = mojos < 0n ? -mojos : mojos;
  const s = abs.toString().padStart(13, '0');
  const whole = s.slice(0, -12).replace(/^0+/, '') || '0';
  const frac = s.slice(-12).replace(/0+$/, '');
  return `${sign}${frac ? `${whole}.${frac}` : whole} XCH`;
}
