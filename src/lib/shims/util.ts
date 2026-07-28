/**
 * Minimal browser shim for Node's `util` module.
 * gramjs (telegram) uses `inspect.custom` at class-definition time; without
 * this, the browser bundle throws "Cannot read properties of undefined
 * (reading 'custom')" the moment the library is imported.
 */
export const inspect = Object.assign(
  (value: unknown) => {
    try {
      return typeof value === "string" ? value : JSON.stringify(value);
    } catch {
      return String(value);
    }
  },
  { custom: Symbol.for("nodejs.util.inspect.custom") },
);

export function format(fmt: unknown, ...args: unknown[]) {
  return [fmt, ...args].map((a) => (typeof a === "string" ? a : inspect(a))).join(" ");
}

export function promisify<T extends (...args: never[]) => unknown>(fn: T) {
  return fn;
}

export function deprecate<T>(fn: T) {
  return fn;
}

export const types = {
  isDate: (v: unknown) => v instanceof Date,
  isRegExp: (v: unknown) => v instanceof RegExp,
};

export function inherits(ctor: { prototype: object; super_?: unknown }, superCtor: { prototype: object }) {
  ctor.super_ = superCtor;
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

export default { inspect, format, promisify, deprecate, types, inherits };
