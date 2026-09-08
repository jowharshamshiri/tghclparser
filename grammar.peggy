{
  let heredocMarkerStack = [];
  let nextId = 1;
  // End offsets of the JavaScript bodies currently being consumed, innermost
  // last. See InlineFunctionBody.
  let jsBodyEndStack = [];

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

  // Scans a JavaScript function body beginning at `start`, the offset of the
  // first character after the opening brace, and returns the offset of the last
  // character belonging to the body — that is, one before the matching closing
  // brace. For an empty body this is `start - 1`, so that the caller
  // consumes nothing. Brace depth is tracked through string literals, template
  // literals (including nested substitutions, which may themselves
  // contain braces and strings), regular expression literals, and both comment
  // forms, so that a brace appearing inside any of those does not terminate the
  // body.
  //
  // Returns -1 when the body is unterminated, letting the caller fail the match
  // and report a located parse error rather than silently consuming the rest of
  // the file.
  // Brace characters are referenced by code point throughout this scanner:
  // Peggy delimits grammar code blocks by counting braces without regard for
  // string literals, so a literal brace character here would truncate the
  // block.
  function scanJsBody(source, start) {
    const OPEN_BRACE = 123;
    const CLOSE_BRACE = 125;
    const BACKTICK = 96;
    const DOLLAR = 36;
    const BACKSLASH = 92;
    const SLASH = 47;
    const STAR = 42;
    const DOUBLE_QUOTE = 34;
    const SINGLE_QUOTE = 39;
    const NEWLINE = 10;
    const RETURN = 13;
    const OPEN_BRACKET = 91;
    const CLOSE_BRACKET = 93;
    const CLOSE_PAREN = 41;
    const REGEX_PRECEDING_KEYWORDS = [
      'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
      'throw', 'case', 'do', 'else', 'yield', 'await'
    ];

    // Tracks the nesting of substitutions inside template literals. Each
    // entry is the brace depth at which the enclosing template resumes.
    const templateStack = [];
    let depth = 1;
    let index = start;

    // Scans a template literal from `position`, which is the offset just after
    // an opening backtick or after the closing brace of a substitution.
    // Returns the offset to resume the outer scan from, or -1 when the template
    // is unterminated. Entering a substitution raises `depth` and records the
    // depth at which the template resumes.
    const scanTemplate = position => {
      let scan = position;
      while (scan < source.length) {
        const code = source.charCodeAt(scan);
        if (code === BACKSLASH) { scan += 2; continue; }
        if (code === BACKTICK) return scan + 1;
        if (code === DOLLAR && source.charCodeAt(scan + 1) === OPEN_BRACE) {
          templateStack.push(depth);
          depth += 1;
          return scan + 2;
        }
        scan += 1;
      }
      return -1;
    };

    // Determines whether a `/` at `position` opens a regular expression literal
    // rather than acting as a division operator, by inspecting the previous
    // significant character.
    const regexAllowed = position => {
      let scan = position - 1;
      while (scan >= start) {
        const code = source.charCodeAt(scan);
        if (code === 32 || code === 9 || code === NEWLINE || code === RETURN) {
          scan -= 1;
          continue;
        }
        if (code === CLOSE_PAREN || code === CLOSE_BRACKET || code === CLOSE_BRACE) return false;
        const previous = source[scan];
        if (/[A-Za-z0-9_$]/.test(previous)) {
          // Keywords may be followed by a regex; identifiers and literals may not.
          const wordEnd = scan + 1;
          let wordStart = scan;
          while (wordStart >= start && /[A-Za-z0-9_$]/.test(source[wordStart])) wordStart -= 1;
          return REGEX_PRECEDING_KEYWORDS.includes(source.slice(wordStart + 1, wordEnd));
        }
        return true;
      }
      return true;
    };

    while (index < source.length) {
      const code = source.charCodeAt(index);

      if (code === BACKSLASH) {
        index += 2;
        continue;
      }

      if (code === SLASH && source.charCodeAt(index + 1) === SLASH) {
        const newlineIndex = source.indexOf('\n', index);
        if (newlineIndex === -1) return -1;
        index = newlineIndex + 1;
        continue;
      }

      if (code === SLASH && source.charCodeAt(index + 1) === STAR) {
        const closeIndex = source.indexOf('*/', index + 2);
        if (closeIndex === -1) return -1;
        index = closeIndex + 2;
        continue;
      }

      if (code === SLASH && regexAllowed(index)) {
        let scan = index + 1;
        let inClass = false;
        let terminated = false;
        while (scan < source.length) {
          const inner = source.charCodeAt(scan);
          if (inner === BACKSLASH) { scan += 2; continue; }
          if (inner === NEWLINE || inner === RETURN) break;
          if (inner === OPEN_BRACKET) inClass = true;
          else if (inner === CLOSE_BRACKET) inClass = false;
          else if (inner === SLASH && !inClass) { terminated = true; scan += 1; break; }
          scan += 1;
        }
        if (terminated) {
          // Consume trailing regex flags.
          while (scan < source.length && /[a-z]/.test(source[scan])) scan += 1;
          index = scan;
          continue;
        }
        // Not a regex after all; treat it as a division operator.
        index += 1;
        continue;
      }

      if (code === DOUBLE_QUOTE || code === SINGLE_QUOTE) {
        let scan = index + 1;
        let terminated = false;
        while (scan < source.length) {
          const inner = source.charCodeAt(scan);
          if (inner === BACKSLASH) { scan += 2; continue; }
          if (inner === NEWLINE || inner === RETURN) break;
          if (inner === code) { terminated = true; scan += 1; break; }
          scan += 1;
        }
        if (!terminated) return -1;
        index = scan;
        continue;
      }

      if (code === BACKTICK) {
        const resumed = scanTemplate(index + 1);
        if (resumed === -1) return -1;
        index = resumed;
        continue;
      }

      if (code === OPEN_BRACE) {
        depth += 1;
        index += 1;
        continue;
      }

      if (code === CLOSE_BRACE) {
        depth -= 1;
        index += 1;
        if (templateStack.length > 0 && depth === templateStack[templateStack.length - 1]) {
          // Closing a substitution: resume scanning the template body.
          templateStack.pop();
          const resumed = scanTemplate(index);
          if (resumed === -1) return -1;
          index = resumed;
          continue;
        }
        if (depth === 0) {
          // `index` sits just past the closing brace, so `index - 1` is the
          // brace itself and `index - 2` is the body's last character. The
          // caller consumes body characters while `offset() <= result`.
          return index - 2;
        }
        continue;
      }

      index += 1;
    }

    return -1;
  }
}

