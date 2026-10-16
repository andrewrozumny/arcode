import { describe, expect, it, vi } from 'vitest';
import { EventBus } from './bus';

describe('EventBus', () => {
  it('delivers payloads and unsubscribes', () => {
    const bus = new EventBus();
    const listener = vi.fn();
    const off = bus.on('openFile', listener);
    bus.openFile({ path: 'src/a.ts', line: 3 });
    expect(listener).toHaveBeenCalledWith({ path: 'src/a.ts', line: 3 });
    off();
    bus.openFile({ path: 'b' });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(bus.count('openFile')).toBe(0);
  });

  it('keeps delivering when a listener throws', () => {
    const bus = new EventBus();
    const second = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bus.on('closeViewerTab', () => {
      throw new Error('boom');
    });
    bus.on('closeViewerTab', second);
    bus.emit('closeViewerTab');
    expect(second).toHaveBeenCalledOnce();
  });
});
