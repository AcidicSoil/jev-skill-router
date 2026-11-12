export const fail = code => Object.assign(new Error(code), { code });
export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
