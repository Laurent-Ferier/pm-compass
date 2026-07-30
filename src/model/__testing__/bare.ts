/**
 * An object of the given class without running its constructor: Obsidian's file classes
 * aren't constructible from a plugin, so a mock stands one up from the prototype.
 */
export function bare<T extends object>(ctor: { prototype: T }): T {
  return Object.create(ctor.prototype) as T;
}
