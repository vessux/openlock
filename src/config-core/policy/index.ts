import { readFileSync } from "node:fs";
import * as yaml from "js-yaml";
import type { Issue } from "../types";
import { type ValidationError, validateSchema } from "./schema";
import { validateSemantics } from "./semantic";
import type { PolicyFile } from "./types";

export type { ValidationError } from "./schema";
export { ALL_POLICY_KEYS } from "./schema";

export function validatePolicyYaml(content: string): ValidationError[] {
  let doc: unknown;
  try {
    doc = yaml.load(content);
  } catch (e) {
    return [{ path: "", message: `YAML parse error: ${(e as Error).message}` }];
  }

  if (doc === null || doc === undefined) {
    return [{ path: "", message: "empty document" }];
  }

  const schemaErrors = validateSchema(doc);
  if (schemaErrors.length > 0) return schemaErrors;

  // doc has been validated by validateSchema above, so it conforms to PolicyFile.
  return validateSemantics(doc as PolicyFile);
}

export function validatePolicyFile(path: string): ValidationError[] {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (e) {
    return [{ path: "", message: `cannot read file: ${(e as Error).message}` }];
  }
  return validatePolicyYaml(content);
}

export function formatErrors(errors: ValidationError[], filePath?: string): string {
  if (errors.length === 0) return "";
  const prefix = filePath ? `${filePath}: ` : "";
  return errors
    .map((e) => {
      const loc = e.path ? `${e.path}: ` : "";
      return `  ${prefix}${loc}${e.message}`;
    })
    .join("\n");
}

/** Adapt the policy validator's single-severity errors to the unified Issue
 * shape consumed by lintFolder. */
export function lintPolicy(content: string): Issue[] {
  return validatePolicyYaml(content).map((e) => ({
    file: "policy.yaml" as const,
    severity: "error" as const,
    path: e.path,
    message: e.message,
  }));
}
