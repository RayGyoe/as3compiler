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
import './unit/ime.ts';
import './unit/numeric.ts';
import './unit/bytearray-amf.ts';
import './unit/flash-data.ts';
import './unit/reflection.ts';
import './unit/reflect.ts';
import './unit/vector.ts';
import './unit/platform.ts';
import './unit/stage3d.ts';
import './unit/emit.ts';
import './unit/logical.ts';
import './unit/inline.ts';
import './unit/embed.ts';
import './unit/audio-example.ts';
import './unit/reach.ts';
import './unit/doctor.ts';
import './unit/vsync.ts';
import './unit/npm-package.ts';
import './unit/cli.ts';
import './unit/fre.ts';
import './unit/fqn-static.ts';
import './unit/testinfra.ts';
