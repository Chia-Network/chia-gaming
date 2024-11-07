
export function to_hex_string(byteArray) {
  return Array.from(byteArray, function(byte) {
    return ('0' + (byte & 0xFF).toString(16)).slice(-2);
  }).join('')
}

export function assert(condition, msg) {
  if (condition === false) throw new Error(msg);
}
