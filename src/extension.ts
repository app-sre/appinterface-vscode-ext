// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import YAML, { Document, YAMLMap } from "yaml";

import {
  Diagnostic,
  DiagnosticSeverity,
  ExtensionContext,
  languages,
  Position,
  Range,
  TextDocument,
  TextDocumentChangeEvent,
  workspace,
} from "vscode";

import type { Ajv as AjvType } from "ajv";
import Ajv from "ajv";
const URI = require("uri-js");

function loadMetaSchema(ajv: any, basePath: string, schemaPath: string) {
  try {
    const schemaText = readFileSync(basePath + schemaPath, "utf8");
    const schema = JSON.parse(schemaText);
    const schemaId = schema.$id || schemaPath;
    ajv.addMetaSchema(schema, schemaId);
    console.log(`Loaded meta-schema: ${schemaId}`);
  } catch (e) {
    console.error(`Failed to load meta-schema from ${schemaPath}:`, e);
  }
}

function loadSchemasRecursively(ajv: any, basePath: string, dir: string) {
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      // Recursively load schemas in subfolder
      loadSchemasRecursively(ajv, basePath, fullPath);
    } else if (stat.isFile() && fullPath.endsWith(".yml")) {
      // Load and add the YAML schema
      const schemaText = readFileSync(fullPath, "utf8");
      try {
        const schema = YAML.parseDocument(schemaText) as Document.Parsed;
        const schemaId =
          (schema.contents as YAMLMap).get("$id") ||
          fullPath.slice(basePath.length); // Use $id or fallback to filename as key
        ajv.addSchema(schema.toJSON(), schemaId);
        console.log(`Loaded schema: ${schemaId}`);
      } catch (e) {
        console.error(`Failed to parse schema at ${fullPath}:`, e);
      }
    }
  }
}

function createAjvValidator(schemaDir: string): AjvType {
  const ajv = new Ajv({ strict: false, allErrors: true, verbose: true });
  const addFormats = require("ajv-formats");
  addFormats(ajv);
  // Override "uri" to match jsonschema's RFC 3986 logic
  ajv.addFormat("uri", {
    type: "string",
    validate: (str: string): boolean => {
      const result = URI.parse(str);
      // Consider it valid if it has no "error" and has at least a hostname or path
      return (
        !result.error && (!!result.scheme || !!result.host || !!result.path)
      );
    },
  });
  loadMetaSchema(ajv, schemaDir, "/json-schema-spec-draft-06.json");
  loadMetaSchema(ajv, schemaDir, "/common-1.json");
  loadMetaSchema(ajv, schemaDir, "/metaschema-1.json");
  loadSchemasRecursively(ajv, schemaDir, schemaDir);
  return ajv;
}

function isUserEditInWorkspace(event: TextDocumentChangeEvent): boolean {
  const workspaceFolder = workspace.getWorkspaceFolder(event.document.uri);
  if (workspaceFolder) {
    return true;
  }
  return false;
}

function deduplicateDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((d) => {
    const key = `${d.range.start.line}:${d.range.start.character}-${d.range.end.line}:${d.range.end.character}-${d.message}-${d.severity}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function getYamlPathPosition(
  document: TextDocument,
  yamlDoc: Record<string, any>,
  yamlPath: string[],
): Range {
  const defaultRange = new Range(new Position(0, 0), new Position(0, 1));
  let node: any = yamlDoc;
  for (const segment of yamlPath) {
    if (segment === "") {
      continue;
    } // Skip empty segments
    if (!node || typeof node.get !== "function") {
      return defaultRange;
    } // If node is not an object or does not have a get method, return default range
    node = node.get(segment, true); // true = keep node metadata
  }

  if (node?.range && Array.isArray(node.range)) {
    const [startOffset, , endOffset] = node.range;
    const start = document.positionAt(startOffset);
    const end = document.positionAt(endOffset);
    return new Range(start, end);
  }

  return defaultRange; // If node is not found or does not have a range, return default range
}

async function validateAppInterfaceManifest(
  ajv: AjvType,
  textDocument: TextDocument,
): Promise<Diagnostic[]> {
  // In this simple example we get the settings for every validate run.
  //const settings = await getDocumentSettings(textDocument.uri);

  // The validator creates diagnostics for all uppercase words length 2 and more
  const text = textDocument.getText();
  const diagnostics: Diagnostic[] = [];
  let content: Record<string, any> = {};

  try {
    content = YAML.parseDocument(text) as Document.Parsed;
  } catch (e) {
    console.error(`Failed to parse YAML in document ${textDocument.uri}:`, e);
    const diagnostic: Diagnostic = {
      severity: DiagnosticSeverity.Error,
      range: new Range(textDocument.positionAt(0), textDocument.positionAt(1)),
      message: "Invalid YAML document",
      source: "Yaml Parser",
    };
    diagnostics.push(diagnostic);
    return diagnostics;
  }

  let error_msg = "";
  try {
    const valid = ajv.validate(
      content.contents.get("$schema"),
      content.contents.toJSON(),
    );
    if (!valid && ajv.errors) {
      console.log("Validation errors:");
      for (const error of ajv.errors) {
        const error_path = error.instancePath || "/";
        switch (error.keyword) {
          case "additionalProperties":
            error_msg = `Unexpected property '${error.params.additionalProperty}' at ${error_path}`;
            break;
          case "required":
            error_msg = `Missing property '${error.params.missingProperty}' at ${error_path}`;
            break;
          default:
            error_msg = `At ${error_path}: ${error.message}`;
        }
        const diagnostic: Diagnostic = {
          severity: DiagnosticSeverity.Error,
          range: getYamlPathPosition(
            textDocument,
            content,
            error_path.split("/"),
          ),
          message: error_msg,
          source: "AppInterface Schema Validator",
        };
        diagnostics.push(diagnostic);
      }
    }
  } catch (e) {
    (error_msg = `Failed to validate document ${textDocument.uri}:`), e;
    console.error(error_msg);
    const diagnostic: Diagnostic = {
      severity: DiagnosticSeverity.Error,
      range: new Range(textDocument.positionAt(0), textDocument.positionAt(1)),
      message: error_msg,
      source: "AppInterface Schema Validator",
    };
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}

function getAjvValidator(
  validatorsMap: Map<string, AjvType>,
  workspaceFolder: string,
): AjvType {
  if (!validatorsMap.has(workspaceFolder)) {
    console.log(`Creating AJV validator for ${workspaceFolder}`);
    const v = createAjvValidator(workspaceFolder + "/schemas");
    validatorsMap.set(workspaceFolder, v);
  }
  return validatorsMap.get(workspaceFolder)!;
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {
  const validatorsMap: Map<string, AjvType> = new Map<string, AjvType>();
  const diagnosticCollection =
    languages.createDiagnosticCollection("appinterface");
  workspace.onDidChangeTextDocument((event) => {
    if (isUserEditInWorkspace(event) && event.document.languageId === "yaml") {
      const workspaceFolder = workspace
        .getWorkspaceFolder(event.document.uri)
        ?.uri.path.toString();
      const ajv = getAjvValidator(validatorsMap, workspaceFolder || "");
      diagnosticCollection.set(event.document.uri, []);
      console.log("Document changed:", event.document.uri.toString());
      validateAppInterfaceManifest(ajv, event.document)
        .then((diagnostics) => {
          diagnosticCollection.set(
            event.document.uri,
            deduplicateDiagnostics(diagnostics),
          );
          console.log(
            `Diagnostics set for ${event.document.uri.toString()}:`,
            diagnostics,
          );
        })
        .catch((err) => {
          console.error(
            `Error validating document ${event.document.uri.toString()}:`,
            err,
          );
          // Optionally, you can show an error message to the user
          //vscode.window.showErrorMessage(`Error validating document ${event.document.uri.toString()}: ${err.message}`);
        });
    }
  });
}

// This method is called when your extension is deactivated
export function deactivate() {}
