import { camelCase, transform, isArray, isObject } from 'lodash';

export default function toCamelCase(objectToConvert: Record<string, unknown>): {
  [key: string]: unknown;
} {
  return transform(objectToConvert, (acc, value, key, target) => {
    const newKey =
      isArray(target) || key.indexOf('_') === -1 ? key : camelCase(key);

    acc[newKey] = isObject(value) ? toCamelCase(value as Record<string, unknown>) : value;
  });
}
