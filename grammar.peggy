{
  let heredocMarkerStack = [];
  let nextId = 1;

  function pushHeredocMarker(marker) {
    heredocMarkerStack.push(marker);
  }
  
  function popHeredocMarker() {
    return heredocMarkerStack.pop();
  }
  
  function peekHeredocMarker() {
    return heredocMarkerStack[heredocMarkerStack.length - 1];
  }

  function consolidateStringChars(chars) {
	const result = [];
	let currentString = '';
		
	for (const char of chars) {
	  if (typeof char === 'string') {
	  	currentString += char;
	  } else {
		if (currentString) {
		  result.push(currentString);
		  currentString = '';
		}
		result.push(char);
	  }
	}
	
	if (currentString) {
	  result.push(currentString);
	}
	
  	return result;
  }

  function getNextId() {
    return nextId++;
  }

  function makeNode(type, value, location, children = []) {
    const node = {
      id: getNextId(),
      type,
      ...(value !== null && { value }),
      location,
      ...(children.length > 0 && { children })
    };

    return node;
  }

  function makeIdentifierNode(name, location) {
    return makeNode('identifier', name, location);
  }

  function validateBodyAttributes(items) {
    const seen = new Set();
    for (const item of items) {
      const name = item.type === 'attribute' || item.type === 'assignment' ? item.value : null;
      if (name == null) continue;
      if (seen.has(name)) throw new Error(`Attribute redefined: ${name}`);
      seen.add(name);
    }
  }
}

Start = _ statements:Statement* _ !. {
  validateBodyAttributes(statements);
  return makeNode('root', null, location(), statements);
}

Statement = statement:(RootAssignment / Block) _ {
  return statement;
}

RootAssignment = _ name:RootAssignmentIdentifier _ "=" _ value:(ComprehensionExpression / RootValue / Boolean / StringLiteral) {
  return makeNode('assignment', name.value, location(), [name, value]);
}

RootValue = val:(
  Boolean /
  Block / 
  Expression /
  RootObject / 
  Array / 
  FunctionCall / 
  TypeConstraint /
  TypeConstructor /
  CollectionConstructor
) {
  return val;
}

Block = _ name:BlockIdentifier params:BlockParameter* _ metaArgs:MetaArguments? _ "{" _ items:BlockItems _ "}" {
  validateBodyAttributes(items || []);
  if ((items || []).some(item => ['block', 'dynamic_block', 'validation', 'check_block', 'import_block', 'moved_block', 'locals_block'].includes(item.type) && item.location.start.line === location().start.line)) {
    throw new Error('Nested blocks must start on their own line');
  }
  return makeNode('block', name.value, location(), [
    name, 
    ...params, 
    ...(metaArgs ? [metaArgs] : []),
    ...(items || [])
  ]);
}

BlockItems = items:(item:(
  BodyPair /
  ParameterizedBlock /
  DynamicBlock /
  ValidationBlock /
  MovedBlock /
  CheckBlock /
  ImportBlock /
  LocalsBlock /
  Block
) _ { return item; })* {
  return items;
}

BodyPair = key:UnquotedAttributeIdentifier _ ("=" / ":") _ value:Value {
  return makeNode('attribute', key.value, location(), [key, value]);
}
MovedBlock = "moved" _ "{" _
  "from" _ "=" _ from:Reference _
  "to" _ "=" _ to:Reference _
"}" {
  return makeNode('moved_block', null, location(), [from, to]);
}

CheckBlock = "check" _ "{" _
  assertions:AssertionBlock* _
"}" {
  return makeNode('check_block', null, location(), assertions);
}

AssertionBlock = "assert" _ "{" _
  "condition" _ "=" _ condition:Expression _
  "error_message" _ "=" _ message:StringLiteral _
"}" {
  return makeNode('assertion', null, location(), [
    makeNode('condition', null, location(), [condition]),
    makeNode('error_message', null, location(), [message])
  ]);
}

ImportBlock = "import" _ "{" _
  "id" _ "=" _ id:StringLiteral _
  "to" _ "=" _ to:Reference _
"}" {
  return makeNode('import_block', null, location(), [id, to]);
}

LocalsBlock = "locals" _ "{" _
  assignments:LocalAssignment* _
