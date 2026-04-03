const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32M_CONST = 0x2bc830a3;

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GEN[i];
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const result: number[] = [];
  for (let i = 0; i < hrp.length; i++) result.push(hrp.charCodeAt(i) >> 5);
  result.push(0);
  for (let i = 0; i < hrp.length; i++) result.push(hrp.charCodeAt(i) & 31);
  return result;
}

function convertBits(data: number[], fromBits: number, toBits: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const maxv = (1 << toBits) - 1;
  const result: number[] = [];
  for (const value of data) {
    if (value < 0 || value >> fromBits) return null;
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      result.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) result.push((acc << (toBits - bits)) & maxv);
  } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
    return null;
  }
  return result;
}

export function decodeBech32mPuzzleHash(addr: string): string | null {
  const lower = addr.toLowerCase();
  const sepIdx = lower.lastIndexOf('1');
  if (sepIdx < 1 || sepIdx + 7 > lower.length) return null;

  const hrp = lower.slice(0, sepIdx);
  const dataChars = lower.slice(sepIdx + 1);

  const data: number[] = [];
  for (const ch of dataChars) {
    const idx = CHARSET.indexOf(ch);
    if (idx === -1) return null;
    data.push(idx);
  }

  if (polymod([...hrpExpand(hrp), ...data]) !== BECH32M_CONST) return null;

  const payload = convertBits(data.slice(0, -6), 5, 8, false);
  if (!payload || payload.length !== 32) return null;

  return payload.map(b => b.toString(16).padStart(2, '0')).join('');
}
