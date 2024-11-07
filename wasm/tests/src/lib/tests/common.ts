
export function to_hex_string(byteArray: Array<number>) {
  return Array.from(byteArray, function(byte: number) {
    return ('0' + (byte & 0xFF).toString(16)).slice(-2);
  }).join('')
}
