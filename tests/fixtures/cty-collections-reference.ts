// What Terragrunt v1.2.2 (its release binary, terragrunt_darwin_arm64 sha256 7069eec5127f007525b1178a782e801218342cf223633c6e8508762de19166d6) gave for
// each expression as `x` in a unit's inputs, recorded with `terragrunt render --json`. A fault is stated as tghclparser
// states it: an argument refused as HCL words it, any other failed call as the message after `Call to function "<name>"
// failed: `, and any other fault as its diagnostic's detail.

/** The type v1.2.2 names when the value is put in a template: `Cannot include the given value in a string template: string required, but have <name>.` */
export const typeNames: Array<[string, string]> = [
	['keys({a = 1})', 'tuple'],
	['keys(tomap({a = 1}))', 'list of string'],
	['values({a = 1, b = "x"})', 'tuple'],
	['values(tomap({a = 1}))', 'list of number'],
	['concat([1], [2])', 'tuple'],
	['concat(tolist([1]), tolist([2]))', 'list of number'],
	['concat(tolist([1]), [2])', 'tuple'],
	['concat(tolist([1]), ["a"])', 'tuple'],
	['concat(tolist([1]), tolist(["a"]))', 'list of string'],
	['flatten([[1], [2]])', 'tuple'],
	['flatten(tolist([tolist([1])]))', 'tuple'],
	['merge({a = 1}, {b = 2})', 'object'],
	['merge(tomap({a = 1}), tomap({b = 2}))', 'map of number'],
	['merge(tomap({a = 1}), {b = "x"})', 'object'],
	['distinct([1, 1])', 'list of number'],
	['distinct(tolist([1, 1]))', 'list of number'],
	['reverse([1, 2])', 'tuple'],
	['reverse(tolist([1, 2]))', 'list of number'],
	['reverse(toset([1, 2]))', 'list of number'],
	['slice([1, 2, 3], 0, 2)', 'tuple'],
	['slice(tolist([1, 2, 3]), 0, 2)', 'list of number'],
	['compact(["a", ""])', 'list of string'],
	['chunklist([1, 2, 3], 2)', 'list of list of number'],
	['chunklist(tolist([1, 2, 3]), 2)', 'list of list of number'],
	['coalescelist([1], [2])', 'tuple'],
	['coalescelist(tolist([1]), [2])', 'list of number'],
	['sort(["b", "a"])', 'list of string'],
	['split(",", "a,b")', 'list of string'],
	['formatlist("%s", ["a"])', 'list of string'],
	['regexall("a", "aa")', 'list of string'],
	['regex("(a)", "a")', 'tuple'],
	['regex("(?P<x>a)", "a")', 'object'],
	['zipmap(["a"], [1])', 'object'],
	['zipmap(["a"], tolist([1]))', 'map of number'],
	['transpose({a = ["b"]})', 'map of list of string'],
	['matchkeys(["a"], ["b"], ["b"])', 'list of string'],
	['setunion(["a"], ["b"])', 'set of string'],
	['setintersection(["a"], ["a"])', 'set of string'],
	['setsubtract(["a"], ["b"])', 'set of string'],
	['setproduct(["a"], [1])', 'list of tuple'],
	['setproduct(tolist(["a"]), tolist([1]))', 'list of tuple'],
	['setproduct(toset(["a"]), toset([1]))', 'set of tuple'],
	['range(3)', 'list of number'],
	['jsondecode("[1]")', 'tuple'],
	['jsondecode("{\\"a\\":1}")', 'object'],
	['yamldecode("[1]")', 'tuple'],
	['yamldecode("a: 1")', 'object'],
	['csvdecode("a,b\\n1,2")', 'list of object'],
	['element(tolist([[1]]), 0)', 'tuple'],
	['lookup({a = [1]}, "a", [])', 'tuple'],
	['one(tolist([[1]]))', 'tuple'],
	['tolist(toset([1]))', 'list of number'],
	['toset(tolist([1]))', 'set of number'],
	['tomap({a = [1], b = [2, 3]})', 'map of list of number'],
	['cidrsubnets("10.0.0.0/8", 8)', 'list of string'],
	['fileset(".", "*")', 'set of string'],
	['get_terraform_commands_that_need_vars()', 'list of string'],
	['get_terraform_commands_that_need_input()', 'list of string'],
	['get_terraform_commands_that_need_locking()', 'list of string'],
	['get_terraform_commands_that_need_parallelism()', 'list of string'],
	['get_default_retryable_errors()', 'list of string'],
	['get_terraform_cli_args()', 'list of string'],
	['{ for k, v in {a = 1} : k => v }', 'object'],
	['[ for v in tolist([1]) : v ]', 'tuple'],
	['{ for k, v in {a = 1} : k => v... }', 'object'],
	['tolist([1])[*]', 'list of number'],
	['toset([1])[*]', 'list of number'],
	['[1][*]', 'tuple'],
	['keys({})', 'tuple'],
	['values({})', 'tuple'],
	['merge()', 'object'],
	['flatten([])', 'tuple'],
	['sensitive(tolist([1]))', 'list of number'],
	['tolist(["a", null])', 'list of string'],
	['tomap({})', 'map of dynamic'],
	['toset([])', 'set of dynamic'],
	['try(tolist([1]), 1)', 'list of number'],
	['transpose(tomap({a = tolist(["b"])}))', 'map of list of string'],
	['setunion(toset([1]), ["a"])', 'set of string'],
	['true ? [[1]] : [null]', 'tuple'],
	['true ? tolist([1]) : null', 'list of number'],
	['true ? [1] : tolist(["a"])', 'list of string'],
	['true ? {a = 1} : tomap({b = "x"})', 'map of string'],
	['true ? [] : tolist(["a"])', 'list of string'],
	['true ? {} : {a = 1}', 'map of number'],
	['true ? [1] : [2, 3]', 'list of number'],
	['true ? {a = 1} : {a = "x"}', 'object'],
];

