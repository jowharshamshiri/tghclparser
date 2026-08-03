import type { DryContext, OpMetadata, Op, WetContext } from '@jowharshamshiri/ops-ts';

import type { FunctionContext, FunctionImplementation, RuntimeValue, ValueType } from './model';

export const FUNCTION_ARGS_KEY = 'tghclp.function.args';
export const FUNCTION_NAME_KEY = 'tghclp.function.name';
export const FUNCTION_CONTEXT_KEY = 'tghclp.function.context';

type SerializedRuntimeValue = {
	type: ValueType | 'sensitive';
	value: unknown;
};

export type FunctionOperationHandler = (
	dry: DryContext,
	wet: WetContext
) => Promise<RuntimeValue<ValueType> | undefined>;

function serializeRuntimeValue(value: RuntimeValue<ValueType>): SerializedRuntimeValue {
	if (value.type === 'array') {
		return {
			type: value.type,
			value: (value.value as RuntimeValue<ValueType>[]).map(serializeRuntimeValue)
		};
	}
	if (value.type === 'object' || value.type === 'block') {
		const entries = [...(value.value as Map<string, RuntimeValue<ValueType>>).entries()]
			.map(([key, entry]) => [key, serializeRuntimeValue(entry)] as const);
		return { type: value.type, value: Object.fromEntries(entries) };
	}
	if ((value.type as string) === 'sensitive') {
		return { type: 'sensitive', value: serializeRuntimeValue(value.value as RuntimeValue<ValueType>) };
	}
	return { type: value.type, value: value.value };
}

function deserializeRuntimeValue(value: SerializedRuntimeValue): RuntimeValue<ValueType> {
	if (value.type === 'array') {
		if (!Array.isArray(value.value)) throw new Error('Invalid serialized function argument: array value expected');
		return { type: 'array', value: value.value.map(entry => deserializeRuntimeValue(entry as SerializedRuntimeValue)) };
	}
	if (value.type === 'object' || value.type === 'block') {
		if (value.value === null || typeof value.value !== 'object' || Array.isArray(value.value)) {
			throw new Error('Invalid serialized function argument: object value expected');
		}
		const entries = Object.entries(value.value as Record<string, SerializedRuntimeValue>)
			.map(([key, entry]) => [key, deserializeRuntimeValue(entry)] as const);
		return { type: value.type, value: new Map(entries) };
	}
	if (value.type === 'sensitive') {
		return { type: 'sensitive' as ValueType, value: deserializeRuntimeValue(value.value as SerializedRuntimeValue) as never };
	}
	return { type: value.type, value: value.value as never };
}

function serializeArgs(args: RuntimeValue<ValueType>[]): SerializedRuntimeValue[] {
	return args.map(serializeRuntimeValue);
}

function deserializeArgs(value: unknown): RuntimeValue<ValueType>[] {
	if (!Array.isArray(value)) throw new Error('Invalid function operation dry context: arguments must be an array');
	return value.map(entry => deserializeRuntimeValue(entry as SerializedRuntimeValue));
}

export class FunctionOperation implements Op<RuntimeValue<ValueType> | undefined> {
	private readonly opMetadata: OpMetadata;

	constructor(
		readonly functionName: string,
		private readonly handler: FunctionImplementation,
		private readonly contextHandler?: FunctionOperationHandler
	) {
		this.opMetadata = {
			name: `tghclp.function.${functionName}`,
			inputSchema: { type: 'object', required: [FUNCTION_ARGS_KEY, FUNCTION_NAME_KEY] },
			referenceSchema: { type: 'object', required: [FUNCTION_CONTEXT_KEY] },
			description: `Evaluate the ${functionName} function`
		} as OpMetadata;
	}

	static inline(functionName: string, handler: FunctionOperationHandler): FunctionOperation {
		return new FunctionOperation(functionName, async () => undefined, handler);
	}

	async perform(dry: DryContext, wet: WetContext): Promise<RuntimeValue<ValueType> | undefined> {
		if (this.contextHandler) return this.contextHandler(dry, wet);
		const name = dry.getRequired<string>(FUNCTION_NAME_KEY);
		if (name !== this.functionName) {
			throw new Error(`Function operation name mismatch: expected ${this.functionName}, got ${name}`);
		}
		const args = deserializeArgs(dry.getRequired<unknown>(FUNCTION_ARGS_KEY));
		const context = wet.getRequired<FunctionContext>(FUNCTION_CONTEXT_KEY);
		return this.handler(args, context);
	}

	metadata(): OpMetadata {
		return this.opMetadata;
	}
}

export async function invokeFunctionOperation(
	op: FunctionOperation,
	args: RuntimeValue<ValueType>[],
	context: FunctionContext
): Promise<RuntimeValue<ValueType> | undefined> {
	const { DryContext, WetContext } = await import('@jowharshamshiri/ops-ts');
	const dry = new DryContext()
		.withValue(FUNCTION_NAME_KEY, op.functionName)
		.withValue(FUNCTION_ARGS_KEY, serializeArgs(args));
	const wet = new WetContext().withRef(FUNCTION_CONTEXT_KEY, context);
	return op.perform(dry, wet);
}
