import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { URI } from 'vscode-uri';

import { unmarshalType, unmarshalValue } from '../cty-json';
import { parseJsonDocument } from '../functions/utils';
import type { RuntimeValue, ValueType } from '../model';

import type { TerraformState } from './model';


export class StateManager {
	private stateCache = new Map<string, TerraformState>();

	constructor() { }

	/**
	 * Finds and reads the terraform.tfstate file in the same directory as the given URI
	 */
	public async findState(documentUri: string): Promise<TerraformState | undefined> {
		if (this.stateCache.has(documentUri)) {
			return this.stateCache.get(documentUri);
		}

		const parsedUri = URI.parse(documentUri);
		const directory = path.dirname(parsedUri.fsPath);

		const possiblePaths = [
				path.join(directory, 'terraform.tfstate'),
				path.join(directory, '.terraform', 'terraform.tfstate')
			];

		for (const statePath of possiblePaths) {
			try {
				const stateContent = await fs.readFile(statePath, 'utf8');
				const state = parseJsonDocument(stateContent) as TerraformState;
				this.stateCache.set(documentUri, state);
				return state;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
				throw new Error(`Unable to read Terraform state ${statePath}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		return undefined;
	}

	/**
	 * Gets all outputs from the state file
	 */
	public async getAllOutputs(documentUri: string): Promise<Map<string, RuntimeValue<ValueType>>> {
		const outputs = new Map<string, RuntimeValue<ValueType>>();
		const state = await this.findState(documentUri);

		if (!state?.outputs) return outputs;

		for (const [name, output] of Object.entries(state.outputs)) {
			outputs.set(name, this.convertToRuntimeValue(output.value, output.type));
		}

		return outputs;
	}

	/**
	 * Gets a specific output by name
	 */
	public async getOutput(documentUri: string, name: string): Promise<RuntimeValue<ValueType> | undefined> {
		const state = await this.findState(documentUri);
		const output = state?.outputs?.[name];

		if (!output) return undefined;

		return this.convertToRuntimeValue(output.value, output.type);
	}

	/**
	 * An output's value decoded as of the type the state records for it, as Terragrunt decodes a dependency's outputs
	 * from a state file.
	 */
	private convertToRuntimeValue(value: unknown, type: unknown): RuntimeValue<ValueType> {
		return unmarshalValue(value, unmarshalType(type));
	}

	/**
	 * Invalidates the cache for a specific document
	 */
	public invalidateCache(documentUri: string): void {
		this.stateCache.delete(documentUri);
	}
}