/** The value v1.2.2 rendered, as JSON. */
export const values: Array<[string, unknown]> = [
	['tolist(["a", 1, true])', ["a", "1", "true"]],
	['toset(["b", "a", "b"])', ["a", "b"]],
	['toset([3, 1, 2, 10])', [1, 2, 3, 10]],
	['toset(["10", "9", "B", "a", "b"])', ["10", "9", "B", "a", "b"]],
	['tomap({a = 1, b = "x"})', {"a": "1", "b": "x"}],
	['tomap({a = [1], b = [2, 3]})', {"a": [1], "b": [2, 3]}],
	['tolist(toset([3, 1, 2]))', [1, 2, 3]],
	['tostring(null) == null', true],
	['[tostring(null)] == [null]', false],
	['tolist([1]) == [1]', false],
	['tolist([1]) == tolist([1])', true],
	['tomap({a = 1}) == {a = 1}', false],
	['tomap({a = 1}) == tomap({a = "1"})', false],
	['toset([1, 2]) == toset([2, 1])', true],
	['toset([1]) == tolist([1])', false],
	['[for x in tolist([1]) : x] == [1]', true],
	['true ? tolist(["a"]) : [1]', ["a"]],
	['true ? ["a"] : [1, 2]', ["a"]],
	['true ? {a = 1} : {b = "x"}', {"a": "1"}],
	['false ? {a = 1} : {b = "x"}', {"b": "x"}],
	['true ? [] : tolist(["a"])', []],
	['true ? null : 1', null],
	['true ? "a" : nope', "a"],
	['[for k, v in toset(["b", "a"]) : "${k}=${v}"]', ["a=a", "b=b"]],
	['[for k, v in tomap({b = 1, a = 2}) : "${k}=${v}"]', ["a=2", "b=1"]],
	['[for k, v in tolist(["x", "y"]) : k]', [0, 1]],
	['"%{for v in toset(["b", "a"])}${v}%{endfor}"', "ab"],
	['tomap({a = 1})["a"]', 1],
	['tomap({a = 1}).a', 1],
	['toset([{a = 1}, {a = 2}])[*].a', [1, 2]],
	['tolist([{a = 1}])[*].a', [1]],
	['[{a = 1}, {a = "x"}][*].a', [1, "x"]],
	['{a = 1}[*].a', [1]],
	['merge(tomap({a = 1}), tomap({b = 2}))', {"a": 1, "b": 2}],
	['merge(tomap({a = 1}), tomap({b = "x"}))', {"a": 1, "b": "x"}],
	['coalesce(1, "a")', "1"],
	['coalescelist(tolist([]), [2])', [2]],
	['lookup(tomap({a = 1}), "b", "2")', 2],
	['lookup({a = 1}, "b", [])', []],
	['concat(tolist([1]), tolist(["a"]))', ["1", "a"]],
	['distinct(["a", 1, "a"])', ["a", "1"]],
	['reverse(toset([3, 1, 2]))', [3, 2, 1]],
	['setunion(["b"], [1])', ["1", "b"]],
	['setproduct(toset(["b", "a"]), [1])', [["a", 1], ["b", 1]]],
	['zipmap(["a", "b"], tolist([1, 2]))', {"a": 1, "b": 2}],
	['keys(tomap({b = 1, a = 2}))', ["a", "b"]],
	['values(tomap({b = 1, a = 2}))', [2, 1]],
	['flatten(tolist([tolist([1]), [2]]))', [1, 2]],
	['one(tolist([]))', null],
	['sum(toset([1, 2, "3"]))', 6],
	['alltrue(["true", true])', true],
	['transpose({a = ["x", "y"], b = ["x"]})', {"x": ["a", "b"], "y": ["a"]}],
	['"a${regex("(a)(b)?", "a")[1] == null}"', "atrue"],
	['compact(["a", "", null, 1])', ["a", "1"]],
	['sort(toset([3, 1, 20, 2]))', ["1", "2", "20", "3"]],
	['upper(toset(["a"])...)', "A"],
	['[for v in tomap({}) : v]', []],
];

