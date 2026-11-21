import type { TerragruntFileKind } from './model';

/** A node of a parsed configuration: a block, an attribute, a root assignment or an expression. */
export interface ConfigurationNode {
	type: string;
	value?: unknown;
	children?: ConfigurationNode[];
}

// The blocks of a unit configuration Terragrunt v1.2.2's discovery parse evaluates whole, besides locals and include:
// feature, the base block it decodes with them, and the blocks of its decode list.
const unitBlocks = new Set(['feature', 'dependencies', 'dependency', 'engine', 'exclude', 'errors']);

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

// The blocks of a stack file that discovery evaluates besides its locals and includes: its unit and stack blocks, apart
// from their autoinclude blocks.
const stackBlocks = new Set(['unit', 'stack']);

/** The value of an attribute or a root assignment. */
function valueOf<T extends ConfigurationNode>(node: T): T | undefined {
	return node.children?.find(child => child.type !== 'attribute_identifier' && child.type !== 'root_assignment_identifier') as T | undefined;
}

/** The value of every attribute in a block and in the blocks within it, of those directly in it only what `keep` keeps. */
function blockValues<T extends ConfigurationNode>(block: T, keep: (node: T) => boolean = () => true): T[] {
	const values: T[] = [];
	for (const child of (block.children ?? []) as T[]) {
		if (!keep(child)) continue;
		if (child.type === 'block') values.push(...blockValues(child));
		else if (child.type === 'attribute') {
			const value = valueOf(child);
			if (value) values.push(value);
		}
	}
	return values;
}

/**
 * The expressions of a file, other than its locals and include blocks, that Terragrunt v1.2.2's discovery evaluates,
 * so that a file a function reads in them is recorded as read by the unit or stack. Discovery evaluates every local
 * and include block of a file as well; those are left to the caller, which evaluates them as it builds the file's
 * scope.
 *
 * In a unit configuration, or the autoinclude beside it, that is what its partial parse decodes: feature,
 * dependencies, dependency, engine, exclude and errors, the terraform block's source, and the prevent_destroy,
 * iam_role, iam_web_identity_token, terragrunt_version_constraint, terraform_version_constraint and terraform_binary
 * attributes; never inputs, generate, remote_state or the rest of terraform. In a stack file, or the autoinclude beside
 * it, it is the unit and stack blocks, and inside their autoinclude blocks only each dependency's config_path and
 * expansion. A values file is evaluated whole, and so is a configuration read_terragrunt_config reads, which
 * Terragrunt parses in full.
 *
 * @param root the parsed file.
 * @param kind the kind of file it is.
 * @param parsedInFull whether Terragrunt parses the file in full, as it does one read_terragrunt_config reads.
 * @returns the expressions.
 */
export function discoveryExpressions<T extends ConfigurationNode>(root: T, kind: TerragruntFileKind, parsedInFull: boolean): T[] {
	const expressions: T[] = [];
	for (const node of (root.children ?? []) as T[]) {
		const name = String(node.value);
		if (node.type === 'assignment') {
			const value = valueOf(node);
			const evaluated = parsedInFull || kind === 'values' || ((kind === 'unit' || kind === 'unit-autoinclude') && unitAttributes.has(name));
			if (value && evaluated) expressions.push(value);
			continue;
		}
		if (node.type !== 'block' || name === 'locals' || name === 'include') continue;
		if (parsedInFull) {
			expressions.push(...blockValues(node));
			continue;
		}
		switch (kind) {
			case 'values': {
				break;
			}
			case 'unit':
			case 'unit-autoinclude': {
				if (unitBlocks.has(name)) expressions.push(...blockValues(node));
				else if (name === 'terraform') expressions.push(...blockValues(node, child => child.type === 'attribute' && child.value === 'source'));
				break;
			}
			case 'stack':
			case 'stack-autoinclude': {
				if (!stackBlocks.has(name)) break;
				expressions.push(...blockValues(node, child => !(child.type === 'block' && child.value === 'autoinclude')));
				for (const autoinclude of (node.children ?? []) as T[]) {
					if (autoinclude.type !== 'block' || autoinclude.value !== 'autoinclude') continue;
					for (const dependency of (autoinclude.children ?? []) as T[]) {
						if (dependency.type !== 'block' || dependency.value !== 'dependency') continue;
						expressions.push(...blockValues(dependency, held =>
							(held.type === 'attribute' && held.value === 'config_path') || (held.type === 'block' && held.value === 'expansion')));
					}
				}
				break;
			}
		}
	}
	return expressions;
}
