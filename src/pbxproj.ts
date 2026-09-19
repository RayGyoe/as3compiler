// pbxproj.ts: a minimal OpenStep plist parser/serializer for reading and
// safely patching Xcode's project.pbxproj *in place*. Only the subset of the
// plist syntax that pbxproj actually uses is supported: line/block comments,
// quoted strings, arrays `( ... )`, dicts `{ key = value; }`, and bare atoms.
//
// Comments are dropped on parse and not re-emitted on serialize. That is safe
// because Xcode treats `/* ... */` comments in a pbxproj as pure readability
// hints (object display names) — losing them never changes project semantics,
// and Xcode regenerates them the next time it saves. This is what makes a
// "smart merge" possible: we parse the existing project into a value tree, edit
// only the source-file objects we own, and serialize the whole tree back without
// touching the user's hand-edited build settings, schemes, or extra files.

export type PlistValue =
  | { kind: 'dict'; entries: Array<[string, PlistValue]> }
  | { kind: 'array'; items: PlistValue[] }
  | { kind: 'string'; value: string }
  | { kind: 'atom'; value: string };

const PUNCT = new Set(['{', '}', '(', ')', '=', ';']);

class PlistParser {
  private src: string;
  private i = 0;

  constructor(src: string) {
    this.src = src;
  }

  parse(): PlistValue {
    const v = this.parseValue();
    this.skipTrivia();
    if (this.i < this.src.length) {
      throw new Error(`pbxproj: unexpected trailing content at offset ${this.i}`);
    }
    return v;
  }

  private skipTrivia(): void {
    for (;;) {
      // whitespace
      while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
      // line comment
      if (this.src.startsWith('//', this.i)) {
        while (this.i < this.src.length && this.src[this.i] !== '\n') this.i++;
        continue;
      }
      // block comment
      if (this.src.startsWith('/*', this.i)) {
        const end = this.src.indexOf('*/', this.i + 2);
        this.i = end === -1 ? this.src.length : end + 2;
        continue;
      }
      break;
    }
  }

  private parseValue(): PlistValue {
    this.skipTrivia();
    const c = this.src[this.i];
    if (c === '{') return this.parseDict();
    if (c === '(') return this.parseArray();
    if (c === '"') return { kind: 'string', value: this.parseString() };
    return { kind: 'atom', value: this.parseAtom() };
  }

  private parseDict(): PlistValue {
    this.expect('{');
    const entries: Array<[string, PlistValue]> = [];
    for (;;) {
      this.skipTrivia();
      if (this.src[this.i] === '}') { this.i++; break; }
      const key = this.parseKey();
      this.skipTrivia();
      this.expect('=');
      const value = this.parseValue();
      this.skipTrivia();
      this.expect(';');
      entries.push([key, value]);
    }
    return { kind: 'dict', entries };
  }

  private parseArray(): PlistValue {
    this.expect('(');
    const items: PlistValue[] = [];
    for (;;) {
      this.skipTrivia();
      if (this.src[this.i] === ')') { this.i++; break; }
      items.push(this.parseValue());
      this.skipTrivia();
      if (this.src[this.i] === ',') this.i++;
    }
    return { kind: 'array', items };
  }

  private parseKey(): string {
    this.skipTrivia();
    const c = this.src[this.i];
    if (c === '"') return this.parseString();
    return this.parseAtom();
  }

  private parseString(): string {
    this.expect('"');
    let out = '';
    for (;;) {
      const c = this.src[this.i++];
      if (c === undefined) throw new Error('pbxproj: unterminated string');
      if (c === '"') break;
      if (c === '\\') {
        const n = this.src[this.i++];
        if (n === '"' || n === '\\') out += n;
        else out += c + (n ?? '');
      } else {
        out += c;
      }
    }
    return out;
  }

  private parseAtom(): string {
    let out = '';
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      // ',' terminates array items (it is not in PUNCT, but must still not be
      // swallowed into the atom, or round-tripping would double it).
      if (/\s/.test(c) || PUNCT.has(c) || c === '"' || c === ',') break;
      out += c;
      this.i++;
    }
    if (out.length === 0) throw new Error(`pbxproj: unexpected character at offset ${this.i}`);
    return out;
  }

  private expect(ch: string): void {
    this.skipTrivia();
    if (this.src[this.i] !== ch) {
      throw new Error(`pbxproj: expected '${ch}' at offset ${this.i}, found '${this.src[this.i]}'`);
    }
    this.i++;
  }
}

export function parsePlist(text: string): PlistValue {
  return new PlistParser(text).parse();
}

// Serialize a value tree back into OpenStep plist text. The output is what Xcode
// emits: a `// !$*UTF8*$!` header, tab indentation, and one object per line
// inside dicts/arrays so the result stays diffable and human-readable.
export function serializePlist(root: PlistValue): string {
  return '// !$*UTF8*$!\n' + serializeValue(root, '');
}

function serializeValue(v: PlistValue, indent: string): string {
  switch (v.kind) {
    case 'atom':
      return v.value;
    case 'string':
      return '"' + v.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    case 'array': {
      if (v.items.length === 0) return '(\n' + indent + ')';
      const inner = v.items.map((it) => indent + '\t' + serializeValue(it, indent + '\t') + ',').join('\n');
      return '(\n' + inner + '\n' + indent + ')';
    }
    case 'dict': {
      if (v.entries.length === 0) return '{\n' + indent + '}';
      const inner = v.entries
        .map(([k, val]) => indent + '\t' + k + ' = ' + serializeValue(val, indent + '\t') + ';')
        .join('\n');
      return '{\n' + inner + '\n' + indent + '}';
    }
  }
}

// ---- query helpers used by the smart merge ----

export function asDict(v: PlistValue | undefined): Array<[string, PlistValue]> | null {
  return v && v.kind === 'dict' ? v.entries : null;
}

export function asArray(v: PlistValue | undefined): PlistValue[] | null {
  return v && v.kind === 'array' ? v.items : null;
}

// Atom/string both carry a scalar text; this returns it regardless of which.
export function scalarText(v: PlistValue | undefined): string | null {
  if (!v) return null;
  if (v.kind === 'string' || v.kind === 'atom') return v.value;
  return null;
}

// Find an entry in a dict by key (keys in pbxproj are unique).
export function dictEntry(dict: Array<[string, PlistValue]>, key: string): PlistValue | undefined {
  for (const [k, v] of dict) if (k === key) return v;
  return undefined;
}
