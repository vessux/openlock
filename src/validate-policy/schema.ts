const QUERY_MATCHER_KEYS = new Set(["any"]);

const L7_ALLOW_KEYS = new Set(["method", "path", "command", "query"]);
const L7_RULE_KEYS = new Set(["allow"]);
const L7_DENY_KEYS = new Set(["method", "path", "command", "query"]);

const CRED_INJECT_HEADER_KEYS = new Set(["header", "from_credential"]);
const CRED_INJECT_KEYS = new Set(["provider", "strip_headers", "inject"]);
const TRUST_CHECK_KEYS = new Set(["registry"]);

const ENDPOINT_KEYS = new Set([
  "host",
  "port",
  "ports",
  "protocol",
  "tls",
  "enforcement",
  "access",
  "rules",
  "allowed_ips",
  "deny_rules",
  "allow_encoded_slash",
  "cred_inject",
  "echo",
  "trust_check",
]);

const BINARY_KEYS = new Set(["path", "harness"]);

const NETWORK_POLICY_KEYS = new Set(["name", "endpoints", "binaries", "allowed_secrets"]);

const FILESYSTEM_KEYS = new Set(["include_workdir", "read_only", "read_write"]);
const LANDLOCK_KEYS = new Set(["compatibility"]);
const PROCESS_KEYS = new Set(["run_as_user", "run_as_group"]);
const TOP_LEVEL_KEYS = new Set([
  "version",
  "filesystem_policy",
  "landlock",
  "process",
  "network_policies",
]);

export interface ValidationError {
  path: string;
  message: string;
}

function unknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      errors.push({ path: `${path}.${key}`, message: `unknown field "${key}"` });
    }
  }
  return errors;
}

function checkType(val: unknown, expected: string, path: string): ValidationError | null {
  if (expected === "array") {
    return Array.isArray(val) ? null : { path, message: `expected array, got ${typeof val}` };
  }
  if (expected === "object") {
    return val !== null && typeof val === "object" && !Array.isArray(val)
      ? null
      : { path, message: `expected object, got ${Array.isArray(val) ? "array" : typeof val}` };
  }
  return typeof val === expected
    ? null
    : { path, message: `expected ${expected}, got ${typeof val}` };
}

function validateQueryMatcher(val: unknown, path: string): ValidationError[] {
  if (typeof val === "string") return [];
  if (val !== null && typeof val === "object" && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    const errors = unknownKeys(obj, QUERY_MATCHER_KEYS, path);
    if (obj.any !== undefined) {
      const t = checkType(obj.any, "array", `${path}.any`);
      if (t) errors.push(t);
      else {
        for (const [i, v] of (obj.any as unknown[]).entries()) {
          const t2 = checkType(v, "string", `${path}.any[${i}]`);
          if (t2) errors.push(t2);
        }
      }
    }
    return errors;
  }
  return [{ path, message: `expected string or object with "any", got ${typeof val}` }];
}

function validateL7Allow(val: unknown, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const t = checkType(val, "object", path);
  if (t) return [t];
  const obj = val as Record<string, unknown>;
  errors.push(...unknownKeys(obj, L7_ALLOW_KEYS, path));
  for (const f of ["method", "path", "command"] as const) {
    if (obj[f] !== undefined) {
      const t2 = checkType(obj[f], "string", `${path}.${f}`);
      if (t2) errors.push(t2);
    }
  }
  if (obj.query !== undefined) {
    const t2 = checkType(obj.query, "object", `${path}.query`);
    if (t2) errors.push(t2);
    else {
      for (const [k, v] of Object.entries(obj.query as Record<string, unknown>)) {
        errors.push(...validateQueryMatcher(v, `${path}.query.${k}`));
      }
    }
  }
  return errors;
}

function validateL7Rule(val: unknown, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const t = checkType(val, "object", path);
  if (t) return [t];
  const obj = val as Record<string, unknown>;
  errors.push(...unknownKeys(obj, L7_RULE_KEYS, path));
  if (obj.allow === undefined) {
    errors.push({ path, message: `missing required field "allow"` });
  } else {
    errors.push(...validateL7Allow(obj.allow, `${path}.allow`));
  }
  return errors;
}

