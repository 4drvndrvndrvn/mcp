// Safe arithmetic evaluator (recursive descent, no eval).

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI };
const FUNCTIONS = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  log: Math.log10, ln: Math.log, exp: Math.exp, min: Math.min, max: Math.max, pow: Math.pow,
};

function tokenize(src) {
  const tokens = [];
  const re = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)|([a-z_]\w*)|(\*\*|[-+*/%^(),]))/giy;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    const start = re.lastIndex;
    m = re.exec(src);
    if (!m) {
      if (/^\s*$/.test(src.slice(start))) break;
      throw new Error(`Unexpected character at position ${start + 1}: "${src.slice(start).trim()[0]}"`);
    }
    if (m[1] !== undefined) tokens.push({ type: 'num', value: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ type: 'id', value: m[2].toLowerCase() });
    else if (m[3] !== undefined) tokens.push({ type: 'op', value: m[3] === '**' ? '^' : m[3] });
  }
  return tokens;
}

export function evaluate(src) {
  if (typeof src !== 'string' || !src.trim()) throw new Error('Empty expression');
  if (src.length > 1000) throw new Error('Expression too long');
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v) => peek()?.type === 'op' && peek().value === v;
  const expect = (v) => {
    if (!isOp(v)) throw new Error(`Expected "${v}"`);
    pos++;
  };

  // expr := term (('+'|'-') term)*
  function expr() {
    let v = term();
    while (isOp('+') || isOp('-')) v = tokens[pos++].value === '+' ? v + term() : v - term();
    return v;
  }
  // term := unary (('*'|'/'|'%') unary)*
  function term() {
    let v = unary();
    while (isOp('*') || isOp('/') || isOp('%')) {
      const op = tokens[pos++].value;
      const r = unary();
      v = op === '*' ? v * r : op === '/' ? v / r : v % r;
    }
    return v;
  }
  // unary := ('+'|'-') unary | power
  function unary() {
    if (isOp('-')) { pos++; return -unary(); }
    if (isOp('+')) { pos++; return unary(); }
    return power();
  }
  // power := primary ('^' unary)?   (right-associative)
  function power() {
    const base = primary();
    if (isOp('^')) { pos++; return base ** unary(); }
    return base;
  }
  function primary() {
    const t = peek();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.type === 'num') { pos++; return t.value; }
    if (isOp('(')) { pos++; const v = expr(); expect(')'); return v; }
    if (t.type === 'id') {
      pos++;
      if (isOp('(')) {
        const fn = FUNCTIONS[t.value];
        if (!fn) throw new Error(`Unknown function "${t.value}"`);
        pos++;
        const args = [];
        if (!isOp(')')) {
          args.push(expr());
          while (isOp(',')) { pos++; args.push(expr()); }
        }
        expect(')');
        return fn(...args);
      }
      if (t.value in CONSTANTS) return CONSTANTS[t.value];
      throw new Error(`Unknown name "${t.value}"`);
    }
    throw new Error(`Unexpected "${t.value}"`);
  }

  const result = expr();
  if (pos < tokens.length) throw new Error(`Unexpected "${tokens[pos].value}"`);
  if (Number.isNaN(result)) throw new Error('Result is not a number');
  return result;
}
