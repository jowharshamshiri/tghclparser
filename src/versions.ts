/**
 * Version numbers and version constraints as Terraform and Terragrunt read them, which is the behaviour of
 * hashicorp/go-version: numeric segments padded to three, a pre-release after `-`, build metadata after `+` that
 * never takes part in comparison, and constraint terms joined by commas.
 */

/** A version number split into the parts comparison looks at. */
export interface ParsedVersion {
	/** The text as given, which a registry expects back unchanged. */
	original: string;
	/** Numeric segments, padded with zeros to at least three. */
	segments: number[];
	/** How many segments were written, which the pessimistic operator depends on. */
	segmentCount: number;
	/** The dot-separated pre-release identifiers; empty for a release. */
	prerelease: string[];
}

/** One term of a constraint, such as `>= 1.2` in `>= 1.2, < 2.0`. */
export interface ConstraintTerm {
	/** The operator; `=` when the term names a bare version. */
	operator: '=' | '!=' | '>' | '>=' | '<' | '<=' | '~>';
	/** The version the operator compares against. */
	version: ParsedVersion;
}

const versionPattern = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z~-]+(?:\.[0-9A-Za-z~-]+)*))?(?:\+[0-9A-Za-z~-]+(?:\.[0-9A-Za-z~-]+)*)?$/;
const termPattern = /^(<=|>=|!=|~>|<|>|=)?\s*(\S.*)$/;

/**
 * Reads a version number, accepting a leading `v` and dropping build metadata.
 *
 * @param text a version such as `5.1.0`, `v1.2` or `2.0.0-rc.1+build.7`.
 * @returns the parsed version, or undefined when the text is not a version.
 */
export function parseVersion(text: string): ParsedVersion | undefined {
	const match = text.trim().match(versionPattern);
	if (!match) return undefined;
	const written = match[1].split('.').map(Number);
	const segments = [...written];
	while (segments.length < 3) segments.push(0);
	return { original: text.trim(), segments, segmentCount: written.length, prerelease: match[2] ? match[2].split('.') : [] };
}

/**
 * Orders two versions: by segment, then a release above any pre-release of the same segments, then pre-release
 * identifiers as SemVer 2.0 orders them.
 *
 * @param left one version.
 * @param right the other.
 * @returns negative when `left` is lower, positive when higher, zero when equal.
 */
export function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
	const length = Math.max(left.segments.length, right.segments.length);
	for (let index = 0; index < length; index++) {
		const difference = (left.segments[index] ?? 0) - (right.segments[index] ?? 0);
		if (difference !== 0) return difference;
	}
	if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
	if (left.prerelease.length === 0) return 1;
	if (right.prerelease.length === 0) return -1;
	const parts = Math.max(left.prerelease.length, right.prerelease.length);
	for (let index = 0; index < parts; index++) {
		const difference = comparePrereleasePart(left.prerelease[index] ?? '', right.prerelease[index] ?? '');
		if (difference !== 0) return difference;
	}
	return 0;
}

/**
 * Orders one pair of pre-release identifiers as SemVer 2.0 does: numeric ones by value and below alphanumeric
 * ones, alphanumeric ones by ASCII, and a missing identifier below a present one.
 *
 * @param left one identifier, empty when that pre-release has run out.
 * @param right the other.
 * @returns negative when `left` is lower, positive when higher, zero when equal.
 */
function comparePrereleasePart(left: string, right: string): number {
	if (left === right) return 0;
	const leftNumeric = /^\d+$/.test(left);
	const rightNumeric = /^\d+$/.test(right);
	if (left === '') return rightNumeric ? -1 : 1;
	if (right === '') return leftNumeric ? 1 : -1;
	if (leftNumeric && !rightNumeric) return -1;
	if (!leftNumeric && rightNumeric) return 1;
	if (leftNumeric && rightNumeric) return Number(left) - Number(right);
	return left > right ? 1 : -1;
}

