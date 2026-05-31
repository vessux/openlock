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

/** Every recognized policy key across all nesting levels, flattened for the
 * agent-reference drift guard. Order/dedup handled by the consumer. */
export const ALL_POLICY_KEYS: readonly string[] = [
  ...TOP_LEVEL_KEYS,
  ...NETWORK_POLICY_KEYS,
  ...ENDPOINT_KEYS,
  ...L7_ALLOW_KEYS,
  ...L7_RULE_KEYS,
  ...L7_DENY_KEYS,
  ...CRED_INJECT_KEYS,
  ...CRED_INJECT_HEADER_KEYS,
  ...TRUST_CHECK_KEYS,
  ...BINARY_KEYS,
  ...FILESYSTEM_KEYS,
  ...LANDLOCK_KEYS,
  ...PROCESS_KEYS,
  ...QUERY_MATCHER_KEYS,
];

export interface ValidationError {
  path: string;
  message: string;
}

type Validator = (val: unknown, path: string) => ValidationError[];

function joinPath(parent: string, key: string): string {
  return parent === "" ? key : `${parent}.${key}`;
}

function unknownKeys(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      errors.push({ path: joinPath(path, key), message: `unknown field "${key}"` });
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

function pushType(errors: ValidationError[], val: unknown, expected: string, path: string): void {
  const e = checkType(val, expected, path);
  if (e) errors.push(e);
}

function expectObject(
  val: unknown,
  path: string,
  allowed: Set<string>,
): { obj: Record<string, unknown> | null; errors: ValidationError[] } {
  const e = checkType(val, "object", path);
  if (e) return { obj: null, errors: [e] };
  const obj = val as Record<string, unknown>;
  return { obj, errors: unknownKeys(obj, allowed, path) };
}

function optionalScalar(
  errors: ValidationError[],
  obj: Record<string, unknown>,
  key: string,
  type: string,
  path: string,
): void {
  if (obj[key] !== undefined) pushType(errors, obj[key], type, joinPath(path, key));
}

function requireScalar(
  errors: ValidationError[],
  obj: Record<string, unknown>,
  key: string,
  type: string,
  path: string,
): void {
  if (obj[key] === undefined) {
    errors.push({ path, message: `missing required field "${key}"` });
    return;
  }
  pushType(errors, obj[key], type, joinPath(path, key));
}

function optionalScalarArray(
  errors: ValidationError[],
  obj: Record<string, unknown>,
  key: string,
  type: string,
  path: string,
): void {
  if (obj[key] === undefined) return;
  const arrPath = joinPath(path, key);
  const e = checkType(obj[key], "array", arrPath);
  if (e) {
    errors.push(e);
    return;
  }
  for (const [i, v] of (obj[key] as unknown[]).entries()) {
    pushType(errors, v, type, `${arrPath}[${i}]`);
  }
}

function optionalArrayOf(
  errors: ValidationError[],
  obj: Record<string, unknown>,
  key: string,
  path: string,
  validator: Validator,
): void {
  if (obj[key] === undefined) return;
  const arrPath = joinPath(path, key);
  const e = checkType(obj[key], "array", arrPath);
  if (e) {
    errors.push(e);
    return;
  }
  for (const [i, v] of (obj[key] as unknown[]).entries()) {
    errors.push(...validator(v, `${arrPath}[${i}]`));
  }
}

function optionalRecordOf(
  errors: ValidationError[],
  obj: Record<string, unknown>,
  key: string,
  path: string,
  validator: Validator,
): void {
  if (obj[key] === undefined) return;
  const subPath = joinPath(path, key);
  const e = checkType(obj[key], "object", subPath);
  if (e) {
    errors.push(e);
    return;
  }
  for (const [k, v] of Object.entries(obj[key] as Record<string, unknown>)) {
    errors.push(...validator(v, joinPath(subPath, k)));
  }
}

function optionalSubobject(
  errors: ValidationError[],
  obj: Record<string, unknown>,
  key: string,
  path: string,
  validator: Validator,
): void {
  if (obj[key] !== undefined) {
    errors.push(...validator(obj[key], joinPath(path, key)));
  }
}

function requireSubobject(
  errors: ValidationError[],
  obj: Record<string, unknown>,
  key: string,
  path: string,
  validator: Validator,
): void {
  if (obj[key] === undefined) {
    errors.push({ path, message: `missing required field "${key}"` });
    return;
  }
  errors.push(...validator(obj[key], joinPath(path, key)));
}

function validatePortNumber(
  val: unknown,
  path: string,
  typeMessage: string,
): ValidationError | null {
  if (typeof val !== "number" || !Number.isInteger(val)) {
    return { path, message: typeMessage };
  }
  if (val < 1 || val > 65535) {
    return { path, message: `port must be 1-65535, got ${val}` };
  }
  return null;
}

function validateQueryMatcher(val: unknown, path: string): ValidationError[] {
  if (typeof val === "string") return [];
  if (val === null || typeof val !== "object" || Array.isArray(val)) {
    return [{ path, message: `expected string or object with "any", got ${typeof val}` }];
  }
  const obj = val as Record<string, unknown>;
  const errors = unknownKeys(obj, QUERY_MATCHER_KEYS, path);
  optionalScalarArray(errors, obj, "any", "string", path);
  return errors;
}

function validateL7Allow(val: unknown, path: string): ValidationError[] {
  const { obj, errors } = expectObject(val, path, L7_ALLOW_KEYS);
  if (!obj) return errors;
  for (const f of ["method", "path", "command"] as const) {
    optionalScalar(errors, obj, f, "string", path);
  }
  optionalRecordOf(errors, obj, "query", path, validateQueryMatcher);
  return errors;
}

function validateL7Rule(val: unknown, path: string): ValidationError[] {
  const { obj, errors } = expectObject(val, path, L7_RULE_KEYS);
  if (!obj) return errors;
  requireSubobject(errors, obj, "allow", path, validateL7Allow);
  return errors;
}

function validateL7Deny(val: unknown, path: string): ValidationError[] {
  const { obj, errors } = expectObject(val, path, L7_DENY_KEYS);
  if (!obj) return errors;
  for (const f of ["method", "path", "command"] as const) {
    optionalScalar(errors, obj, f, "string", path);
  }
  optionalRecordOf(errors, obj, "query", path, validateQueryMatcher);
  return errors;
}

function validateCredInjectHeader(val: unknown, path: string): ValidationError[] {
  const { obj, errors } = expectObject(val, path, CRED_INJECT_HEADER_KEYS);
  if (!obj) return errors;
  for (const f of ["header", "from_credential"] as const) {
    requireScalar(errors, obj, f, "string", path);
  }
  return errors;
}

function validateCredInject(val: unknown, path: string): ValidationError[] {
  const { obj, errors } = expectObject(val, path, CRED_INJECT_KEYS);
  if (!obj) return errors;
  optionalScalar(errors, obj, "provider", "string", path);
  optionalScalarArray(errors, obj, "strip_headers", "string", path);
  optionalArrayOf(errors, obj, "inject", path, validateCredInjectHeader);
  return errors;
}

function validateTrustCheck(val: unknown, path: string): ValidationError[] {
  const { obj, errors } = expectObject(val, path, TRUST_CHECK_KEYS);
  if (!obj) return errors;
  requireScalar(errors, obj, "registry", "string", path);
  return errors;
}

function validateEndpointPort(errors: ValidationError[], val: unknown, path: string): void {
  const e = validatePortNumber(val, path, `expected integer, got ${typeof val}`);
  if (e) errors.push(e);
}

function validateEndpointPorts(errors: ValidationError[], val: unknown, path: string): void {
  const t = checkType(val, "array", path);
  if (t) {
    errors.push(t);
    return;
  }
  for (const [i, v] of (val as unknown[]).entries()) {
    const e = validatePortNumber(v, `${path}[${i}]`, "expected integer");
    if (e) errors.push(e);
  }
}

function validateEndpoint(val: unknown, path: string): ValidationError[] {
  const { obj, errors } = expectObject(val, path, ENDPOINT_KEYS);
  if (!obj) return errors;
  requireScalar(errors, obj, "host", "string", path);
  if (obj.port !== undefined) validateEndpointPort(errors, obj.port, joinPath(path, "port"));
  if (obj.ports !== undefined) validateEndpointPorts(errors, obj.ports, joinPath(path, "ports"));
  for (const f of ["protocol", "tls", "enforcement", "access"] as const) {
    optionalScalar(errors, obj, f, "string", path);
  }
  optionalArrayOf(errors, obj, "rules", path, validateL7Rule);
  optionalScalarArray(errors, obj, "allowed_ips", "string", path);
  optionalArrayOf(errors, obj, "deny_rules", path, validateL7Deny);
  optionalScalar(errors, obj, "allow_encoded_slash", "boolean", path);
  optionalScalar(errors, obj, "echo", "boolean", path);
  optionalSubobject(errors, obj, "cred_inject", path, validateCredInject);
  optionalSubobject(errors, obj, "trust_check", path, validateTrustCheck);
  return errors;
}

function validateBinary(val: unknown, path: string): ValidationError[] {
  const { obj, errors } = expectObject(val, path, BINARY_KEYS);
  if (!obj) return errors;
  requireScalar(errors, obj, "path", "string", path);
  optionalScalar(errors, obj, "harness", "boolean", path);
  return errors;
}

function validateNetworkPolicy(val: unknown, path: string): ValidationError[] {
  const { obj, errors } = expectObject(val, path, NETWORK_POLICY_KEYS);
  if (!obj) return errors;
  optionalScalar(errors, obj, "name", "string", path);
  optionalArrayOf(errors, obj, "endpoints", path, validateEndpoint);
  optionalArrayOf(errors, obj, "binaries", path, validateBinary);
  optionalScalarArray(errors, obj, "allowed_secrets", "string", path);
  return errors;
}

function validateFilesystem(val: unknown, path: string): ValidationError[] {
  const { obj, errors } = expectObject(val, path, FILESYSTEM_KEYS);
  if (!obj) return errors;
  optionalScalar(errors, obj, "include_workdir", "boolean", path);
  for (const f of ["read_only", "read_write"] as const) {
    optionalScalarArray(errors, obj, f, "string", path);
  }
  return errors;
}

function validateLandlock(val: unknown, path: string): ValidationError[] {
  const { obj, errors } = expectObject(val, path, LANDLOCK_KEYS);
  if (!obj) return errors;
  optionalScalar(errors, obj, "compatibility", "string", path);
  return errors;
}

function validateProcess(val: unknown, path: string): ValidationError[] {
  const { obj, errors } = expectObject(val, path, PROCESS_KEYS);
  if (!obj) return errors;
  for (const f of ["run_as_user", "run_as_group"] as const) {
    optionalScalar(errors, obj, f, "string", path);
  }
  return errors;
}

function validateVersion(errors: ValidationError[], obj: Record<string, unknown>): void {
  if (obj.version === undefined) {
    errors.push({ path: "version", message: "missing required field" });
    return;
  }
  if (typeof obj.version !== "number" || !Number.isInteger(obj.version)) {
    errors.push({ path: "version", message: `expected integer, got ${typeof obj.version}` });
  }
}

export function validateSchema(doc: unknown): ValidationError[] {
  const t = checkType(doc, "object", "");
  if (t) return [t];
  const obj = doc as Record<string, unknown>;
  const errors = unknownKeys(obj, TOP_LEVEL_KEYS, "");
  validateVersion(errors, obj);
  optionalSubobject(errors, obj, "filesystem_policy", "", validateFilesystem);
  optionalSubobject(errors, obj, "landlock", "", validateLandlock);
  optionalSubobject(errors, obj, "process", "", validateProcess);
  optionalRecordOf(errors, obj, "network_policies", "", validateNetworkPolicy);
  return errors;
}