function validateL7Deny(val: unknown, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const t = checkType(val, "object", path);
  if (t) return [t];
  const obj = val as Record<string, unknown>;
  errors.push(...unknownKeys(obj, L7_DENY_KEYS, path));
  for (const f of ["method", "path", "command"] as const) {
    if (obj[f] !== undefined) {
      const t2 = checkType(obj[f], "string", `${path}.${f}`);
      if (t2) errors.push(t2);
    }
  }
  if (obj.query !== undefined) {
    const t2 = checkType(obj.query, "object", `${path}.query`);
    if (t2) errors.push(t2);
    else {
      for (const [k, v] of Object.entries(obj.query as Record<string, unknown>)) {
        errors.push(...validateQueryMatcher(v, `${path}.query.${k}`));
      }
    }
  }
  return errors;
}

function validateCredInjectHeader(val: unknown, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const t = checkType(val, "object", path);
  if (t) return [t];
  const obj = val as Record<string, unknown>;
  errors.push(...unknownKeys(obj, CRED_INJECT_HEADER_KEYS, path));
  for (const f of ["header", "from_credential"] as const) {
    if (obj[f] === undefined) {
      errors.push({ path, message: `missing required field "${f}"` });
    } else {
      const t2 = checkType(obj[f], "string", `${path}.${f}`);
      if (t2) errors.push(t2);
    }
  }
  return errors;
}

function validateCredInject(val: unknown, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const t = checkType(val, "object", path);
  if (t) return [t];
  const obj = val as Record<string, unknown>;
  errors.push(...unknownKeys(obj, CRED_INJECT_KEYS, path));
  if (obj.provider !== undefined) {
    const t2 = checkType(obj.provider, "string", `${path}.provider`);
    if (t2) errors.push(t2);
  }
  if (obj.strip_headers !== undefined) {
    const t2 = checkType(obj.strip_headers, "array", `${path}.strip_headers`);
    if (t2) errors.push(t2);
    else {
      for (const [i, v] of (obj.strip_headers as unknown[]).entries()) {
        const t3 = checkType(v, "string", `${path}.strip_headers[${i}]`);
        if (t3) errors.push(t3);
      }
    }
  }
  if (obj.inject !== undefined) {
    const t2 = checkType(obj.inject, "array", `${path}.inject`);
    if (t2) errors.push(t2);
    else {
      for (const [i, v] of (obj.inject as unknown[]).entries()) {
        errors.push(...validateCredInjectHeader(v, `${path}.inject[${i}]`));
      }
    }
  }
  return errors;
}

function validateTrustCheck(val: unknown, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const t = checkType(val, "object", path);
  if (t) return [t];
  const obj = val as Record<string, unknown>;
  errors.push(...unknownKeys(obj, TRUST_CHECK_KEYS, path));
  if (obj.registry === undefined) {
    errors.push({ path, message: `missing required field "registry"` });
  } else {
    const t2 = checkType(obj.registry, "string", `${path}.registry`);
    if (t2) errors.push(t2);
  }
  return errors;
}

