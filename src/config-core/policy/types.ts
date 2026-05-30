interface CredInjectHeader {
  header: string;
  from_credential: string;
}

interface CredInject {
  provider?: string;
  strip_headers?: string[];
  inject?: CredInjectHeader[];
}

interface L7Allow {
  method?: string;
  path?: string;
  command?: string;
  query?: Record<string, string | { any: string[] }>;
}

interface L7Rule {
  allow: L7Allow;
}

interface L7DenyRule {
  method?: string;
  path?: string;
  command?: string;
  query?: Record<string, string | { any: string[] }>;
}

interface TrustCheck {
  registry: string;
}

interface NetworkEndpoint {
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

interface NetworkBinary {
  path: string;
  harness?: boolean;
}

interface NetworkPolicy {
  name?: string;
  endpoints?: NetworkEndpoint[];
  binaries?: NetworkBinary[];
  allowed_secrets?: string[];
}

interface FilesystemPolicy {
  include_workdir?: boolean;
  read_only?: string[];
  read_write?: string[];
}

interface LandlockPolicy {
  compatibility?: string;
}

interface ProcessPolicy {
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
