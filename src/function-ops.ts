import type { DryContext, OpMetadata, Op, WetContext } from '@jowharshamshiri/ops-ts';

import { CtyNumber, type SerializedCtyNumber } from './cty-number';
import type { FunctionContext, FunctionImplementation, RuntimeValue, ValueType } from './model';

export const FUNCTION_ARGS_KEY = 'tghclp.function.args';
export const FUNCTION_NAME_KEY = 'tghclp.function.name';
export const FUNCTION_CONTEXT_KEY = 'tghclp.function.context';

// The dry context holds JSON, so a number is held as its fields: its sign, mantissa, exponent and precision.
type SerializedRuntimeValue = {
	type: ValueType | 'sensitive';
	value: unknown;
	encrypted?: true;
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
	if (value.type === 'number') return { type: value.type, value: (value.value as CtyNumber).serialize() };
	return value.encrypted ? { type: value.type, value: value.value, encrypted: true } : { type: value.type, value: value.value };
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
	if (value.type === 'number') return { type: 'number', value: CtyNumber.deserialize(value.value as SerializedCtyNumber) };
	return value.encrypted ? { type: value.type, value: value.value as never, encrypted: true } : { type: value.type, value: value.value as never };
}

function serializeArgs(args: RuntimeValue<ValueType>[]): SerializedRuntimeValue[] {
	return args.map(serializeRuntimeValue);
}

function deserializeArgs(value: unknown): RuntimeValue<ValueType>[] {
	if (!Array.isArray(value)) throw new Error('Invalid function operation dry context: arguments must be an array');
	return value.map(entry => deserializeRuntimeValue(entry as SerializedRuntimeValue));
}

/**
 * Reads the serialized call arguments out of a function operation's dry context.
 * Operations built with {@link FunctionOperation.inline} receive the raw
 * contexts and use this to recover typed arguments.
 */
export function readArgs(dry: DryContext): RuntimeValue<ValueType>[] {
	return deserializeArgs(dry.getRequired<unknown>(FUNCTION_ARGS_KEY));
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

// ops-ts is published only as an ES module, so the CommonJS build reaches it through import(). It is loaded once:
// every function call goes through here, and each import() resolves its specifier again, through every module hook
// registered in the process.
let opsModule: Promise<typeof import('@jowharshamshiri/ops-ts')> | undefined;

export async function invokeFunctionOperation(
	op: FunctionOperation,
	args: RuntimeValue<ValueType>[],
	context: FunctionContext
): Promise<RuntimeValue<ValueType> | undefined> {
	opsModule ??= import('@jowharshamshiri/ops-ts');
	const { DryContext, WetContext } = await opsModule;
	const dry = new DryContext()
		.withValue(FUNCTION_NAME_KEY, op.functionName)
		.withValue(FUNCTION_ARGS_KEY, serializeArgs(args));
	const wet = new WetContext().withRef(FUNCTION_CONTEXT_KEY, context);
	return op.perform(dry, wet);
}
