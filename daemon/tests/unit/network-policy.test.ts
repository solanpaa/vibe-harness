// Unit tests for the network-policy builder.

import { describe, it, expect } from 'vitest';
import { buildNetworkPolicy } from '../../src/lib/network-policy.js';

describe('buildNetworkPolicy', () => {
  it('returns deny-egress + allow @public + allow @host by default', () => {
    const policy = buildNetworkPolicy();
    expect(policy.defaultEgress).toBe('deny');
    expect(policy.defaultIngress).toBe('allow');
    const dests = policy.rules.map((r) => ({ a: r.action, d: r.destination }));
    expect(dests).toEqual([
      { a: 'allow', d: { kind: 'group', group: 'public' } },
      { a: 'allow', d: { kind: 'group', group: 'host' } },
    ]);
  });

  it('inserts deny-domain rules BEFORE the allow rules', () => {
    const policy = buildNetworkPolicy({
      denyDomains: ['evil.example.com'],
      denyDomainSuffixes: ['internal.example'],
    });
    expect(policy.rules[0]).toMatchObject({
      action: 'deny',
      destination: { kind: 'domain', domain: 'evil.example.com' },
    });
    expect(policy.rules[1]).toMatchObject({
      action: 'deny',
      destination: { kind: 'domainSuffix', suffix: 'internal.example' },
    });
    expect(policy.rules[2]).toMatchObject({
      action: 'allow',
      destination: { kind: 'group', group: 'public' },
    });
  });

  it('adds allow @private when allowPrivate is set', () => {
    const policy = buildNetworkPolicy({ allowPrivate: true });
    expect(policy.rules.find((r) => r.destination.kind === 'group' && r.destination.group === 'private')).toBeTruthy();
  });
});
