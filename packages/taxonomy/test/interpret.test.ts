import { describe, expect, it } from 'vitest';
import { interpretRequirement } from '../src';

describe('interpretRequirement', () => {
  it.each([
    ['sauna', ['sauna']],
    ['Sauna!', ['sauna']],
    ['pets_allowed', ['pets_allowed']],
    ['Free Wi-Fi', ['free_wifi']],
    ['near the ski lifts', ['near_ski_lifts']],
    ['rooftop bar', ['rooftop_bar']],
    ['wheelchair accessible', ['wheelchair_accessible']],
    ['bathtub', ['bathtub']],
    ['adults only', ['adults_only']],
  ])('%s → %j', (input, codes) => {
    expect(interpretRequirement(input)?.codes).toEqual(codes);
  });

  it('accepts any attribute that lists the matched phrase', () => {
    expect(interpretRequirement('dog friendly')?.codes.sort()).toEqual(['dogs_allowed', 'pets_allowed']);
  });

  it('narrows enum attributes', () => {
    expect(interpretRequirement('free parking')).toMatchObject({ codes: ['parking'], value: 'free' });
    expect(interpretRequirement('parking')).not.toHaveProperty('value');
  });

  it('ignores accents and returns null for unknown phrases', () => {
    expect(interpretRequirement('Café')?.codes).toEqual(['cafe']);
    expect(interpretRequirement('on a quiet street')?.codes).toEqual(['quiet_location']);
    expect(interpretRequirement('bohemian vibe')).toBeNull();
    expect(interpretRequirement('   ')).toBeNull();
  });
});