/**
 * Reads a version constraint into its terms, all of which a version must satisfy.
 *
 * @param text a constraint such as `~> 5.0` or `>= 1.2, < 2.0`; terms are separated by commas only.
 * @returns the terms in order.
 * @throws when the text is empty or a term has an unknown operator or a malformed version.
 */
export function parseConstraint(text: string): ConstraintTerm[] {
	const terms = text.split(',').map(term => term.trim());
	if (terms.length === 0 || terms.some(term => term === '')) throw new Error(`version constraint "${text}" has an empty term`);
	return terms.map(term => {
		const match = term.match(termPattern);
		const version = match ? parseVersion(match[2]) : undefined;
		if (!match || !version) throw new Error(`version constraint term "${term}" is not an operator followed by a version`);
		return { operator: (match[1] ?? '=') as ConstraintTerm['operator'], version };
	});
}

/**
 * Checks a version against a whole constraint.
 *
 * @param version the candidate.
 * @param terms every term of the constraint.
 * @returns true when the candidate satisfies every term, with a pre-release eligible only for a term that names
 *   a pre-release of the same segments.
 */
export function satisfies(version: ParsedVersion, terms: ConstraintTerm[]): boolean {
	return terms.every(term => satisfiesTerm(version, term));
}

/**
 * Checks a version against one term. `~>` allows the last segment written to rise and fixes the ones before it,
 * so `~> 1.2` means `>= 1.2, < 2.0` and `~> 1.2.3` means `>= 1.2.3, < 1.3.0`.
 *
 * @param version the candidate.
 * @param term the term.
 * @returns true when the candidate satisfies it.
 */
function satisfiesTerm(version: ParsedVersion, term: ConstraintTerm): boolean {
	const constraint = term.version;
	if (!prereleaseAllowed(version, constraint)) return false;
	const comparison = compareVersions(version, constraint);
	switch (term.operator) {
		case '=': return comparison === 0;
		case '!=': return comparison !== 0;
		case '>': return comparison > 0;
		case '>=': return comparison >= 0;
		case '<': return comparison < 0;
		case '<=': return comparison <= 0;
		case '~>': {
			if (constraint.prerelease.length > 0 && version.prerelease.length === 0) return false;
			if (comparison < 0) return false;
			if (constraint.segments.length > version.segments.length) return false;
			for (let index = 0; index < constraint.segmentCount - 1; index++) {
				if (version.segments[index] !== constraint.segments[index]) return false;
			}
			const last = constraint.segments.length - 1;
			return version.segments[last] >= constraint.segments[last];
		}
	}
}

/**
 * Applies go-version's pre-release gate: a pre-release is considered only by a term that names a pre-release of the
 * same segments, so `>= 1.0` never selects `2.0.0-rc.1`.
 *
 * @param version the candidate.
 * @param constraint the version a term names.
 * @returns false when the candidate is a pre-release the term does not admit.
 */
function prereleaseAllowed(version: ParsedVersion, constraint: ParsedVersion): boolean {
	if (constraint.prerelease.length > 0 && version.prerelease.length > 0) {
		return version.segments.length === constraint.segments.length
			&& version.segments.every((segment, index) => segment === constraint.segments[index]);
	}
	if (constraint.prerelease.length === 0 && version.prerelease.length > 0) return false;
	return true;
}

/**
 * Picks the version a registry request should use: the highest release when there is no constraint, else the
 * highest version satisfying it.
 *
 * @param constraint the constraint text, or undefined for none.
 * @param versions the versions the registry lists, in any order; strings that are not versions are ignored.
 * @returns the chosen version's text as the registry listed it, or undefined when nothing qualifies.
 * @throws when the constraint cannot be parsed.
 */
export function resolveVersion(constraint: string | undefined, versions: string[]): string | undefined {
	const terms = constraint === undefined ? undefined : parseConstraint(constraint);
	let best: ParsedVersion | undefined;
	for (const text of versions) {
		const version = parseVersion(text);
		if (!version) continue;
		if (terms ? !satisfies(version, terms) : version.prerelease.length > 0) continue;
		if (!best || compareVersions(version, best) > 0) best = version;
	}
	return best?.original;
}