function validateEndpoint(val: unknown, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const t = checkType(val, "object", path);
  if (t) return [t];
  const obj = val as Record<string, unknown>;
  errors.push(...unknownKeys(obj, ENDPOINT_KEYS, path));

  if (obj.host === undefined) {
    errors.push({ path, message: `missing required field "host"` });
  } else {
    const t2 = checkType(obj.host, "string", `${path}.host`);
    if (t2) errors.push(t2);
  }

  if (obj.port !== undefined) {
    if (typeof obj.port !== "number" || !Number.isInteger(obj.port)) {
      errors.push({ path: `${path}.port`, message: `expected integer, got ${typeof obj.port}` });
    } else if (obj.port < 1 || obj.port > 65535) {
      errors.push({ path: `${path}.port`, message: `port must be 1-65535, got ${obj.port}` });
    }
  }

  if (obj.ports !== undefined) {
    const t2 = checkType(obj.ports, "array", `${path}.ports`);
    if (t2) errors.push(t2);
    else {
      for (const [i, v] of (obj.ports as unknown[]).entries()) {
        if (typeof v !== "number" || !Number.isInteger(v)) {
          errors.push({ path: `${path}.ports[${i}]`, message: `expected integer` });
        } else if (v < 1 || v > 65535) {
          errors.push({ path: `${path}.ports[${i}]`, message: `port must be 1-65535, got ${v}` });
        }
      }
    }
  }

  for (const f of ["protocol", "tls", "enforcement", "access"] as const) {
    if (obj[f] !== undefined) {
      const t2 = checkType(obj[f], "string", `${path}.${f}`);
      if (t2) errors.push(t2);
    }
  }

  if (obj.rules !== undefined) {
    const t2 = checkType(obj.rules, "array", `${path}.rules`);
    if (t2) errors.push(t2);
    else {
      for (const [i, v] of (obj.rules as unknown[]).entries()) {
        errors.push(...validateL7Rule(v, `${path}.rules[${i}]`));
      }
    }
  }

  if (obj.allowed_ips !== undefined) {
    const t2 = checkType(obj.allowed_ips, "array", `${path}.allowed_ips`);
    if (t2) errors.push(t2);
    else {
      for (const [i, v] of (obj.allowed_ips as unknown[]).entries()) {
        const t3 = checkType(v, "string", `${path}.allowed_ips[${i}]`);
        if (t3) errors.push(t3);
      }
    }
  }

  if (obj.deny_rules !== undefined) {
    const t2 = checkType(obj.deny_rules, "array", `${path}.deny_rules`);
    if (t2) errors.push(t2);
    else {
      for (const [i, v] of (obj.deny_rules as unknown[]).entries()) {
        errors.push(...validateL7Deny(v, `${path}.deny_rules[${i}]`));
      }
    }
  }

  if (obj.allow_encoded_slash !== undefined) {
    const t2 = checkType(obj.allow_encoded_slash, "boolean", `${path}.allow_encoded_slash`);
    if (t2) errors.push(t2);
  }

  if (obj.echo !== undefined) {
    const t2 = checkType(obj.echo, "boolean", `${path}.echo`);
    if (t2) errors.push(t2);
  }

  if (obj.cred_inject !== undefined) {
    errors.push(...validateCredInject(obj.cred_inject, `${path}.cred_inject`));
  }

  if (obj.trust_check !== undefined) {
    errors.push(...validateTrustCheck(obj.trust_check, `${path}.trust_check`));
  }

  return errors;
}

function validateBinary(val: unknown, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const t = checkType(val, "object", path);
  if (t) return [t];
  const obj = val as Record<string, unknown>;
  errors.push(...unknownKeys(obj, BINARY_KEYS, path));
  if (obj.path === undefined) {
    errors.push({ path, message: `missing required field "path"` });
  } else {
    const t2 = checkType(obj.path, "string", `${path}.path`);
    if (t2) errors.push(t2);
  }
  if (obj.harness !== undefined) {
    const t2 = checkType(obj.harness, "boolean", `${path}.harness`);
    if (t2) errors.push(t2);
  }
  return errors;
}

