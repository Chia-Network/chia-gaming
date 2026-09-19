import type { NeedCoinSpendRequest } from '../../types/ChiaGaming';
import { jsonStringify } from '../../util/jsonSafe';

declare const canonicalFundingRequest: unique symbol;
export type CanonicalFundingRequest = NeedCoinSpendRequest & {
  readonly [canonicalFundingRequest]: true;
};

function invalid(label: string, field?: string): never {
  throw new Error(`Invalid ${label}${field === undefined ? '' : `.${field}`}`);
}

function integer(value: unknown): value is bigint | number {
  return typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value));
}

/**
 * Validate and copy a funding request at an untyped boundary.
 *
 * wasm-bindgen represents absent Rust options as either null or undefined,
 * while the durable TypeScript shape represents both by omitting the field.
 */
export function canonicalizeFundingRequest(
  value: unknown,
  label = 'funding request',
): CanonicalFundingRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(label);
  const request = value as Record<string, unknown>;
  if (typeof request.amount !== 'string' || request.amount.length === 0) invalid(label, 'amount');
  if (typeof request.fee !== 'string' || request.fee.length === 0) invalid(label, 'fee');
  if (!Array.isArray(request.conditions)) invalid(label, 'conditions');

  const conditions = request.conditions.map((value, index) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      invalid(label, `conditions[${index}]`);
    }
    const condition = value as Record<string, unknown>;
    if (
      !integer(condition.opcode) ||
      !Array.isArray(condition.args) ||
      !condition.args.every((arg) => typeof arg === 'string')
    ) {
      invalid(label, `conditions[${index}]`);
    }
    return { opcode: condition.opcode, args: [...condition.args] };
  });

  if (
    request.coin_id != null &&
    (typeof request.coin_id !== 'string' || request.coin_id.length === 0)
  ) {
    invalid(label, 'coin_id');
  }
  if (request.max_height != null && !integer(request.max_height)) {
    invalid(label, 'max_height');
  }

  return {
    amount: request.amount,
    fee: request.fee,
    conditions,
    ...(request.coin_id == null ? {} : { coin_id: request.coin_id }),
    ...(request.max_height == null ? {} : { max_height: request.max_height }),
  } as CanonicalFundingRequest;
}

export function fundingRequestKey(request: CanonicalFundingRequest): string {
  return `funding:${jsonStringify(request)}`;
}
