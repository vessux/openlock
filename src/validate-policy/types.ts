export interface CredInjectHeader {
  header: string;
  from_credential: string;
}

export interface CredInject {
  provider?: string;
  strip_headers?: string[];
  inject?: CredInjectHeader[];
}

export interface L7Allow {
  method?: string;
  path?: string;
  command?: string;
  query?: Record<string, string | { any: string[] }>;
}

export interface L7Rule {
  allow: L7Allow;
}

export interface L7DenyRule {
  method?: string;
  path?: string;
  command?: string;
  query?: Record<string, string | { any: string[] }>;
}

export interface TrustCheck {
  registry: string;
}

export interface NetworkEndpoint {
  host: string;
  port?: number;
  ports?: number[];
  protocol?: string;
  tls?: string;
  enforcement?: string;
  access?: string;
  rules?: L7Rule[];
  allowed_ips?: string[];
  deny_rules?: L7DenyRule[];
  allow_encoded_slash?: boolean;
  cred_inject?: CredInject;
  echo?: boolean;
  trust_check?: TrustCheck;
}

export interface NetworkBinary {
  path: string;
  harness?: boolean;
}

export interface NetworkPolicy {
  name?: string;
  endpoints?: NetworkEndpoint[];
  binaries?: NetworkBinary[];
  allowed_secrets?: string[];
}

export interface FilesystemPolicy {
  include_workdir?: boolean;
  read_only?: string[];
  read_write?: string[];
}

export interface LandlockPolicy {
  compatibility?: string;
}

export interface ProcessPolicy {
  run_as_user?: string;
  run_as_group?: string;
}

export interface PolicyFile {
  version: number;
  filesystem_policy?: FilesystemPolicy;
  landlock?: LandlockPolicy;
  process?: ProcessPolicy;
  network_policies?: Record<string, NetworkPolicy>;
}
