import { expect } from 'chai';

import { FunctionOperation, invokeFunctionOperation } from '../src/function-ops';
import type { FunctionContext, RuntimeValue, ValueType } from '../src/model';
import { makeStringValue } from '../src/functions/utils';

const context: FunctionContext = {
	workingDirectory: '/workspace',
	environmentVariables: {},
	document: { uri: 'file:///workspace/terragrunt.hcl', content: '' }
};

describe('function operation boundary', () => {
	it('delivers typed arguments through dry context and live services through wet context', async () => {
		const operation = new FunctionOperation('inspect', async (args, receivedContext) => {
			expect(receivedContext).to.equal(context);
			expect(args).to.have.length(1);
		expect(args[0]).to.deep.equal({
			type: 'object',
			value: new Map<string, RuntimeValue<ValueType>>([
				['enabled', { type: 'boolean', value: true }],
				['names', { type: 'array', value: [{ type: 'string', value: 'app' }] }]
			])
		});
		return makeStringValue('ok');
		});

		const result = await invokeFunctionOperation(operation, [{
			type: 'object',
			value: new Map([
				['enabled', { type: 'boolean', value: true }],
				['names', { type: 'array', value: [{ type: 'string', value: 'app' }] }]
			])
		}], context);

		expect(result).to.deep.equal({ type: 'string', value: 'ok' });
		expect(operation.metadata().name).to.equal('tghclp.function.inspect');
	});

	it('supports operations whose implementation reads the standardized contexts directly', async () => {
		const operation = FunctionOperation.inline('inline', async (dry, wet) => {
			expect(wet.getRequired<FunctionContext>('tghclp.function.context')).to.equal(context);
			const args = dry.getRequired<Array<{ type: string; value: unknown }>>('tghclp.function.args');
			expect(args).to.have.length(1);
			return makeStringValue('inline-result');
		});

		const result = await invokeFunctionOperation(operation, [{ type: 'string', value: 'input' }], context);
		expect(result).to.deep.equal({ type: 'string', value: 'inline-result' });
	});
});
