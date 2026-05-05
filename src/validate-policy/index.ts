import { readFileSync } from "fs";
import * as yaml from "js-yaml";
import { validateSchema, type ValidationError } from "./schema";
import { validateSemantics } from "./semantic";

export { type ValidationError } from "./schema";

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

  return validateSemantics(doc as any);
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
