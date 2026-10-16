export type ModelFamily = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'other';

const FAMILIES: readonly Exclude<ModelFamily, 'other'>[] = ['fable', 'opus', 'sonnet', 'haiku'];

/**
 * Family of a Claude model from its id (`claude-opus-5-5`, `us.anthropic.claude-haiku-5-5`) or
 * display name (`Fable 5.1`); drives the badge colour so the model is recognisable without reading.
 */
export function modelFamily(model: string): ModelFamily {
  const lower = model.toLowerCase();
  return FAMILIES.find((family) => lower.includes(family)) ?? 'other';
}