"}" {
  return makeNode('locals_block', null, location(), assignments);
}

LocalAssignment = name:Identifier _ "=" _ value:Expression {
  return makeNode('local_assignment', name, location(), [
    makeIdentifierNode(name, location()),
    value
  ]);
}

ParameterizedBlock = name:BlockIdentifier _ param:StringLiteral _ "{" _ items:BlockItems _ "}" {
  const paramNode = makeNode('parameter', param.value, param.location, [param]);
  return makeNode('block', name.value, location(), [name, paramNode, ...(items || [])]);
}

DynamicBlock = "dynamic" _ blockType:StringLiteral _ "{" _
  "for_each" _ "=" _ collection:Value _
  content:Block _
"}" {
  return makeNode('dynamic_block', blockType.value, location(), [
    makeNode('for_each', null, location(), [collection]),
    content
  ]);
}

BlockIdentifier = name:$([a-zA-Z_\u0080-\uFFFF][a-zA-Z0-9_\-.*\u0080-\uFFFF]*) {
  return makeNode('block_identifier', name, location());
}

BlockParameter = [ \t]+ ([ \t] / MultiLineComment)* param:(StringLiteral / Identifier) {
	if (typeof param !== 'string' && param.type !== 'string_lit') throw new Error('Interpolated block labels are not valid');
	return makeNode('parameter', typeof param === 'string' ? param : param.value, location(), typeof param === 'string' ? [] : [param]);
}

RootAssignmentIdentifier
  = name:$([a-zA-Z_\u0080-\uFFFF][a-zA-Z0-9_\-.\u0080-\uFFFF]*) {
    return makeNode('root_assignment_identifier', name, location());
  }

Pair = key:ObjectKey _ ("=" / ":") _ value:Value {
	return makeNode('attribute', key.type === 'attribute_identifier' ? key.value : null, location(), [key, value]);
}

ObjectKey
  = AttributeIdentifier
  / number:Number {
		return makeNode('object_key', null, location(), [number]);
	}
	/ "(" _ key:Expression _ ")" {
		return makeNode('object_key', null, location(), [key]);
	}

AttributeIdentifier
  = QuotedAttributeIdentifier / UnquotedAttributeIdentifier

QuotedAttributeIdentifier
  = str:StringLiteral {
    return makeNode('attribute_identifier', str.value, location(), [], { quoted: true });
  }

UnquotedAttributeIdentifier
  = name:$([a-zA-Z_\u0080-\uFFFF][a-zA-Z0-9_\-.\u0080-\uFFFF]*) {
    return makeNode('attribute_identifier', name, location(), [], { quoted: false });
  }

RootObject = "{" _ pairs:(Pair (_ ","? _ Pair)* (_ ",")?)? _ inherit:InheritanceExpression? _ "}" {
  const values = pairs ? [pairs[0], ...pairs[1].map(pair => pair[3])] : [];
  return makeNode('object', null, location(), [...values, ...(inherit ? [inherit] : [])]);
}

PrimaryExpression =
  StringLiteral /
  Number /
  Boolean /
  Null /
  Array /
  Object /
  FunctionCall /
  Reference /
  TraversalIdentifier /
  "(" _ expr:Expression _ ")" { return expr; } /
  SimpleExpression

TraversalIdentifier = name:$([a-zA-Z_\u0080-\uFFFF][a-zA-Z0-9_\-\u0080-\uFFFF]*) {
  return makeNode('traversal_reference', name, location());
}

Value = val:(
  Expression /
  Array /
  Object /
  TypeConstructor /
  CollectionConstructor
) _ {
  return val;
}

Reference = !FunctionCall ref:(
  DependencyReference /
  LocalReference /
  ModuleReference /
  TerraformReference /
  VarReference /
  DataReference /
  PathReference /
  GenericReference
) {
  return ref;
}

DependencyReference = "dependency" "." name:ReferenceIdentifier chain:("." ReferenceIdentifier)* {
  const accessChain = chain.map(c => c[1]);
  return makeNode('dependency_reference', null, location(), [
    makeNode('dependency_name', name.value, location(), [name]),
    makeNode('access_chain', null, location(), accessChain)
  ]);
}

