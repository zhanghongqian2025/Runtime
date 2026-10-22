import { z } from 'zod';

/**
 * A compact zod -> JSON Schema projection.
 *
 * The model needs JSON Schema, the tool author thinks in zod. Only the shapes
 * the local tool set actually uses are supported; anything else degrades to a
 * permissive schema rather than failing the turn.
 */
export function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = toJsonSchema(value);
      if (!isOptional(value)) required.push(key);
    }
    return { type: 'object', properties, required, additionalProperties: false };
  }

  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) return { type: 'number' };
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodLiteral) return { const: schema.value };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: [...schema.options] };
  if (schema instanceof z.ZodArray) return { type: 'array', items: toJsonSchema(schema.element) };
  if (schema instanceof z.ZodRecord) {
    return { type: 'object' };
  }
  if (schema instanceof z.ZodOptional) return toJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodDefault) return toJsonSchema(schema.removeDefault());
  if (schema instanceof z.ZodNullable) return toJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodUnion) {
    return { anyOf: schema.options.map((option: z.ZodTypeAny) => toJsonSchema(option)) };
  }
  if (schema instanceof z.ZodEffects) return toJsonSchema(schema.innerType());

  return {};
}

function isOptional(schema: z.ZodTypeAny): boolean {
  if (schema instanceof z.ZodOptional) return true;
  if (schema instanceof z.ZodDefault) return true;
  return schema.isOptional();
}
