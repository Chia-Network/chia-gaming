export type BencodexKey = string | Uint8Array;
export type BencodexDictionary = ReadonlyMap<BencodexKey, BencodexValue> | { readonly [key: string]: BencodexValue };
export type BencodexValue =
  | null
  | boolean
  | bigint
  | string
  | Uint8Array
  | readonly BencodexValue[]
  | BencodexDictionary;

export class BencodexError extends Error {
  constructor(message: string);
}

export function encode(value: BencodexValue): Uint8Array;
export function decode(bytes: Uint8Array | ArrayBuffer): BencodexValue;
export function isDictionary(value: BencodexValue): value is Map<BencodexKey, BencodexValue>;
export function getText(map: Map<BencodexKey, BencodexValue>, key: string): string | undefined;
export function getBoolean(map: Map<BencodexKey, BencodexValue>, key: string): boolean | undefined;
