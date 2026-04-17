import { describe, it, expect } from 'vitest';
import {
  resolveSandboxResources,
  serializeRunSandboxFields,
} from '../../src/lib/sandbox-resources.js';
import {
  sandboxMemorySchema,
  sandboxCpusSchema,
} from '../../src/lib/validation/shared.js';

describe('sandboxMemorySchema', () => {
  it('accepts valid binary sizes', () => {
    expect(sandboxMemorySchema.parse('1024m')).toBe('1024m');
    expect(sandboxMemorySchema.parse('8g')).toBe('8g');
    expect(sandboxMemorySchema.parse('512M')).toBe('512M');
    expect(sandboxMemorySchema.parse('16G')).toBe('16G');
  });

  it('rejects malformed strings', () => {
    expect(() => sandboxMemorySchema.parse('8gb')).toThrow();
    expect(() => sandboxMemorySchema.parse('8')).toThrow();
    expect(() => sandboxMemorySchema.parse('0g')).toThrow();
    expect(() => sandboxMemorySchema.parse('')).toThrow();
    expect(() => sandboxMemorySchema.parse('m')).toThrow();
  });
});

describe('sandboxCpusSchema', () => {
  it('accepts non-negative integers', () => {
    expect(sandboxCpusSchema.parse(0)).toBe(0);
    expect(sandboxCpusSchema.parse(4)).toBe(4);
    expect(sandboxCpusSchema.parse(256)).toBe(256);
  });

  it('rejects bad inputs', () => {
    expect(() => sandboxCpusSchema.parse(-1)).toThrow();
    expect(() => sandboxCpusSchema.parse(1.5)).toThrow();
    expect(() => sandboxCpusSchema.parse(257)).toThrow();
  });
});

describe('resolveSandboxResources', () => {
  it('inherits from project when run row is null', () => {
    const r = resolveSandboxResources(
      { sandboxMemory: '8g', sandboxCpus: 4 },
      { sandboxMemory: null, sandboxCpus: null },
    );
    expect(r).toEqual({ memory: '8g', cpus: 4 });
  });

  it('uses run override when set', () => {
    const r = resolveSandboxResources(
      { sandboxMemory: '8g', sandboxCpus: 4 },
      { sandboxMemory: '16g', sandboxCpus: 8 },
    );
    expect(r).toEqual({ memory: '16g', cpus: 8 });
  });

  it('explicit-default sentinels override project to omit flag', () => {
    const r = resolveSandboxResources(
      { sandboxMemory: '8g', sandboxCpus: 4 },
      { sandboxMemory: '', sandboxCpus: -1 },
    );
    expect(r).toEqual({ memory: undefined, cpus: undefined });
  });

  it('omits when neither project nor run set', () => {
    const r = resolveSandboxResources(
      { sandboxMemory: null, sandboxCpus: null },
      { sandboxMemory: null, sandboxCpus: null },
    );
    expect(r).toEqual({ memory: undefined, cpus: undefined });
  });

  it('preserves cpus=0 (sbx auto) as a real value', () => {
    const r = resolveSandboxResources(
      { sandboxMemory: null, sandboxCpus: null },
      { sandboxMemory: null, sandboxCpus: 0 },
    );
    expect(r.cpus).toBe(0);
  });
});

describe('serializeRunSandboxFields', () => {
  it('maps null column → undefined (inherit), sentinel → null (explicit default), value → value', () => {
    expect(serializeRunSandboxFields({ id: 'a', sandboxMemory: null, sandboxCpus: null })).toMatchObject({
      sandboxMemory: undefined,
      sandboxCpus: undefined,
    });
    expect(serializeRunSandboxFields({ id: 'a', sandboxMemory: '', sandboxCpus: -1 })).toMatchObject({
      sandboxMemory: null,
      sandboxCpus: null,
    });
    expect(serializeRunSandboxFields({ id: 'a', sandboxMemory: '4g', sandboxCpus: 2 })).toMatchObject({
      sandboxMemory: '4g',
      sandboxCpus: 2,
    });
  });
});
