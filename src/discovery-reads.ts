import type { TerragruntFileKind, Token } from './model';

// The blocks of a unit configuration Terragrunt v1.2.2's discovery parse evaluates whole: the base blocks (locals,
// include and feature) and the blocks of its decode list.
const unitBlocks = new Set(['locals', 'include', 'feature', 'dependencies', 'dependency', 'engine', 'exclude', 'errors']);

// The top-level attributes of a unit configuration that discovery parse evaluates: the flags and version constraints
// of its decode list.
const unitAttributes = new Set([
	'prevent_destroy',
	'iam_role',
	'iam_web_identity_token',
	'terragrunt_version_constraint',
	'terraform_version_constraint',
	'terraform_binary'
]);

// The blocks of a stack file that discovery evaluates: its locals and includes, and its unit and stack blocks apart
// from their autoinclude blocks.
const stackBlocks = new Set(['locals', 'include', 'unit', 'stack']);

/**
 * Whether Terragrunt v1.2.2's discovery evaluates the expression a token sits in, so that a file a function reads
 * there is recorded as read by the unit. In a unit configuration, or the autoinclude beside it, that is what its
 * partial parse decodes: locals, include, feature, dependencies, dependency, engine, exclude and errors, the
 * terraform block's source, and the prevent_destroy, iam_role, iam_web_identity_token, terragrunt_version_constraint,
 * terraform_version_constraint and terraform_binary attributes; never inputs, generate, remote_state or the rest of
 * terraform. In a stack file, or the autoinclude beside it, it is locals, include and the unit and stack blocks, and
 * inside their autoinclude blocks only each dependency's config_path and expansion. A values file is evaluated whole.
 *
 * @param token the token, such as a function call.
 * @param kind the kind of file it is in.
 * @returns true when discovery evaluates it.
 */
export function discoveryEvaluates(token: Token, kind: TerragruntFileKind): boolean {
	// The blocks and attributes around the token, innermost first: a file's own attributes are assignments.
	const enclosing: Token[] = [];
	for (let ancestor = token.parent; ancestor; ancestor = ancestor.parent) {
		if (ancestor.type === 'block' || ancestor.type === 'attribute' || ancestor.type === 'assignment') enclosing.push(ancestor);
	}
	const outermost = enclosing.at(-1);
	if (!outermost) return false;
	const name = String(outermost.value);
	switch (kind) {
		case 'values': {
			return true;
		}
		case 'unit':
		case 'unit-autoinclude': {
			if (outermost.type !== 'block') return unitAttributes.has(name);
			if (name === 'terraform') {
				const inner = enclosing.at(-2);
				return inner?.type === 'attribute' && inner.value === 'source';
			}
			return unitBlocks.has(name);
		}
		case 'stack':
		case 'stack-autoinclude': {
			if (outermost.type !== 'block' || !stackBlocks.has(name)) return false;
			const autoinclude = enclosing.findIndex(ancestor => ancestor.type === 'block' && ancestor.value === 'autoinclude');
			if (autoinclude === -1) return true;
			// Within an autoinclude, the dependency block directly inside it, then what in that block holds the token.
			const dependency = enclosing[autoinclude - 1];
			const held = enclosing[autoinclude - 2];
			return dependency?.type === 'block' && dependency.value === 'dependency'
				&& ((held?.type === 'attribute' && held.value === 'config_path') || (held?.type === 'block' && held.value === 'expansion'));
		}
	}
}
