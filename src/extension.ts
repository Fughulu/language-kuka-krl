"use strict";
import * as vscode from "vscode";

const KRL_SELECTOR: vscode.DocumentSelector = { language: "krl" };
const KRL_FILES_GLOB = "**/*.{src,dat,sub}";

const PROC_DECLARATION = /^\s*(?:GLOBAL\s+)?DEF\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/i;
const FUNC_DECLARATION = /^\s*(?:GLOBAL\s+)?DEFFCT\s+\S+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/i;

const RESERVED_WORDS = new Set<string>([
    "CASE",
    "DEF",
    "DEFDAT",
    "DEFFCT",
    "DEFAULT",
    "ELSE",
    "END",
    "ENDDAT",
    "ENDFCT",
    "ENDFOR",
    "ENDIF",
    "ENDLOOP",
    "ENDSWITCH",
    "ENDWHILE",
    "FOR",
    "GLOBAL",
    "IF",
    "LOOP",
    "REPEAT",
    "RETURN",
    "SWITCH",
    "THEN",
    "UNTIL",
    "WHILE",
]);

type FunctionDefinition = {
    name: string;
    range: vscode.Range;
    selectionRange: vscode.Range;
    location: vscode.Location;
};

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDefinitionLine(line: string): string | undefined {
    const procMatch = PROC_DECLARATION.exec(line);
    if (procMatch) {
        return procMatch[1];
    }

    const funcMatch = FUNC_DECLARATION.exec(line);
    if (funcMatch) {
        return funcMatch[1];
    }

    return undefined;
}

function getNameRange(lineText: string, line: number, name: string): vscode.Range {
    const nameRegex = new RegExp(`\\b${escapeRegex(name)}\\b`, "i");
    const match = nameRegex.exec(lineText);

    if (!match) {
        return new vscode.Range(line, 0, line, 0);
    }

    return new vscode.Range(line, match.index, line, match.index + match[0].length);
}

function parseFunctionDefinitions(document: vscode.TextDocument): FunctionDefinition[] {
    const definitions: FunctionDefinition[] = [];

    for (let line = 0; line < document.lineCount; line++) {
        const lineText = document.lineAt(line).text;
        const name = parseDefinitionLine(lineText);

        if (!name) {
            continue;
        }

        const selectionRange = getNameRange(lineText, line, name);
        const range = document.lineAt(line).range;

        definitions.push({
            name,
            range,
            selectionRange,
            location: new vscode.Location(document.uri, selectionRange),
        });
    }

    return definitions;
}

async function getKrlDocuments(): Promise<vscode.TextDocument[]> {
    const docsByUri = new Map<string, vscode.TextDocument>();

    for (const document of vscode.workspace.textDocuments) {
        if (document.languageId === "krl") {
            docsByUri.set(document.uri.toString(), document);
        }
    }

    const uris = await vscode.workspace.findFiles(KRL_FILES_GLOB, "**/node_modules/**");
    for (const uri of uris) {
        const document = await vscode.workspace.openTextDocument(uri);
        docsByUri.set(document.uri.toString(), document);
    }

    return Array.from(docsByUri.values());
}

function getSymbolAtPosition(document: vscode.TextDocument, position: vscode.Position): string | undefined {
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!wordRange) {
        return undefined;
    }

    const word = document.getText(wordRange);
    if (RESERVED_WORDS.has(word.toUpperCase())) {
        return undefined;
    }

    return word;
}

async function findDefinitionsInWorkspace(symbol: string): Promise<vscode.Location[]> {
    const documents = await getKrlDocuments();
    const target = symbol.toLowerCase();
    const locations: vscode.Location[] = [];

    for (const document of documents) {
        for (const definition of parseFunctionDefinitions(document)) {
            if (definition.name.toLowerCase() === target) {
                locations.push(definition.location);
            }
        }
    }

    return locations;
}

function findCallRanges(document: vscode.TextDocument, symbol: string): vscode.Range[] {
    const ranges: vscode.Range[] = [];
    const callRegex = new RegExp(`\\b${escapeRegex(symbol)}\\b\\s*\\(`, "ig");

    for (let line = 0; line < document.lineCount; line++) {
        const lineText = document.lineAt(line).text;

        // Avoid returning declaration lines as usages.
        const declarationName = parseDefinitionLine(lineText);

        callRegex.lastIndex = 0;
        let match = callRegex.exec(lineText);
        while (match) {
            const matchedName = match[0].replace(/\s*\($/, "");
            const isDeclaration = declarationName !== undefined
                && declarationName.toLowerCase() === matchedName.toLowerCase();

            if (!isDeclaration) {
                ranges.push(new vscode.Range(line, match.index, line, match.index + matchedName.length));
            }

            match = callRegex.exec(lineText);
        }
    }

    return ranges;
}

class KrlDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
    public provideDocumentSymbols(document: vscode.TextDocument): vscode.SymbolInformation[] {
        return parseFunctionDefinitions(document).map((definition) => {
            return new vscode.SymbolInformation(
                definition.name,
                vscode.SymbolKind.Function,
                "KRL",
                definition.location,
            );
        });
    }
}

class KrlDefinitionProvider implements vscode.DefinitionProvider {
    public async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
    ): Promise<vscode.Definition | undefined> {
        const symbol = getSymbolAtPosition(document, position);
        if (!symbol) {
            return undefined;
        }

        const definitions = await findDefinitionsInWorkspace(symbol);
        if (definitions.length === 0) {
            return undefined;
        }

        return definitions.length === 1 ? definitions[0] : definitions;
    }
}

class KrlReferenceProvider implements vscode.ReferenceProvider {
    public async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.ReferenceContext,
    ): Promise<vscode.Location[]> {
        const symbol = getSymbolAtPosition(document, position);
        if (!symbol) {
            return [];
        }

        const documents = await getKrlDocuments();
        const references: vscode.Location[] = [];

        const definitions = await findDefinitionsInWorkspace(symbol);
        if (context.includeDeclaration) {
            references.push(...definitions);
        }

        for (const textDocument of documents) {
            const callRanges = findCallRanges(textDocument, symbol);
            for (const range of callRanges) {
                references.push(new vscode.Location(textDocument.uri, range));
            }
        }

        return references;
    }
}

export function activate(context: vscode.ExtensionContext) {
    vscode.languages.setLanguageConfiguration("krl", {
        indentationRules: {
            decreaseIndentPattern: new RegExp(
                /^\s*(ENDFOR|ELSE|ENDIF|ENDLOOP|UNTIL.*|ENDWHILE|ENDSWITCH|CASE.*|DEFAULT.*)\s*(;.*)?$/, "i"),
            increaseIndentPattern: new RegExp(
                /^\s*(FOR.*|IF.*|ELSE|LOOP|REPEAT|WHILE.*|SWITCH.*|CASE.*|DEFAULT.*)\s*(;.*)?$/, "i"),
        },
    });

    context.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider(KRL_SELECTOR, new KrlDocumentSymbolProvider()),
        vscode.languages.registerDefinitionProvider(KRL_SELECTOR, new KrlDefinitionProvider()),
        vscode.languages.registerReferenceProvider(KRL_SELECTOR, new KrlReferenceProvider()),
    );
}
