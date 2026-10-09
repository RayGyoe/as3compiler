// Barrel for the unit-check modules: importing this file registers every unit
// group with node:test. The full regression is `node test.ts`; the unit layer
// alone (filterable) is `node --test test/unit/*.ts`.
import './unit/diagnostics.ts';
import './unit/parser.ts';
import './unit/lexer.ts';
import './unit/build.ts';
import './unit/transport.ts';
import './unit/render.ts';
import './unit/display.ts';
import './unit/text-input.ts';
import './unit/numeric.ts';
import './unit/bytearray-amf.ts';
import './unit/reflection.ts';
import './unit/vector.ts';
import './unit/platform.ts';
import './unit/stage3d.ts';
import './unit/emit.ts';
import './unit/logical.ts';
import './unit/embed.ts';
import './unit/reach.ts';
