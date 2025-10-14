import { BigNumber as BN } from 'bignumber.js';
import { transform } from 'lodash';

export default function toSafeNumber(objectToConvert: unknown): {
  [key: string]: unknown;
} {
  return transform(objectToConvert, (acc, value, key) => {
    if (
      value instanceof BN &&
      value.isInteger() &&
      value.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
    ) {
      acc[key] = value.toNumber();
    } else {
      acc[key] = value;
    }
  });
}