LocalReference = 
  namespace:"local" "." 
  first:ReferenceIdentifier 
  rest:("." ReferenceIdentifier)* {
    const accessChain = [first, ...rest.map(r => r[1])];
    return makeNode('local_reference', null, location(), [
      makeNode('namespace', namespace, location()),
      makeNode('access_chain', null, location(), accessChain, {
        // Add order metadata
        resolution_order: accessChain.map((id, index) => ({
          level: index + 1,
          identifier: id.value
        }))
      })
    ]);
}

ModuleReference = 
  namespace:"module" "."
  moduleName:ReferenceIdentifier "."
  first:ReferenceIdentifier
  rest:("." ReferenceIdentifier)* {
    const accessChain = [first, ...rest.map(r => r[1])];
    return makeNode('module_reference', null, location(), [
      makeNode('namespace', namespace, location()),
      makeNode('module_name', moduleName.value, location(), [moduleName]),
      makeNode('access_chain', null, location(), accessChain, {
        resolution_order: accessChain.map((id, index) => ({
          level: index + 1,
          identifier: id.value
        }))
      })
    ]);
}

TerraformReference = 
  namespace:"terraform" "."
  attribute:ReferenceIdentifier {
    return makeNode('terraform_reference', null, location(), [
      makeNode('namespace', namespace, location()),
      makeNode('terraform_attribute', attribute.value, location(), [attribute])
    ]);
}

VarReference = 
  namespace:"var" "."
  first:ReferenceIdentifier
  rest:("." ReferenceIdentifier)* {
    const accessChain = [first, ...rest.map(r => r[1])];
    return makeNode('var_reference', null, location(), [
      makeNode('namespace', namespace, location()),
      makeNode('access_chain', null, location(), accessChain, {
        resolution_order: accessChain.map((id, index) => ({
          level: index + 1,
          identifier: id.value
        }))
      })
    ]);
}

DataReference = 
  namespace:"data" "."
  provider:ReferenceIdentifier "."
  resourceName:ReferenceIdentifier
  rest:("." ReferenceIdentifier)* {
    const accessChain = [resourceName, ...rest.map(r => r[1])];
    return makeNode('data_reference', null, location(), [
      makeNode('namespace', namespace, location()),
      makeNode('provider', provider.value, location(), [provider]),
      makeNode('access_chain', null, location(), accessChain, {
        resolution_order: accessChain.map((id, index) => ({
          level: index + 1,
          identifier: id.value
        }))
      })
    ]);
}

PathReference = 
  namespace:"path" "."
  attribute:("module" / "root" / "cwd") {
    return makeNode('path_reference', null, location(), [
      makeNode('namespace', namespace, location()),
      makeNode('path_attribute', attribute, location())
    ]);
}

GenericReference = namespace:ReferenceIdentifier chain:("." ReferenceIdentifier)+ {
  const accessChain = chain.map(c => c[1]);
  return makeNode('reference', namespace.value, location(), [
    makeNode('namespace', namespace.value, namespace.location),
    makeNode('access_chain', null, location(), accessChain)
  ]);
}

ReferenceChain = head:ReferenceIdentifier tail:("." ReferenceIdentifier)* {
  return [head, ...tail.map(t => t[1])];
}

ReferenceIdentifier = (
  NumericIdentifier /
  SimpleIdentifier /
  IndexIdentifier /
  QuotedIdentifier
)

NumericIdentifier = name:$([0-9]+) {
  return makeNode('reference_identifier', name, location());
}

SimpleIdentifier = name:$([a-zA-Z_\u0080-\uFFFF][a-zA-Z0-9_\-\u0080-\uFFFF]*) {
  return makeNode('reference_identifier', name, location());
}

IndexIdentifier = "[" index:(
  DecimalNumber /
  QuotedIndex /
  UnquotedIndex
) "]" {
  return makeNode('index_identifier', index, location());
}