/** The fault v1.2.2 reported. */
export const faults: Array<[string, string]> = [
	['true ? 1 : true', 'The true and false result expressions must have consistent types. The \'true\' value is number, but the \'false\' value is bool.'],
	['true ? [1] : [true]', 'The true and false result expressions must have consistent types. Type mismatch for tuple element 0: The \'true\' value is number, but the \'false\' value is bool.'],
	['true ? [1] : [1, true]', 'The true and false result expressions must have consistent types. The \'true\' tuple has length 1, but the \'false\' tuple has length 2.'],
	['true ? {a = 1} : {b = true}', 'The true and false result expressions must have consistent types. The \'true\' value includes object attribute "a", which is absent in the \'false\' value.'],
	['true ? {a = [1]} : {a = [true]}', 'The true and false result expressions must have consistent types. Type mismatch for object attribute "a": Type mismatch for tuple element 0: The \'true\' value is number, but the \'false\' value is bool.'],
	['true ? {} : []', 'The true and false result expressions must have consistent types. The \'true\' value is object, but the \'false\' value is tuple.'],
	['true ? tolist(["a"]) : tomap({a = 1})', 'The true and false result expressions must have consistent types. The \'true\' value is list of string, but the \'false\' value is map of number.'],
	['toset(["a"])[0]', 'Elements of a set are identified only by their value and don\'t have any separate index or key to select with, so it\'s only possible to perform operations across all elements of the set.'],
	['tomap({a = 1}).b', 'This map does not have an element with the key "b".'],
	['tomap({a = 1})["b"]', 'The given key does not identify an element in this collection value.'],
	['tolist(["a", "b"])[2]', 'The given key does not identify an element in this collection value: the given index is greater than or equal to the length of the collection.'],
	['tolist(["a", "b"])[3]', 'The given key does not identify an element in this collection value.'],
	['tolist([{a = 1}]).a', 'Can\'t access attributes on a list of objects. Did you mean to access attribute "a" for a specific element of the list, or across all elements of the list?'],
	['tolist([{a = 1}]).b', 'Can\'t access attributes on a list of objects. Did you mean to access an attribute for a specific element of the list, or across all elements of the list?'],
	['toset([{a = 1}]).a', 'Can\'t access attributes on a set of objects. Did you mean to access an attribute across all elements of the set?'],
	['tolist(["a"]).a', 'This value does not have any attributes.'],
	['"a".b', 'Can\'t access attributes on a primitive-typed value (string).'],
	['lookup(tomap({a = 1}), "b", [])', 'Invalid function argument; Invalid value for "default" parameter: the default value must have the same type as the map elements.'],
	['tolist(["a", ["b"]])', 'Invalid function argument; Invalid value for "v" parameter: cannot convert tuple to list of any single type.'],
	['tolist({a = 1})', 'Invalid function argument; Invalid value for "v" parameter: cannot convert object to list of any single type.'],
	['tomap(["a"])', 'Invalid function argument; Invalid value for "v" parameter: cannot convert tuple to map of any single type.'],
	['tostring(tolist([1]))', 'Invalid function argument; Invalid value for "v" parameter: cannot convert list of number to string.'],
	['tonumber(true)', 'Invalid function argument; Invalid value for "v" parameter: cannot convert bool to number.'],
	['tobool("yes")', 'Invalid function argument; Invalid value for "v" parameter: cannot convert "yes" to bool; only the strings "true" or "false" are allowed.'],
	['tonumber("x")', 'Invalid function argument; Invalid value for "v" parameter: cannot convert "x" to number; given string must be a decimal representation of a number.'],
	['1 + tolist([1])', 'Unsuitable value for right operand: number required, but have list of number.'],
	['!tolist([true])', 'Unsuitable value for unary operand: bool required, but have list of bool.'],
	['tolist([1]) > 0', 'Unsuitable value for left operand: number required, but have list of number.'],
	['join(",", tomap({a = "b"}))', 'Invalid function argument; Invalid value for "lists" parameter: list of string required.'],
	['upper(tolist(["a"]))', 'Invalid function argument; Invalid value for "str" parameter: string required, but have list of string.'],
	['concat(toset(["a"]))', 'Invalid function argument; Invalid value for "seqs" parameter: all arguments must be lists or tuples; got set of string.'],
	['element(toset(["a"]), 0)', 'cannot read elements from set of string'],
	['keys(tolist([1]))', 'Invalid function argument; Invalid value for "inputMap" parameter: must have map or object type.'],
	['values(toset([1]))', 'values() requires a map as the first argument'],
	['length(true)', 'argument must be a string, a collection type, or a structural type'],
	['merge(tolist([1]))', 'arguments must be maps or objects, got "list of number"'],
	['zipmap(["a"], toset([1]))', 'values argument must be a list or tuple value'],
	['flatten(tomap({a = 1}))', 'can only flatten lists, sets and tuples'],
	['sum(tomap({a = 1}))', 'Invalid function argument; Invalid value for "list" parameter: argument must be list, set, or tuple. Received map of number.'],
	['contains(tomap({a = 1}), 1)', 'argument must be list, tuple, or set'],
	['index(toset([1]), 1)', 'argument must be a list or tuple'],
	['coalescelist(toset([1]))', 'coalescelist arguments must be lists or tuples'],
	['setproduct(tomap({a = 1}), [1])', 'Invalid function argument; Invalid value for "sets" parameter: a set or a list is required.'],
	['max(tomap({a = 1})...)', 'Invalid expanding argument value; The expanding argument (indicated by ...) must be of a tuple, list, or set type.'],
	['{ (tolist(["a"])) = 1 }', 'Can\'t use this value as a key: string required, but have list of string.'],
	['{ for v in [1] : tolist(["a"]) => v }', 'The key expression produced an invalid result: string required, but have list of string.'],
	['[for v in tolist([1]) : v if tolist([true])]', 'The \'if\' clause value is invalid: bool required, but have list of bool.'],
	['[for v in "abc" : v]', 'A value of type string cannot be used as the collection in a \'for\' expression.'],
];

