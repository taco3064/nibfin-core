// Strict validation for the JSON Schema vocabulary used by stage results.
// Reject unsupported keywords rather than silently ignoring new constraints.
export function validateSchema(value, schema, path = '$') {
  for (const key of Object.keys(schema)) if (!['type', 'properties', 'required', 'additionalProperties', 'items', 'enum'].includes(key)) throw new Error(`Unsupported schema keyword: ${key}`);
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (type !== schema.type) throw new Error(`Agent result schema mismatch at ${path}: expected ${schema.type}`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`Agent result schema mismatch at ${path}: invalid enum`);
  if (type === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`Agent result schema mismatch at ${path}`);
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`Agent result schema mismatch at ${path}.${key}: missing`);
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties || {}, key)) {
        if (schema.additionalProperties === false) throw new Error(`Agent result schema mismatch at ${path}.${key}: unknown property`);
      } else validateSchema(child, schema.properties[key], `${path}.${key}`);
    }
  }
  if (type === 'array') for (let i = 0; i < value.length; i++) validateSchema(value[i], schema.items, `${path}[${i}]`);
  return value;
}
