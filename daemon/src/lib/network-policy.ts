// ---------------------------------------------------------------------------
// Network-policy builder for microsandbox sandboxes.
//
// Microsandbox's default is "public-only" egress + open ingress. We extend
// that with a `host` egress allow rule (so the in-sandbox MCP bridge can
// reach the daemon at `host.microsandbox.internal`), plus optional user-
// supplied deny rules and DNS knobs.
//
// The output shape matches the wire-format network-policy object that the
// SDK accepts via `NetworkBuilder.policyJson(...)`.
// ---------------------------------------------------------------------------

export type Action = 'allow' | 'deny';
export type Direction = 'egress' | 'ingress' | 'any';
export type Protocol = 'tcp' | 'udp' | 'icmpv4' | 'icmpv6';

export type Destination =
  | { kind: 'any' }
  | { kind: 'cidr'; cidr: string }
  | { kind: 'domain'; domain: string }
  | { kind: 'domainSuffix'; suffix: string }
  | { kind: 'group'; group: 'public' | 'loopback' | 'private' | 'link-local' | 'metadata' | 'multicast' | 'host' };

export interface PortRange {
  start: number;
  end: number;
}

export interface PolicyRule {
  direction: Direction;
  destination: Destination;
  protocols: Protocol[];
  ports: PortRange[];
  action: Action;
}

export interface WireNetworkPolicy {
  defaultEgress: Action;
  defaultIngress: Action;
  rules: PolicyRule[];
}

export interface NetworkPolicyConfig {
  /** Domains to deny (exact match). */
  denyDomains?: string[];
  /** Domain suffixes to deny (e.g. "example.com" matches a.example.com). */
  denyDomainSuffixes?: string[];
  /** When true, allow access to private/LAN ranges as well. Default false. */
  allowPrivate?: boolean;
}

/**
 * Build the daemon's default network policy:
 *   - default-deny on egress
 *   - allow @public + @host
 *   - optional allow @private
 *   - user-supplied deny rules are inserted FIRST so they win over allows
 *   - default-allow on ingress (matches microsandbox publicOnly)
 */
export function buildNetworkPolicy(config: NetworkPolicyConfig = {}): WireNetworkPolicy {
  const rules: PolicyRule[] = [];

  for (const domain of config.denyDomains ?? []) {
    rules.push({
      direction: 'egress',
      destination: { kind: 'domain', domain },
      protocols: [],
      ports: [],
      action: 'deny',
    });
  }
  for (const suffix of config.denyDomainSuffixes ?? []) {
    rules.push({
      direction: 'egress',
      destination: { kind: 'domainSuffix', suffix },
      protocols: [],
      ports: [],
      action: 'deny',
    });
  }

  rules.push({
    direction: 'egress',
    destination: { kind: 'group', group: 'public' },
    protocols: [],
    ports: [],
    action: 'allow',
  });
  rules.push({
    direction: 'egress',
    destination: { kind: 'group', group: 'host' },
    protocols: [],
    ports: [],
    action: 'allow',
  });
  if (config.allowPrivate) {
    rules.push({
      direction: 'egress',
      destination: { kind: 'group', group: 'private' },
      protocols: [],
      ports: [],
      action: 'allow',
    });
  }

  return {
    defaultEgress: 'deny',
    defaultIngress: 'allow',
    rules,
  };
}

export interface DnsConfig {
  /** Disable DNS rebind protection (use for tools that need short-TTL DNS). */
  disableDnsRebindProtection?: boolean;
  /** Custom upstream DNS nameservers. */
  nameservers?: string[];
}
