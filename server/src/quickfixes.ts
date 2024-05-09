import { Diagnostic, CodeActionKind, CodeAction, WorkspaceEdit } from 'vscode-languageserver/node';
import {
	Range,
	TextDocument,
	TextEdit
} from 'vscode-languageserver-textdocument';
import { NonterminalKind, TerminalKind } from "@nomicfoundation/slang/kinds";
import { Namespace, Variable, printNamespaceTemplate, getNamespaceId } from './namespace';
import { Language } from '@nomicfoundation/slang/language';
import assert = require('node:assert');
import { NonterminalNode, TerminalNode } from '@nomicfoundation/slang/cst';
import { ContractDefinition } from '@nomicfoundation/slang/ast';
import { cursor, text_index } from '@nomicfoundation/slang';
import { slangToVSCodeRange } from './helpers/slang';
import { getSolidityVersion } from './server';

/**
 * Gets a quick fix for moving all variables into a namespace.
 */
export async function getMoveAllVariablesToNamespaceQuickFix(fixesDiagnostics: Diagnostic[], title: string, prefix: string, contractName: string, variables: Variable[], textDocument: TextDocument): Promise<CodeAction | undefined> {
	let namespaceStructEndRange: text_index.TextRange | undefined = undefined;

	const language = new Language(await getSolidityVersion(textDocument));
	const parseOutput = language.parse(NonterminalKind.SourceUnit, textDocument.getText());

	const cursor = parseOutput.createTreeCursor();

	let contractCursor;

	const edits: TextEdit[] = [];

	while (cursor.goToNextNonterminalWithKind(NonterminalKind.ContractDefinition)) {
		contractCursor = cursor.spawn();

		const cursorNode = contractCursor.node();
		assert(cursorNode instanceof NonterminalNode);
		const contractDef = new ContractDefinition(cursorNode);

		const parseContract = language.parse(NonterminalKind.ContractDefinition, cursorNode.unparse());
		if (!parseContract.isValid) {
			console.log("Contract has errors");
			continue;
		} else {
			console.log("Parsing contract: " + contractDef.name.text);
		}

		if (contractDef.name.text !== contractName) {
			// skip if its not the contract we are looking for
			continue;
		} else {
			namespaceStructEndRange = getNamespaceStructEndRange(contractCursor, prefix, contractName);
			editNamespaceVariablesInFunctions(contractCursor, contractName, variables, textDocument, edits);

			// only process the first contract that matches the contractName
			break;
		}
	}

	if (variables.length === 0) {
		return undefined;
	}

	if (namespaceStructEndRange === undefined) {
		editNewNamespace(edits);
	} else {
		editExistingNamespace(edits, namespaceStructEndRange);
	}

	let workspaceEdit: WorkspaceEdit = {
		changes: { [textDocument.uri]: [...edits] }
	};
	let codeAction: CodeAction = {
		title: title,
		kind: CodeActionKind.QuickFix,
		edit: workspaceEdit,
		diagnostics: fixesDiagnostics,
	};

	return codeAction;

	function editNewNamespace(edits: TextEdit[]) {
		const namespace: Namespace = {
			contractName,
			prefix,
			variables,
		};

		// for a new namespace, replace the first variable with the namespace, then delete the rest of the variables
		let insertVariableTextEdit: TextEdit = {
			range: variables[0].range,
			newText: printNamespaceTemplate(namespace),
		};
		edits.push(insertVariableTextEdit);

		for (const variable of variables.slice(1)) {
			let deleteVariableTextEdit: TextEdit = {
				range: variable.range,
				newText: ""
			};
			edits.push(deleteVariableTextEdit);
		}
	}

	function editExistingNamespace(edits: TextEdit[], structEndRange: text_index.TextRange, indent = "    ") {
		// for an existing namespace, delete all variables and insert them into the end of the struct
		for (const variable of variables) {
			let deleteVariableTextEdit: TextEdit = {
				range: variable.range,
				newText: ""
			};
			edits.push(deleteVariableTextEdit);

			let insertVariableTextEdit: TextEdit = {
				range: slangToVSCodeRange(textDocument, structEndRange),
				newText: `\
${indent}${variable.content}
${indent}}\
`
			};
			edits.push(insertVariableTextEdit);
		}
	}
}

function getNamespaceStructEndRange(contractCursor: cursor.Cursor, prefix: string, contractName: string): text_index.TextRange | undefined {
	const namespaceStructCursor = contractCursor.spawn();
	namespaceStructCursor.goToNextTerminalWithKind(TerminalKind.SingleLineNatSpecComment);
	const natspecNode = namespaceStructCursor.node();
	if (natspecNode instanceof TerminalNode) {
		const natspecText = natspecNode.text;

		if (natspecText.includes(`@custom:storage-location erc7201:${getNamespaceId(prefix, contractName)}`)) {
			// get range of the end of the struct
			const namespaceStructEndCursor = contractCursor.spawn();
			namespaceStructEndCursor.goToNextTerminalWithKind(TerminalKind.CloseBrace);
			return namespaceStructEndCursor.textRange;
		}
	}
	return undefined;
}

function editNamespaceVariablesInFunctions(contractCursor: cursor.Cursor, contractName: string, variables: Variable[], textDocument: TextDocument, edits: TextEdit[]) {
	// For each function, find all usage of given variables,
	// insert `MainStorage storage $ = _getMainStorage();` (where Main is the contract name) at the beginning of the function if it doesn't exist already,
	// and replace all usages of variables with `$.variableName`
	const functionBodyCursor = contractCursor.spawn();
	while (functionBodyCursor.goToNextNonterminalWithKind(NonterminalKind.FunctionBody)) {
		const functionBodyNode = functionBodyCursor.node();
		assert(functionBodyNode instanceof NonterminalNode);
		const functionText = functionBodyNode.unparse();
		const expectedLine = `${contractName}Storage storage $ = _get${contractName}Storage();`;

		let replacement = functionText;
		// replace all usages of variables with $.variableName
		variables.forEach((variable) => {
			const regex = new RegExp(`\\b${variable.name}\\b`, 'g');
			replacement = replacement.replace(regex, `$.${variable.name}`);
		});

		if (replacement !== functionText && !replacement.includes(expectedLine)) {
			// replace opening bracket with opening bracket and expected line
			const openingBracketIndex = replacement.indexOf('{');
			replacement = replacement.slice(0, openingBracketIndex) + '{\n        ' + expectedLine + '\n' + replacement.slice(openingBracketIndex + 1);
		}

		console.log('Replacing function with: ' + replacement);
		const edit: TextEdit = {
			range: slangToVSCodeRange(textDocument, functionBodyCursor.textRange),
			newText: replacement
		};
		edits.push(edit);

	}
}
