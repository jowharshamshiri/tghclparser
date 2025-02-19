import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { URI } from 'vscode-uri';

import type { RuntimeValue, ValueType } from '~/model';

import type { TerraformState } from './model';


export class StateManager {
	private stateCache = new Map<string, TerraformState>();

	constructor() { }

	/**
	 * Finds and reads the terraform.tfstate file in the same directory as the given URI
	 */
	public async findState(documentUri: string): Promise<TerraformState | undefined> {
		if (!fs?.readFile) {
			console.warn('No filesystem API available');
			return undefined;
		}
		try {
			// Check cache first
			if (this.stateCache.has(documentUri)) {
				return this.stateCache.get(documentUri);
			}
	
			const parsedUri = URI.parse(documentUri);
			const directory = path.dirname(parsedUri.fsPath);
			
			// Try both terraform.tfstate and .terraform/terraform.tfstate
			const possiblePaths = [
				path.join(directory, 'terraform.tfstate'),
				path.join(directory, '.terraform', 'terraform.tfstate')
			];
	
			for (const statePath of possiblePaths) {
				try {
					// console.log(`Checking for state file at: ${statePath}`);
					const stateContent = await fs.readFile(statePath);
					const stateText = new TextDecoder().decode(stateContent);
					const state = JSON.parse(stateText) as TerraformState;
	
					// Log what we found
					// if (state.outputs) {
					// 	console.log(`Found outputs in state file ${statePath}:`, Object.keys(state.outputs));
					// }
	
					// Cache the result
					this.stateCache.set(documentUri, state);
					return state;
				} catch {
					console.log(`No state file found at ${statePath}`);
				}
			}
	
			console.log(`No state files found for ${documentUri}`);
			return undefined;
		} catch (error) {
			console.warn(`Error reading state for ${documentUri}:`, error);
			return undefined;
		}
	}

	/**
	 * Gets all outputs from the state file
	 */
	public async getAllOutputs(documentUri: string): Promise<Map<string, RuntimeValue<ValueType>>> {
		const outputs = new Map<string, RuntimeValue<ValueType>>();
		try {
			const state = await this.findState(documentUri);

			if (!state?.outputs) return outputs;

			// Convert state outputs to RuntimeValues
			for (const [name, output] of Object.entries(state.outputs)) {
				outputs.set(name, this.convertToRuntimeValue(output.value, output.type));
			}
		} catch (error) {
			console.error('Error getting outputs:', error);
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
	 * Converts a terraform output value to a RuntimeValue
	 */
	private convertToRuntimeValue(value: any, type: string): RuntimeValue<ValueType> {
		switch (type) {
			case 'string': {
				return { type: 'string', value: String(value) };
			}
			case 'number': {
				return { type: 'number', value: Number(value) };
			}
			case 'bool': {
				return { type: 'boolean', value: Boolean(value) };
			}
			case 'list':
			case 'tuple':
			case 'set': {
				return {
					type: 'array',
					value: Array.isArray(value) ?
						value.map(v => this.convertToRuntimeValue(v, typeof v)) :
						[]
				};
			}
			case 'map':
			case 'object': {
				const map = new Map<string, RuntimeValue<ValueType>>();
				if (typeof value === 'object' && value !== null) {
					for (const [k, v] of Object.entries(value)) {
						map.set(k, this.convertToRuntimeValue(v, typeof v));
					}
				}
				return { type: 'object', value: map };
			}
			default: {
				return { type: 'string', value: JSON.stringify(value) };
			}
		}
	}

	/**
	 * Invalidates the cache for a specific document
	 */
	public invalidateCache(documentUri: string): void {
		this.stateCache.delete(documentUri);
	}
}