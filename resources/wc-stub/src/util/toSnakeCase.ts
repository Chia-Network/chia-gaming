import { snakeCase, transform, isArray, isObject } from 'lodash';

export default function toSnakeCase(objectToConvert: object): {
  [key: string]: unknown;
} {
  return transform(objectToConvert, (acc, value, key, target) => {
    const newKey = isArray(target) ? key : snakeCase(key);

    acc[newKey] = isObject(value) ? toSnakeCase(value) : value;
  });
}