QuotedIndex = '"' content:$([^"]*) '"' { return content; }
UnquotedIndex = content:$([^\]]*) { return content; }

QuotedIdentifier = '"' name:$([^"]*) '"' {
  return makeNode('reference_identifier', name, location(), [], { quoted: true });
}

Object = "{" _ pairs:(Pair (_ ","? _ Pair)* (_ ",")?)? _ "}" {
  const values = pairs ? [pairs[0], ...pairs[1].map(pair => pair[3])] : [];
  return makeNode('object', null, location(), values);
}

StringLiteral = QuotedString / Heredoc
Heredoc = "<<" trim:"-"? marker:beginMarker newline content:heredocContent endMarkerLine {
  popHeredocMarker();
  
  // Handle trimming if specified
  if (trim === "-" && Array.isArray(content)) {
    content = content.map(part => {
      if (typeof part === 'string') {
        return part.split('\n').map(line => line.trim()).join('\n');
      }
      return part;
    });
  } else if (trim === "-" && typeof content === 'string') {
    content = content.split('\n').map(line => line.trim()).join('\n');
  }

  const fullLocation = location();

  // If content is a string, create a string literal node
  if (typeof content === 'string') {
    return makeNode('string_lit', content, fullLocation);
  }

  // For content with interpolations, create an interpolated string node
  return makeNode('interpolated_string', null, fullLocation,
    content.map(part => {
      if (typeof part === 'string') {
        return makeNode('string_lit', part, fullLocation);
      }
      // Preserve interpolation nodes as they are
      return part;
    })
  );
}

heredocContent = parts:(
    (!endMarkerLine (
      InterpolatedExpr /
      "$$" "{" { return text(); } /
      "\r" { return text(); } /
      [^\r] { return text(); }
    ))
)* {
  // Extract actual content from the parts array structure
  let content = parts.map(([_, part]) => {
    if (typeof part === 'string') {
      return part;
    }
    // Handle interpolation nodes by preserving their structure
    return part;
  });
  
  // Consolidate consecutive string characters
  content = consolidateStringChars(content);
  
  // If all parts are strings, join them
  if (content.every(part => typeof part === 'string')) {
    return content.join('');
  }
  
  return content;
}

beginMarker = marker:$([A-Z][A-Z0-9_]*) {
  pushHeredocMarker(marker);
  return marker;
}

newline = "\n" / "\r\n"

whitespace = [ \t]* 

endMarkerLine =
  &{
    const match = input.slice(offset()).match(/^\r?\n[ \t]*([A-Z][A-Z0-9_]*)[ \t]*(?=\r?\n)/);
    return match !== null && match[1] === peekHeredocMarker();
  }
  newline
  whitespace
  marker:$[A-Z][A-Z0-9_]* 
  whitespace
  &newline


QuotedString = '"' chars:DoubleStringChar* '"' {
  // Group consecutive string characters together
  const consolidated = consolidateStringChars(chars);
  
  // If there's only one part and it's a string, return as string_lit
  if (consolidated.length === 1 && typeof consolidated[0] === 'string') {
    return makeNode('string_lit', consolidated[0], location());
  }
  
  // If all parts are strings (no interpolation), join them
  if (consolidated.every(c => typeof c === 'string')) {
    return makeNode('string_lit', consolidated.join(''), location());
  }
  
  // Create interpolated string with proper string chunks
  return makeNode('interpolated_string', null, location(), 
    consolidated.map(c => {
      if (typeof c === 'string') {
        return makeNode('string_lit', c, location());
      }
      return c;
    })
  );
}

DoubleStringChar =
  "$$" "{" { return text(); } /
  InterpolatedExpr /
  EscapedChar /
  [^"\\]

EscapeSequence = "\\" . { return text(); }
EscapedChar = "\\" escaped:. {
  switch (escaped) {
    case "n": return "\n";
    case "r": return "\r";
    case "t": return "\t";
    case "\"": return "\"";
    case "\\": return "\\";
    case "/": return "/";
    default: return escaped;
  }
}
InterpolatedExpr = (
  DirectiveInterpolation /
  TemplateInterpolation
)

StringContent = chars:(
  [^%] /
  "%" ![{}] /
  InterpolatedExpr
)* {
  // If no interpolations, join as simple string
  if (chars.every(c => typeof c === 'string')) {
    return makeNode('string_lit', chars.join(''), location());
  }
  
  // Otherwise create interpolated string with proper structure
  return makeNode('string_content', null, location(),
    chars.map(c => {
      if (typeof c === 'string') {
        return makeNode('string_lit', c, location());
      }
      return c;
    })
  );
}

TemplateInterpolation = "${" _ expr:Expression _ "}" {
  return makeNode('interpolation', null, location(), [expr]);
}

DirectiveInterpolation = RawDirective

RawDirective = "%{" body:$([^}]*) "}" {
  return makeNode('template_directive', body, location());
}

IfDirective = "%{" _ "if" _ condition:Expression _ "}" content:StringContent {
  return makeNode('if_directive', null, location(), [
    condition,
    content
  ]);
}

ForDirective = "%{" _ "for" _ item:Identifier _ "in" _ collection:Expression _ "}" content:StringContent {
  return makeNode('for_directive', null, location(), [
    makeIdentifierNode(item, location()),
    collection,
    content
  ]);
}

ElseDirective = "%{" _ "else" _ "}" content:StringContent {
  return makeNode('else_directive', null, location(), [content]);
}

EndifDirective = "%{" _ "endif" _ "}" {
  return makeNode('endif_directive', null, location());
}

Number = OctalNumber / LegacyOctal / DecimalNumber

LegacyOctal = "0" digits:$[0-7]+ {
  return makeNode('number_lit', parseInt(digits, 8), location());
}

HexNumber = "0x" digits:$[0-9a-fA-F]+ {
  return makeNode('number_lit', parseInt(digits, 16), location());
}

OctalNumber = "0o" digits:$[0-7]+ {
  return makeNode('number_lit', parseInt(digits, 8), location());
}

DecimalNumber = minus:"-"? int:Integer frac:Fraction? exp:Exponent? {
  return makeNode('number_lit', parseFloat(text()), location());
}

Integer = "0" / [1-9][0-9]*
Fraction = "." [0-9]+
Exponent = [eE] [+-]? [0-9]+

Boolean = val:("true" / "false") { 
  return makeNode('boolean_lit', val === 'true', location()); 
}

Null = "null" ![a-zA-Z0-9_\-] { return makeNode('null_lit', null, location()); }

Array = "[" _ items:(ArrayItem (_ "," _ ArrayItem)* (_ ",")?)? _ "]" {
  const values = items ? [items[0], ...items[1].map(item => item[3])] : [];
  return makeNode('array_lit', null, location(), values);
}

ArrayItem = val:(
  Expression /
  StringLiteral /
  Number /
  Boolean /
  Object /
  FunctionCall /
  PrimaryExpression /
  Reference
) {
  return val;
}

SimpleExpression = "${" expr:(!("}") .)* "}" {
  return makeNode('interpolation', text(), location());
}

Expression = 
  ParenthesizedTernary /
  TernaryExpression /
  ComprehensionExpression /
  PipeExpression

ParenthesizedTernary = "(" _ condition:LogicalExpression _ "?" _ trueExpr:PipeableExpression _ ":" _ falseExpr:PipeableExpression _ ")" {
  return makeNode('ternary_expression', null, location(), [condition, trueExpr, falseExpr]);
}

ComprehensionExpression = 
  head:(ListComprehension / MapComprehension) tail:PostfixTail* {
    return tail.reduce((expr, access) => access(expr), head);
  }

PipeableExpression = 
  ConditionalExpression /
  NullCoalescingExpression /
  RangeExpression /
  PrimaryExpression

PipeExpression = head:ConditionalExpression tail:(_ "|>" _ FunctionCall)* {
  return tail.reduce((expr, [_, __, ___, func]) => {
    func.children = [expr, ...func.children.slice(1)];
    return func;
  }, head);
}

ListComprehension = "[" _ 
  "for" _ item:Identifier _ 
  second:("," _ Identifier)? _
  "in" _ collection:(ParenthesizedCollection / Expression) _
  precondition:OptionalCondition? _
  ":" _ expr:Expression _
  postcondition:OptionalCondition? _
"]" {
  return makeNode('list_comprehension', null, location(), [
    makeIdentifierNode(item, location()),
    ...(second ? [makeIdentifierNode(second[2], location())] : []),
    collection,
    expr,
    ...(postcondition ? [postcondition] : [])
  ]);
}

MapComprehension = "{" _
  "for" _ item:Identifier _ 
  second:("," _ Identifier)? _
  "in" _ collection:(ParenthesizedCollection / Expression) _
  precondition:OptionalCondition? _
  ":" _ key:Expression _
  "=>" _ value:Expression _ grouping:"..."?
  postcondition:OptionalCondition? _
"}" {
  return makeNode('map_comprehension', null, location(), [
    makeIdentifierNode(item, location()),
    ...(second ? [makeIdentifierNode(second[2], location())] : []),
    collection,
    key,
    value,
    ...(postcondition ? [postcondition] : [])
  ]);
}

OptionalCondition = "if" _ condition:Expression {
  return condition;
}

ParenthesizedCollection = "(" _ condition:LogicalExpression _ "?" _ trueExpr:PostfixExpression _ ":" _ falseExpr:PostfixExpression _ ")" {
  return makeNode('ternary_expression', null, location(), [condition, trueExpr, falseExpr]);
}

ConditionalExpression =
  NullCoalescingExpression /
  LogicalExpression

NullCoalescingExpression = head:LogicalExpression tail:(_ "??" _ LogicalExpression)* {
  return tail.reduce((left, [_, __, ___, right]) =>
    makeNode('null_coalescing', null, location(), [left, right]),
    head
  );
}

RangeExpression = "range" "(" _ start:PipeableExpression _ "," _ end:PipeableExpression _ ")" {
  return makeNode('range_expression', null, location(), [start, end]);
}

ForExpression = "for" _ identifier:Identifier _ "in" _ collection:Expression _ ":" _ body:Expression {
  return makeNode('for_expression', null, location(), [
    makeIdentifierNode(identifier, location()),
    collection,
    body
  ]);
}

SplatExpression = base:PrimaryExpression _ ".*" _ attr:("." Identifier)? {
  return makeNode('splat_expression', null, location(), [
    base,
    ...(attr ? [makeIdentifierNode(attr[1], location())] : [])
  ]);
}

LogicalExpression = head:ComparisonExpression tail:(_ LogicalOperator _ ComparisonExpression)* {
  return tail.reduce((left, [_, op, __, right]) => 
    makeNode('logical_expression', op, location(), [left, right]),
    head
  );
}

UnaryLogicalExpression = "!" _ expr:Value {
  return makeNode('logical_expression', "!", location(), [expr]);
}

BinaryLogicalExpression = left:Value _ operator:("&&" / "||") _ right:Value {
  return makeNode('logical_expression', operator, location(), [left, right]);
}

TernaryExpression =
  condition:LogicalExpression _
  "?" _ trueExpr:Expression _
  ":" _ falseExpr:Expression {
    return makeNode('ternary_expression', null, location(), [condition, trueExpr, falseExpr]);
}

LogicalOperator = "&&" / "||"
ComparisonOperator = "==" / "!=" / ">=" / "<=" / ">" / "<"
AdditiveOperator = "+" / "-"
MultiplicativeOperator = "*" / "/" / "%"

ComparisonExpression = head:AdditiveExpression tail:(_ ComparisonOperator _ AdditiveExpression)* {
  return tail.reduce((left, [_, op, __, right]) =>
    makeNode('comparison_expression', op, location(), [left, right]),
    head
  );
}

AdditiveExpression = head:MultiplicativeExpression tail:(_ AdditiveOperator _ MultiplicativeExpression)* {
  return tail.reduce((left, [_, op, __, right]) =>
    makeNode('arithmetic_expression', op, location(), [left, right]),
    head
  );
}

MultiplicativeExpression = head:UnaryExpression tail:(_ MultiplicativeOperator _ UnaryExpression)* {
  return tail.reduce((left, [_, op, __, right]) =>
    makeNode('arithmetic_expression', op, location(), [left, right]),
    head
  );
}

UnaryExpression =
  LogicalNotExpression /
  NegationExpression /
  PostfixExpression

LogicalNotExpression = "!" _ expr:UnaryExpression {
  return makeNode('logical_expression', "!", location(), [expr]);
}

NegationExpression = "-" _ expr:UnaryExpression {
  return makeNode('arithmetic_expression', "-", location(), [expr]);
}

PostfixExpression = head:PrimaryExpression tail:(
  PostfixTail
)* {
  return tail.reduce((expr, access) => access(expr), head);
}

PostfixTail =
  IndexAccess /
  FullSplatAccess /
  SplatAccess /
  NumericMemberAccess /
  MemberAccess

IndexAccess = _ "[" _ index:(Number / StringLiteral / Expression) _ "]" {
  return base => makeNode('index_expression', null, location(), [base, index]);
}

SplatAccess = _ ".*" _ attr:("." Identifier)? {
  return base => makeNode('splat_expression', null, location(), [
    base,
    ...(attr ? [makeIdentifierNode(attr[1], location())] : [])
  ]);
}

FullSplatAccess = _ "[" _ "*" _ "]" _ attr:("." Identifier)? {
  return base => makeNode('splat_expression', null, location(), [
    base,
    ...(attr ? [makeIdentifierNode(attr[1], location())] : [])
  ]);
}

MemberAccess = _ "." _ member:Identifier {
  return base => makeNode('member_access', null, location(), [base, makeIdentifierNode(member, location())]);
}

NumericMemberAccess = _ "." _ member:Number {
  return base => makeNode('member_access', null, location(), [base, makeIdentifierNode(String(member.value), location())]);
}

FunctionCall = 
  identifier:FunctionIdentifier _
  TypeParameters? _
  "(" _ args:FunctionArgs? _ ")" {
    return makeNode('function_call', identifier.value, location(), [
      identifier,
      ...(args || [])
    ]);
}

TypeParameters = "<" _ types:TypeConstraint (_ "," _ TypeConstraint)* _ ">" {
  return makeNode('type_parameters', null, location(), [
    types,
    ...($2 || []).map(t => t[3])
  ]);
}

FunctionArgs = args:(
  VariadicArgs /
  PositionalArgs /
  NamedArgs /
  EmptyArgs
) {
  return args;
}

EmptyArgs = "" {
  return [];
}

PositionalArgs = first:FunctionArg rest:(_ "," _ (VariadicArg / FunctionArg))* _ ","? {
  return [first, ...rest.map(r => r[3])];
}

NamedArgs = first:NamedArg rest:(_ "," _ NamedArg)* {
  return [first, ...rest.map(r => r[3])];
}

NamedArg = name:Identifier _ "=" _ value:Expression {
  return makeNode('named_argument', name, location(), [value]);
}

VariadicArgs = args:Expression _ "..." {
  return [makeNode('variadic_arguments', null, location(), [args])];
}

VariadicArg = args:FunctionArg _ "..." {
  return makeNode('variadic_arguments', null, location(), [args]);
}

FunctionArg = arg:(
  Expression /
  StringLiteral /
  Number /
  Boolean /
  Array /
  Object /
  FunctionCall /
  PrimaryExpression /
  Reference
) {
  return arg;
}

FunctionIdentifier = identifier:$([a-zA-Z_][a-zA-Z0-9_\-]* ("::" [a-zA-Z_][a-zA-Z0-9_\-]*)*) {
  return makeNode('function_identifier', identifier, location());
}

Identifier = first:[a-zA-Z_\u0080-\uFFFF] rest:[a-zA-Z0-9_\-.\u0080-\uFFFF]* {
  return first + rest.join('');
}

_ = (Whitespace / Comment)*
Whitespace = [ \t\n\r]
Comment = 
  DirectiveComment /
  DocumentationComment /
  SingleLineComment /
  MultiLineComment

DirectiveComment = "#@" directive:DirectiveIdentifier _ content:[^\n]* "\n" {
  return makeNode('directive_comment', directive, location(), [
    makeNode('comment_content', content.join(''), location())
  ]);
}

DirectiveIdentifier = "description" / "example" / "deprecated" / "internal"

DocumentationComment = "/**" _ content:(!"*/" .)* _ "*/" {
  return makeNode('documentation_comment', content.map(c => c[1]).join(''), location());
}

SingleLineComment = ("#" / "//") [^\n]* "\n"?
MultiLineComment = "/*" (!"*/" .)* "*/"

TypeConstraint = 
  PrimitiveType /
  CollectionType /
  StructType /
  TupleType /
  ObjectType /
  AnyType

PrimitiveType = ("string" / "number" / "bool") {
  return makeNode('type_constraint', text(), location());
}

CollectionType = type:("list" / "set" / "map") "(" _ elementType:TypeConstraint _ ")" {
  return makeNode('collection_type', type, location(), [elementType]);
}

StructType = "object" "(" _ attrs:StructTypeAttribute* _ ")" {
  return makeNode('struct_type', null, location(), attrs);
}

StructTypeAttribute = name:Identifier _ "=" _ type:TypeConstraint _ "," _ {
  return makeNode('struct_attribute', name, location(), [type]);
}

TupleType = "tuple" "(" _ types:(TypeConstraint (_ "," _ TypeConstraint)*)? _ ")" {
  const typeList = types ? [types[0], ...types[1].map(t => t[3])] : [];
  return makeNode('tuple_type', null, location(), typeList);
}

ObjectType = "object" {
  return makeNode('type_constraint', 'object', location());
}

AnyType = "any" {
  return makeNode('type_constraint', 'any', location());
}

TypeConstructor = type:("list" / "map" / "set") "(" _ value:Value _ ")" {
  return makeNode('type_constructor', type, location(), [value]);
}

CollectionConstructor = func:("tolist" / "toset" / "tomap") "(" _ value:Value _ ")" {
  return makeNode('collection_constructor', func, location(), [value]);
}

IndexExpression = base:PrimaryExpression _ "[" _ index:(Number / StringLiteral / Expression) _ "]" {
  return makeNode('index_expression', null, location(), [base, index]);
}

InheritanceExpression = "inherit" _ "=" _ source:Value {
  return makeNode('inheritance', null, location(), [source]);
}

MetaArguments = "[" _ args:MetaArgument* _ "]" {
  return makeNode('meta_arguments', null, location(), args);
}

MetaArgument = 
  CountArg /
  ForEachArg /
  DependsOnArg /
  ProviderArg /
  LifecycleArg /
  PreconditionBlock /
  PostconditionBlock /
  ReplaceTriggerBlock

PreconditionBlock = "precondition" _ "{" _
  "condition" _ "=" _ condition:Expression _
  "error_message" _ "=" _ message:StringLiteral _
"}" {
  return makeNode('precondition', null, location(), [
    makeNode('condition', null, location(), [condition]),
    makeNode('error_message', null, location(), [message])
  ]);
}

PostconditionBlock = "postcondition" _ "{" _
  "condition" _ "=" _ condition:Expression _
  "error_message" _ "=" _ message:StringLiteral _
"}" {
  return makeNode('postcondition', null, location(), [
    makeNode('condition', null, location(), [condition]),
    makeNode('error_message', null, location(), [message])
  ]);
}

ReplaceTriggerBlock = "replace_triggered_by" _ "=" _ triggers:Array {
  return makeNode('replace_triggered_by', null, location(), [triggers]);
}

CountArg = "count" _ "=" _ value:Value {
  return makeNode('meta_count', null, location(), [value]);
}

ForEachArg = "for_each" _ "=" _ value:Value {
  return makeNode('meta_for_each', null, location(), [value]);
}

DependsOnArg = "depends_on" _ "=" _ deps:Array {
  return makeNode('meta_depends_on', null, location(), [deps]);
}

ProviderArg = "provider" _ "=" _ value:Value {
  return makeNode('meta_provider', null, location(), [value]);
}

LifecycleArg = "lifecycle" _ "{" _ rules:LifecycleRule* _ "}" {
  return makeNode('meta_lifecycle', null, location(), rules);
}

LifecycleRule = (
  "create_before_destroy" _ "=" _ Boolean /
  "prevent_destroy" _ "=" _ Boolean /
  "ignore_changes" _ "=" _ Array
) {
  return makeNode('lifecycle_rule', null, location(), []);
}

ValidationBlock = "validation" _ "{" _
  "condition" _ "=" _ condition:Expression _
  "error_message" _ "=" _ message:StringLiteral _
"}" {
  return makeNode('validation', null, location(), [
    makeNode('condition', null, location(), [condition]),
    makeNode('error_message', null, location(), [message])
  ]);
}