Start = _ statements:Statement* _ !. {
  validateBodyAttributes(statements);
  return makeNode('root', null, location(), statements);
}

Statement = statement:(InlineFunction / RootAssignment / Block) _ {
  return statement;
}

// A JavaScript function defined inline in a configuration:
//
//   function state_key(environment, component = "app") {
//     return `${environment}/${component}/terraform.tfstate`;
//   }
//
// The signature declares parameters positionally using JavaScript conventions;
// the body is raw JavaScript captured verbatim so that it can be compiled and
// so that runtime errors map back to their original source positions.
InlineFunction =
  _ "function" ![a-zA-Z0-9_\-] _ name:Identifier _
  "(" _ params:InlineFunctionParams? _ ")" _
  body:InlineFunctionBody {
    const parameters = params || [];
    const seen = new Set();
    let seenOptional = false;
    let seenVariadic = false;
    for (const parameter of parameters) {
      // Must match TG_BINDING_NAME in Evaluator.ts: a parameter of that name
      // would shadow the configuration binding and silently discard the
      // caller's argument.
      if (parameter.value === 'tg') {
        throw new Error(
          `Parameter "tg" in function "${name}" collides with the configuration binding of the same name`
        );
      }
      if (seen.has(parameter.value)) {
        throw new Error(`Duplicate parameter "${parameter.value}" in function "${name}"`);
      }
      seen.add(parameter.value);
      if (seenVariadic) {
        throw new Error(`Parameter "${parameter.value}" in function "${name}" follows a variadic parameter`);
      }
      const isVariadic = parameter.variadic === true;
      const hasDefault = (parameter.children || []).some(child => child.type === 'param_default');
      if (isVariadic) {
        if (hasDefault) {
          throw new Error(`Variadic parameter "${parameter.value}" in function "${name}" cannot have a default`);
        }
        seenVariadic = true;
        continue;
      }
      if (hasDefault) seenOptional = true;
      else if (seenOptional) {
        throw new Error(`Required parameter "${parameter.value}" in function "${name}" follows an optional parameter`);
      }
    }
    return makeNode('inline_function', name, location(), [...parameters, body]);
  }

InlineFunctionParams = first:InlineFunctionParam rest:(_ "," _ InlineFunctionParam)* (_ ",")? {
  return [first, ...rest.map(entry => entry[3])];
}

InlineFunctionParam =
  variadic:"..."? _ name:Identifier _
  type:(":" _ TypeConstraint)? _
  def:("=" _ Expression)? {
    const node = makeNode('inline_param', name, location(), [
      ...(type ? [makeNode('param_type', null, location(), [type[2]])] : []),
      ...(def ? [makeNode('param_default', null, location(), [def[2]])] : [])
    ]);
    node.variadic = variadic === '...';
    return node;
  }

// Captures the JavaScript body between its outermost braces.
//
// PEG rules consume input only by matching, so the body is consumed one
// character at a time by `InlineFunctionBodyChar`, which uses a predicate to
// stop exactly at the matching close brace located by `scanJsBody`. The scan
// runs once per body: the opening brace records the end offset on
// `jsBodyEndStack`, and the closing brace pops it. The stack accommodates a
// nested `function` definition appearing inside a JavaScript body — the inner
// body pushes and pops its own entry without disturbing the outer one.
InlineFunctionBody =
  "{" &{
    const end = scanJsBody(input, offset());
    if (end === -1) return false;
    jsBodyEndStack.push(end);
    return true;
  }
  body:$(InlineFunctionBodyChar*)
  "}" {
    jsBodyEndStack.pop();
    return makeNode('js_body', body, location());
  }

InlineFunctionBodyChar = !{ return offset() > jsBodyEndStack[jsBodyEndStack.length - 1]; } .

RootAssignment = _ name:RootAssignmentIdentifier _ "=" _ value:(ComprehensionExpression / RootValue / Boolean / StringLiteral) {
  return makeNode('assignment', name.value, location(), [name, value]);
}

RootValue = val:(
  Boolean /
  Block / 
  RootObject / 
  Array / 
  Expression /
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
      "$$" "{" { return "\x24" + String.fromCharCode(123); } /
      "%%" "{" { return "%" + String.fromCharCode(123); } /
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
  "$$" "{" { return "\x24" + String.fromCharCode(123); } /
  "%%" "{" { return "%" + String.fromCharCode(123); } /
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
  ComprehensionExpression /
  TernaryExpression /
  PipeExpression

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

ParenthesizedCollection = "(" _ condition:LogicalExpression _ "?" _ trueExpr:PostfixExpression _ ":" _ falseExpr:PostfixExpression _ ")" tail:PostfixTail* {
  const ternary = makeNode('ternary_expression', null, location(), [condition, trueExpr, falseExpr]);
  return tail.reduce((expr, access) => access(expr), ternary);
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
