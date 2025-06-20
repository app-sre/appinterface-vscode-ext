// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import YAML, {
  Document,
  isScalar,
  isSeq,
  Node,
  Pair,
  Scalar,
  YAMLMap,
  YAMLSeq,
} from "yaml";

import {
  CompletionItem,
  CompletionItemKind,
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
  //const yamlDoc = YAML.parseDocument(document.getText(), { keepCstNodes: true } as any);
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
    content = YAML.parseDocument(text, {
      keepCstNodes: true,
    } as any) as Document.Parsed;
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

function getNodeAtPath(
  node: YAMLMap | any,
  path: (string | number)[],
): any {
  let current = node;

  for (const key of path) {
    if (current instanceof YAMLMap) {
      const pair = current.items.find((pair) => {
        const k = pair.key;
        return k && k.value === key;
      });
      current = pair?.value;
    } else if (isSeq(current)) {
      if (typeof key === "number" && current.items[key]) {
        current = current.items[key];
      }
    } else {
      // If we can't navigate further, return undefined
      return undefined;
    }
  }
  return current;
}

function findPathAtOffset(
  node: Node | null | undefined,
  offset: number,
  path: (string | number)[] = [],
): (string | number)[] {
  if (!node || !node.range) {
    return [];
  }

  const [start, end] = node.range;
  if (offset < start || offset >= end) {
    return [];
  }

  if (node instanceof YAMLMap) {
    for (const pair of node.items) {
      const keyNode = pair.key as Node;
      const valueNode = pair.value as Node;

      // Handle key
      if (keyNode && keyNode.range) {
        const [kStart, kEnd] = keyNode.range;
        if (offset >= kStart && offset < kEnd) {
          const key = isScalar(keyNode)
            ? keyNode.value
            : String(keyNode.toString());
          if (typeof key === "string" || typeof key === "number") {
            return [...path, key];
          }
        }
      }
      // Handle value
      if (valueNode && valueNode.range) {
        const [vStart, vEnd] = valueNode.range;
        if (offset >= vStart && offset < vEnd) {
          const key = isScalar(keyNode)
            ? keyNode.value
            : String(keyNode?.toString?.() ?? "");
          if (typeof key === "string" || typeof key === "number") {
            const subPath = findPathAtOffset(valueNode, offset, [...path, key]);
            if (subPath) {
              return subPath;
            }
          }
        }
      }
    }
    return path;
  }

  if (node instanceof YAMLSeq) {
    for (let i = 0; i < node.items.length; i++) {
      const item = node.items[i] as Node;
      if (item && item.range) {
        const [iStart, iEnd] = item.range;
        if (offset >= iStart && offset < iEnd) {
          const subPath = findPathAtOffset(item, offset, [...path, i]);
          if (subPath) {
            return subPath;
          }
        }
      }
    }
    return path;
  }

  // Scalars or other nodes
  return path;
}

function resolveSchema(
  ajv: AjvType,
  schema: Record<string, any>,
  path: (string | number)[],
  rootNode: YAML.Node | null,
): any | undefined {
  console.log(`Resolve sub: ${path}`);
  let current = schema;
  let currentPath: (string | number)[] = [];
  let currentNode: any;

  for (const [index, key] of path.entries()) {
    currentPath = path.slice(0, index + 1);
    currentNode = getNodeAtPath(rootNode, currentPath);
    
    // First, resolve any $ref
    if (current?.$ref) {
      console.warn(`$ref encountered: ${current.$ref} – needs resolution`);
      const refSchema = ajv.getSchema(current.$ref)?.schema;
      if (refSchema) {
        current = refSchema as Record<string, any>;
      }
    }
    
    // Handle oneOf/anyOf schemas
    if (schemaHasMultipleOptions(current)) {
      const matchedSchema = findMatchingSchema(ajv, current, currentNode?.toJSON());
      if (matchedSchema === -1) {
        return undefined;
      }
      current = matchedSchema;
    }
    
    // Navigate based on schema type and key
    if (typeof key === "string" && current?.type === "object" && current.properties?.[key]) {
      current = current.properties[key];
    } else if (typeof key === "number" && current?.type === "array") {
      current = current.items;
    } else {
      // Can't navigate further with this key
      console.log(`Cannot navigate to key ${key} in schema type ${current?.type}`);
      return current; // Return what we have so far
    }
  }

  // Final check for oneOf/anyOf at the end
  if (schemaHasMultipleOptions(current)) {
    const nodeJson = currentNode?.toJSON();
    const matchedSchema = findMatchingSchema(ajv, current, nodeJson);
    if (matchedSchema === -1) {
      return undefined;
    }
    current = matchedSchema;
  }

  return current;
}

function getAttributesFromNode(mapNode: any): string[] {
  if (!(mapNode instanceof YAMLMap) || !mapNode.items) {
    return [];
  }
  
  return mapNode.items.map((pair) => {
    const p = pair as Pair;
    const keyNode = p.key as Scalar;
    const keyVal = keyNode?.value;
    return String(keyVal);
  }).filter(key => key !== 'undefined' && key !== 'null');
}

function schemaHasMultipleOptions(schema: any): boolean {
  return Array.isArray(schema.oneOf);
}

function validatesSchema(
  ajv: AjvType,
  schema: Record<string, any>,
  value: any,
): boolean {
  try {
    const validate = ajv.compile(schema);
    return validate(value);
  } catch (error) {
    console.error("Error validating schema:", error);
    return false;
  }
}

function findMatchingSchema(ajv: AjvType, schema: any, nodeJson: any): any {
  if (!schemaHasMultipleOptions(schema)) {
    return validatesSchema(ajv, schema, nodeJson) ? schema : -1;
  }

  for (let i = 0; i < schema.oneOf.length; i++) {
    let s: any = schema.oneOf[i];
    console.debug(`Checking schema: ${s}`);
    if (s.$ref) {
      s = ajv.getSchema(s.$ref)?.schema;
      if (schemaHasMultipleOptions(s)) {
        return findMatchingSchema(ajv, s, nodeJson);
      }
    }
    if (validatesSchema(ajv, s, nodeJson)) {
      return s;
    }
  }
  return -1; // no oneOf option matched
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: ExtensionContext) {
  const validatorsMap: Map<string, AjvType> = new Map<string, AjvType>();
  const diagnosticCollection =
    languages.createDiagnosticCollection("appinterface");
  workspace.onDidChangeTextDocument((event) => {
    if (isUserEditInWorkspace(event)) {
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

  const provider = languages.registerCompletionItemProvider(
    { language: "App-Interface" },
    {
      provideCompletionItems(document, position, token, ctx) {
        try {
          const workspaceFolder = workspace
            .getWorkspaceFolder(document.uri)
            ?.uri.path.toString();
          
          if (!workspaceFolder) {
            console.log("No workspace folder found");
            return [];
          }
          
          const ajv = getAjvValidator(validatorsMap, workspaceFolder);
          const text = document.getText();

          if (!text.trim()) {
            console.log("Document is empty");
            return [];
          }

          const content = YAML.parseDocument(text, {
            keepSourceTokens: true,
            keepNodeTypes: true,
          } as any) as Document.Parsed;
          
          if (!content?.contents) {
            console.log("Could not parse YAML document contents");
            return [];
          }
          
          const manifestSchemaId = (content.contents as YAMLMap)?.get(
            "$schema",
          ) as string;
          
          if (!manifestSchemaId) {
            console.log("No $schema found in document");
            return [];
          }
          
          const manifestSchema = ajv.getSchema(manifestSchemaId)?.schema as {
            properties: Record<string, any>;
          };
          
          if (!manifestSchema) {
            console.log(`Schema ${manifestSchemaId} not found`);
            return [];
          }

          // Get Path and Node where the cursor is located.
          const offset = document.offsetAt(position);
          const currentPath = findPathAtOffset(content.contents, offset);
          const currentNode = getNodeAtPath(content.contents, currentPath);
          
          console.log(`Current path: ${JSON.stringify(currentPath)}`);
          console.log(`Current node type: ${currentNode?.constructor?.name || 'undefined'}`);
          
          if (!currentNode || !(currentNode instanceof YAMLMap)) {
            console.log("Current node is not a YAMLMap, cannot provide completions");
            return [];
          }
          
          const currentNodeSchema = resolveSchema(
            ajv,
            manifestSchema,
            currentPath,
            content.contents,
          );

          if (!currentNodeSchema) {
            console.log("Could not resolve schema for current path");
            return [];
          }

          const currentSchemaProperties = currentNodeSchema?.properties;
          if (!currentSchemaProperties || typeof currentSchemaProperties !== 'object') {
            console.log("No properties found in current schema");
            return [];
          }
          
          const currentNodeProperties = getAttributesFromNode(currentNode);
          console.log(`Current node properties: ${JSON.stringify(currentNodeProperties)}`);

          const completionItems = Object.keys(currentSchemaProperties)
            .filter(key => !currentNodeProperties.includes(key))
            .map(key => {
              console.debug(`Adding completion item: ${key}`);
              const item = new CompletionItem(key, CompletionItemKind.Property);
              const propSchema = currentSchemaProperties[key];
              item.detail = propSchema?.type || "";
              item.documentation = propSchema?.description || "";
              return item;
            });

          console.log(`Returning ${completionItems.length} completion items`);
          return completionItems;
        } catch (error) {
          console.error("Error in completion provider:", error);
          return [];
        }
      },
    },
  );
  context.subscriptions.push(provider);
}

// This method is called when your extension is deactivated
export function deactivate() {}