function validateNetworkPolicy(val: unknown, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const t = checkType(val, "object", path);
  if (t) return [t];
  const obj = val as Record<string, unknown>;
  errors.push(...unknownKeys(obj, NETWORK_POLICY_KEYS, path));

  if (obj.name !== undefined) {
    const t2 = checkType(obj.name, "string", `${path}.name`);
    if (t2) errors.push(t2);
  }

  if (obj.endpoints !== undefined) {
    const t2 = checkType(obj.endpoints, "array", `${path}.endpoints`);
    if (t2) errors.push(t2);
    else {
      for (const [i, v] of (obj.endpoints as unknown[]).entries()) {
        errors.push(...validateEndpoint(v, `${path}.endpoints[${i}]`));
      }
    }
  }

  if (obj.binaries !== undefined) {
    const t2 = checkType(obj.binaries, "array", `${path}.binaries`);
    if (t2) errors.push(t2);
    else {
      for (const [i, v] of (obj.binaries as unknown[]).entries()) {
        errors.push(...validateBinary(v, `${path}.binaries[${i}]`));
      }
    }
  }

  if (obj.allowed_secrets !== undefined) {
    const t2 = checkType(obj.allowed_secrets, "array", `${path}.allowed_secrets`);
    if (t2) errors.push(t2);
    else {
      for (const [i, v] of (obj.allowed_secrets as unknown[]).entries()) {
        const t3 = checkType(v, "string", `${path}.allowed_secrets[${i}]`);
        if (t3) errors.push(t3);
      }
    }
  }

  return errors;
}

function validateFilesystem(val: unknown, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const t = checkType(val, "object", path);
  if (t) return [t];
  const obj = val as Record<string, unknown>;
  errors.push(...unknownKeys(obj, FILESYSTEM_KEYS, path));
  if (obj.include_workdir !== undefined) {
    const t2 = checkType(obj.include_workdir, "boolean", `${path}.include_workdir`);
    if (t2) errors.push(t2);
  }
  for (const f of ["read_only", "read_write"] as const) {
    if (obj[f] !== undefined) {
      const t2 = checkType(obj[f], "array", `${path}.${f}`);
      if (t2) errors.push(t2);
      else {
        for (const [i, v] of (obj[f] as unknown[]).entries()) {
          const t3 = checkType(v, "string", `${path}.${f}[${i}]`);
          if (t3) errors.push(t3);
        }
      }
    }
  }
  return errors;
}

function validateLandlock(val: unknown, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const t = checkType(val, "object", path);
  if (t) return [t];
  const obj = val as Record<string, unknown>;
  errors.push(...unknownKeys(obj, LANDLOCK_KEYS, path));
  if (obj.compatibility !== undefined) {
    const t2 = checkType(obj.compatibility, "string", `${path}.compatibility`);
    if (t2) errors.push(t2);
  }
  return errors;
}

function validateProcess(val: unknown, path: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const t = checkType(val, "object", path);
  if (t) return [t];
  const obj = val as Record<string, unknown>;
  errors.push(...unknownKeys(obj, PROCESS_KEYS, path));
  for (const f of ["run_as_user", "run_as_group"] as const) {
    if (obj[f] !== undefined) {
      const t2 = checkType(obj[f], "string", `${path}.${f}`);
      if (t2) errors.push(t2);
    }
  }
  return errors;
}

export function validateSchema(doc: unknown): ValidationError[] {
  const errors: ValidationError[] = [];
  const t = checkType(doc, "object", "");
  if (t) return [t];
  const obj = doc as Record<string, unknown>;

  errors.push(...unknownKeys(obj, TOP_LEVEL_KEYS, ""));

  if (obj.version === undefined) {
    errors.push({ path: "version", message: "missing required field" });
  } else if (typeof obj.version !== "number" || !Number.isInteger(obj.version)) {
    errors.push({ path: "version", message: `expected integer, got ${typeof obj.version}` });
  }

  if (obj.filesystem_policy !== undefined) {
    errors.push(...validateFilesystem(obj.filesystem_policy, "filesystem_policy"));
  }

  if (obj.landlock !== undefined) {
    errors.push(...validateLandlock(obj.landlock, "landlock"));
  }

  if (obj.process !== undefined) {
    errors.push(...validateProcess(obj.process, "process"));
  }

  if (obj.network_policies !== undefined) {
    const t2 = checkType(obj.network_policies, "object", "network_policies");
    if (t2) errors.push(t2);
    else {
      for (const [key, val] of Object.entries(obj.network_policies as Record<string, unknown>)) {
        errors.push(...validateNetworkPolicy(val, `network_policies.${key}`));
      }
    }
  }

  return errors;
}
