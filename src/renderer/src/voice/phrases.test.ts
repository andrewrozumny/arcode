import { describe, expect, it } from 'vitest';
import { phraseToSend } from './phrases';

describe('phraseToSend', () => {
  it('keeps real phrases and tidies spaces', () => {
    expect(phraseToSend('  Запусти   тесты, пожалуйста. ')).toBe('Запусти тесты, пожалуйста.');
    expect(phraseToSend('Run the gates')).toBe('Run the gates');
  });

  it('drops empty and punctuation-only results', () => {
    expect(phraseToSend('')).toBeNull();
    expect(phraseToSend(' ... ')).toBeNull();
  });

  it('drops whisper phantoms', () => {
    expect(phraseToSend('Продолжение следует...')).toBeNull();
    expect(phraseToSend('Субтитры сделал DimaTorzok')).toBeNull();
    expect(phraseToSend('Спасибо за просмотр!')).toBeNull();
    expect(phraseToSend('Thank you for watching.')).toBeNull();
  });
});