/** A configuration `read_terragrunt_config()` reads in the cases below; its dependencies `dep` and `dep2` are units. */
export const readConfig = `locals {
  l = tolist(["a"])
  m = tomap({ a = 1 })
}
dependencies {
  paths = ["dep2"]
}
dependency "d" {
  config_path = "dep"
  mock_outputs = { o = tolist(["a"]) }
  mock_outputs_allowed_terraform_commands = ["render"]
}
terraform {
  source = "."
  extra_arguments "e" {
    commands  = ["plan"]
    arguments = ["-x"]
    env_vars  = { A = "b" }
  }
  before_hook "h" {
    commands = ["plan"]
    execute  = ["echo"]
  }
  include_in_copy = ["a"]
}
generate "g" {
  path      = "g.tf"
  if_exists = "overwrite"
  contents  = "x"
}
feature "f" {
  default = tolist([1])
}
exclude {
  if      = false
  actions = ["plan"]
}
errors {
  retry "r" {
    retryable_errors   = ["x"]
    max_attempts       = 2
    sleep_interval_sec = 1
  }
}
remote_state {
  backend = "local"
  config  = { path = "x", l = tolist(["a"]) }
}
inputs = {
  i = tolist(["a"])
}
`;

/** The type v1.2.2 names for `read_terragrunt_config("other.hcl").<field>`, run as `terragrunt render`. */
export const readConfigTypes: Array<[string, string]> = [
	['locals.l', 'tuple'],
	['locals.m', 'object'],
	['dependencies.paths', 'list of string'],
	['dependencies', 'object'],
	['terraform.extra_arguments', 'map of object'],
	['terraform.extra_arguments.e.arguments', 'list of string'],
	['terraform.extra_arguments.e.env_vars', 'map of string'],
	['terraform.before_hook', 'map of object'],
	['terraform.before_hook.h.execute', 'list of string'],
	['terraform.include_in_copy', 'list of string'],
	['generate', 'map of object'],
	['generate.g', 'object'],
	['feature', 'object'],
	['feature.f', 'object'],
	['feature.f.default', 'list of number'],
	['exclude.actions', 'list of string'],
	['exclude', 'object'],
	['errors.retry', 'list of object'],
	['errors', 'object'],
	['remote_state.config', 'object'],
	['remote_state.config.l', 'tuple'],
	['remote_state', 'object'],
	['inputs', 'object'],
	['inputs.i', 'tuple'],
	['dependency', 'object'],
	['dependency.d', 'object'],
	['dependency.d.mock_outputs', 'object'],
	['dependency.d.mock_outputs.o', 'list of string'],
	['dependency.d.outputs', 'object'],
	['dependency.d.mock_outputs_allowed_terraform_commands', 'list of string'],
	['terraform', 'object'],
];

/** The type v1.2.2 names for `include.root.<field>` of an exposed include of a file with `locals { l = tolist(["a"]) }`, `inputs = { i = tomap({ a = 1 }) }`. */
export const includeTypes: Array<[string, string]> = [
	['locals.l', 'tuple'],
	['inputs.i', 'object'],
	['inputs', 'object'],
	['locals', 'object']
];

/** What v1.2.2 rendered for `include.root.<expression>` of the same exposed include: equal to a literal, not to a list or map. */
export const includeValues: Array<[string, boolean]> = [
	['locals.l == tolist(["a"])', false],
	['locals.l == ["a"]', true],
	['inputs.i == tomap({ a = 1 })', false],
	['inputs.i == { a = 1 }', true]
];
