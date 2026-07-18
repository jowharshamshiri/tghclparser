import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { URI } from 'vscode-uri';

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
				const state = JSON.parse(stateContent) as TerraformState;
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
	 * Converts a terraform output value to a RuntimeValue
	 */
	private convertToRuntimeValue(value: unknown, type: string | [string, unknown]): RuntimeValue<ValueType> {
		if (Array.isArray(type)) {
			const [constructor, elementType] = type;
			if (constructor === 'list' || constructor === 'tuple' || constructor === 'set') {
				if (!Array.isArray(value)) throw new Error(`Terraform state output declared ${constructor} but contains a non-array value`);
				const elementTypes = constructor === 'tuple' && Array.isArray(elementType) ? elementType : undefined;
				return {
					type: 'array',
					value: value.map((item, index) => this.convertToRuntimeValue(item, this.normalizeType(elementTypes?.[index] ?? elementType, item)))
				};
			}
			if (constructor === 'map' || constructor === 'object') {
				if (typeof value !== 'object' || value === null || Array.isArray(value)) {
					throw new Error(`Terraform state output declared ${constructor} but contains a non-object value`);
				}
				const entries = new Map<string, RuntimeValue<ValueType>>();
				for (const [key, item] of Object.entries(value)) {
					const declared = constructor === 'object' && typeof elementType === 'object' && elementType !== null
						? (elementType as Record<string, unknown>)[key]
						: elementType;
					entries.set(key, this.convertToRuntimeValue(item, this.normalizeType(declared, item)));
				}
				return { type: 'object', value: entries };
			}
			throw new Error(`Unsupported Terraform state output type constructor: ${constructor}`);
		}
		switch (type) {
			case 'string': {
				return { type: 'string', value: String(value) };
			}
			case 'number': {
				return { type: 'number', value: Number(value) };
			}
			case 'bool':
			case 'boolean': {
				return { type: 'boolean', value: Boolean(value) };
			}
			case 'null': {
				if (value !== null) throw new Error('Terraform state output declared null but contains a value');
				return { type: 'null', value: null };
			}
			default: {
				throw new Error(`Unsupported Terraform state output type: ${type}`);
			}
		}
	}

	private normalizeType(type: unknown, value: unknown): string | [string, unknown] {
		if (typeof type === 'string' || (Array.isArray(type) && typeof type[0] === 'string')) return type as string | [string, unknown];
		if (value === null) return 'null';
		if (Array.isArray(value)) return ['tuple', value.map(item => this.normalizeType(undefined, item))];
		if (typeof value === 'object') {
			return ['object', Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.normalizeType(undefined, item)]))];
		}
		return typeof value;
	}

	/**
	 * Invalidates the cache for a specific document
	 */
	public invalidateCache(documentUri: string): void {
		this.stateCache.delete(documentUri);
	}
}
