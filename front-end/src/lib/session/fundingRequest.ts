import { jsonStringify } from '../../util/jsonSafe';

const U32_MAX = 4_294_967_295n;
const U64_MAX = 18_446_744_073_709_551_615n;
const CANONICAL_UNSIGNED_DECIMAL = /^(?:0|[1-9]\d*)$/;
const CANONICAL_COIN_ID = /^[0-9a-f]{64}$/;

export interface CanonicalFundingCondition {
  readonly opcode: bigint;
  readonly args: readonly string[];
}

export interface CanonicalFundingRequest {
  readonly amount: string;
  readonly fee: string;
  readonly conditions: readonly CanonicalFundingCondition[];
  readonly coin_id?: string;
  readonly max_height?: string;
}

function invalid(label: string, field?: string): never {
  throw new Error(`Invalid ${label}${field === undefined ? '' : `.${field}`}`);
}

function canonicalU64(value: unknown, label: string, field: string): string {
  if (
    typeof value !== 'string' ||
    !CANONICAL_UNSIGNED_DECIMAL.test(value) ||
    BigInt(value) > U64_MAX
  ) {
    invalid(label, field);
  }
  return value;
}

function canonicalOpcode(value: unknown, label: string, field: string, persisted: boolean): bigint {
  if (persisted) {
    if (typeof value !== 'bigint' || value < 0n || value > U32_MAX) invalid(label, field);
    return value;
  }
  if (typeof value === 'bigint') {
    if (value < 0n || value > U32_MAX) invalid(label, field);
    return value;
  }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > Number(U32_MAX)
  ) {
    invalid(label, field);
  }
  return BigInt(value);
}

function canonicalMaxHeight(value: unknown, label: string, persisted: boolean): string {
  if (typeof value === 'string') return canonicalU64(value, label, 'max_height');
  if (
    !persisted &&
    ((typeof value === 'bigint' && value >= 0n && value <= U64_MAX) ||
      (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0))
  ) {
    return value.toString();
  }
  invalid(label, 'max_height');
}

/**
 * Validate and copy a funding request at an untyped boundary.
 *
 * wasm-bindgen represents absent Rust coin_id/max_height options as either
 * null or undefined, while the durable shape omits both fields.
 */
export function canonicalizeFundingRequest(
  value: unknown,
  label = 'funding request',
  persisted = false,
): CanonicalFundingRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(label);
  const request = value as Record<string, unknown>;
  const amount = canonicalU64(request.amount, label, 'amount');
  const fee = canonicalU64(request.fee, label, 'fee');
  if (!Array.isArray(request.conditions)) invalid(label, 'conditions');

  const conditions = request.conditions.map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      invalid(label, `conditions[${index}]`);
    }
    const condition = value as Record<string, unknown>;
    if (!Array.isArray(condition.args) || !condition.args.every((arg) => typeof arg === 'string')) {
      invalid(label, `conditions[${index}]`);
    }
    return Object.freeze({
      opcode: canonicalOpcode(condition.opcode, label, `conditions[${index}]`, persisted),
      args: Object.freeze([...condition.args]),
    });
  });

  if (
    request.coin_id != null &&
    (typeof request.coin_id !== 'string' || !CANONICAL_COIN_ID.test(request.coin_id))
  ) {
    invalid(label, 'coin_id');
  }
  if (persisted && request.coin_id === null) invalid(label, 'coin_id');
  if (persisted && request.max_height === null) invalid(label, 'max_height');
  const maxHeight =
    request.max_height == null
      ? undefined
      : canonicalMaxHeight(request.max_height, label, persisted);

  return Object.freeze({
    amount,
    fee,
    conditions: Object.freeze(conditions),
    ...(request.coin_id == null ? {} : { coin_id: request.coin_id }),
    ...(maxHeight === undefined ? {} : { max_height: maxHeight }),
  });
}

export function decodeCanonicalFundingRequest(
  value: unknown,
  label = 'persisted funding request',
): CanonicalFundingRequest {
  return canonicalizeFundingRequest(value, label, true);
}

export function fundingRequestKey(request: CanonicalFundingRequest): string {
  // Keep the key bytes produced for current Rust requests. Rust emits max_height
  // as a JSON integer; the durable canonical model stores its exact decimal.
  return `funding:${jsonStringify({
    amount: request.amount,
    fee: request.fee,
    conditions: request.conditions,
    ...(request.coin_id === undefined ? {} : { coin_id: request.coin_id }),
    ...(request.max_height === undefined ? {} : { max_height: BigInt(request.max_height) }),
  })}`;
}
