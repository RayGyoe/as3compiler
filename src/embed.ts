// Embed: AS3 `[Embed(source=...)]` assets (阶段一百一十二).
//
// One responsibility: turn an `[Embed]`-decorated class member into (a) a
// synthesized class declaration whose instances ARE the asset, (b) the encoded
// bytes the emitter embeds into the generated C, and (c) the `<class>#<field>`
// key that makes the declaring field hold that class value. Like swc.ts it only
// produces AST and bytes — never C text and never build orchestration (§2.8), and
// it runs BEFORE codegen so the synthesized classes take part in symbol
// collection, vtables and the class registry.
//
// What AIR does (measured on adl 51.4.1, `temp/embedprobe*`; see docs/zh-cn/embed.md):
//   * an embedded PNG/JPEG/GIF becomes a class that `extends flash.display.Bitmap`
//     and is constructed with NO arguments (`new C(0,0)` is ArgumentError #1063
//     "Expected 0, got 2"), whose `bitmapData` is the decoded image;
//   * `mimeType="application/octet-stream"` becomes a `flash.utils.ByteArray`
//     subclass whose content is the raw file bytes — that is how a `.xml`/`.fnt`/
//     `.pbj` payload travels (its extension then means nothing at all);
//   * an MP3 becomes a `flash.media.Sound` subclass whose `.length` is the real
//     decoded duration, so `[Embed]` audio and `Sound.loadCompressedDataFromByteArray`
//     are the same object graph;
//   * `mimeType` OVERRIDES the extension for the choice of asset kind
//     (png + octet-stream ⇒ ByteArray, mp3 + octet-stream ⇒ ByteArray).
// The generated class's own name in AIR is `<file>_<ext>$<hash>` — a hash we can
// neither reproduce nor reference, so ours is derived from the declaring class and
// field instead: deterministic, traceable, and (unlike AIR's) it cannot collide
// with a source identifier because no source can spell it.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ClassMember, Metadata, Stmt } from './ast.ts';
import { CodegenError, qualifiedName, SymbolTable } from './symbols.ts';

/** Which built-in class an embedded asset's generated class extends. */
export type EmbedKind = 'image' | 'binary' | 'sound';

/** Extensions AIR accepts without a `mimeType`, per asset kind. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp']);
const SOUND_EXTENSIONS = new Set(['mp3']);

/** `mimeType` values AIR accepts, mapped to the asset kind they select. */
const MIME_KINDS: Readonly<Record<string, EmbedKind>> = {
  'application/octet-stream': 'binary',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/bmp': 'image',
  'audio/mpeg': 'sound',
};

export interface EmbedResourceSpec {
  /** AS3 name of the generated class (default package, so name === FQN). */
  className: string;
  /** Sanitized C class identifier. */
  cname: string;
  kind: EmbedKind;
  /** Generated C array holding `encoded`. */
  bytesSymbol: string;
  encoded: Buffer;
  /** `<declaring class>.<field>`, for the provenance comment and the build log. */
  declaredAt: string;
  /** The `source` value as written in the metadata. */
  source: string;
  /** The file the bytes were actually read from. */
  resolved: string;
}

export interface EmbedInputs {
  /** Synthesized class declarations, to append to the program before codegen. */
  decls: Stmt[];
  resources: EmbedResourceSpec[];
  /** `<declaring class FQN>#<field name>` → generated class FQN. */
  fieldInits: Map<string, string>;
}

/** The key a declaring class + field pair is looked up by (see SymbolTable). */
export function embedFieldKey(ownerName: string, ownerPackage: string | null, field: string): string {
  return SymbolTable.embedFieldKey(ownerName, ownerPackage, field);
}

/**
 * Pick the asset kind for one `[Embed]`, mirroring AIR's rule that an explicit
 * `mimeType` wins over the file extension. An unknown combination is REFUSED with
 * the supported set spelled out — AIR also refuses it ("文件类型未知，无法嵌入"),
 * and silently embedding the wrong kind of object is worse than not compiling
 * (§2.5).
 */
function resolveKind(md: Metadata, source: string, at: string, line?: number, col?: number): EmbedKind {
  const mime = md.named?.['mimeType'];
  if (mime !== undefined) {
    const kind = MIME_KINDS[mime];
    if (kind === undefined) {
      throw new CodegenError(
        `[Embed] mimeType '${mime}' on '${at}' is not supported by this build ` +
          `(supported: ${Object.keys(MIME_KINDS).join(', ')})`,
        line,
        col
      );
    }
    return kind;
  }
  const ext = source.includes('.') ? source.slice(source.lastIndexOf('.') + 1).toLowerCase() : '';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (SOUND_EXTENSIONS.has(ext)) return 'sound';
  throw new CodegenError(
    `[Embed] source '${source}' on '${at}' has no recognized asset type: this build embeds ` +
      `.png/.jpg/.jpeg/.gif/.bmp (image), .mp3 (sound), and any file declared ` +
      `mimeType="application/octet-stream" (raw bytes)`,
    line,
    col
  );
}

/**
 * Resolve an `[Embed(source=...)]` path the way AIR's compiler does: a relative
 * source is resolved against the DIRECTORY OF THE DECLARING FILE, while a leading
 * `/` is resolved against the source root (the `src/` tree of an `--air-app`
 * build). Measured on adl by embedding the same file from two directories
 * (`temp/embedprobe4`): relative follows the declaring file, `/` follows
 * `-source-path` — which is why away3d writes `/../pb/RayTriangleKernel.pbj` to
 * reach `<app root>/pb/` from the `src/` root.
 */
export function resolveEmbedSource(source: string, fileDir: string, sourceRoot: string): string {
  return source.startsWith('/') ? resolve(sourceRoot, `.${source}`) : resolve(fileDir, source);
}

/** The built-in class one asset kind's generated class extends. */
function superClassOf(kind: EmbedKind): string {
  return kind === 'image'
    ? 'flash.display.Bitmap'
    : kind === 'binary'
      ? 'flash.utils.ByteArray'
      : 'flash.media.Sound';
}

/**
 * Synthesize the AST class for one embedded asset: a `dynamic` subclass of the
 * kind's built-in class with a ZERO-ARGUMENT constructor. The body carries nothing
 * — the emitter binds the bytes in the constructor's epilogue (emitEmbedResources),
 * after `super()` and the field initializers, exactly where the SWC resource
 * classes receive their decoded image (swc.md §6).
 */
function embedClassDecl(name: string, kind: EmbedKind): Stmt {
  const superClass = superClassOf(kind);
  return {
    kind: 'ClassDecl',
    name,
    packageName: null,
    // Fully qualified so `resolveType` maps it to the short-keyed built-in.
    superClass,
    isFinal: true, // AIR's generated asset classes are final and dynamic
    isDynamic: true,
    implements: [],
    metadata: [],
    imports: [superClass],
    fileId: null,
    members: [{ kind: 'Constructor', params: [], body: { kind: 'Block', body: [] } }],
  };
}

/**
 * Collect every `[Embed]` in one parsed file.
 *
 * `fileDir` is the directory of the file `body` came from (AIR resolves a relative
 * `source` against it) and `sourceRoot` the root a leading `/` resolves against.
 * Returns the synthesized class declarations, the resource specs and the map that
 * gives the declaring field its class value — the caller appends the decls to the
 * program and hands the rest to codegen.
 */
export function embedCompileInputs(
  body: readonly Stmt[],
  opts: { fileDir: string; sourceRoot: string }
): EmbedInputs {
  const decls: Stmt[] = [];
  const resources: EmbedResourceSpec[] = [];
  const fieldInits = new Map<string, string>();
  const claimed = new Map<string, string>();
  // (resolved file, kind) -> generated class name, so the same asset embedded
  // twice shares one class object (see the note at the push site).
  const assets = new Map<string, string>();

  for (const stmt of body) {
    if (stmt.kind !== 'ClassDecl') continue;
    const ownerFqn = stmt.packageName ? `${stmt.packageName}::${stmt.name}` : stmt.name;
    for (const m of stmt.members as ClassMember[]) {
      if (m.kind !== 'Field' && m.kind !== 'Method') continue;
      const md = m.metadata?.find((x) => x.name === 'Embed');
      if (md === undefined) continue;
      const at = `${ownerFqn}.${m.name}`;
      // `[Embed]` on a member that cannot hold the generated Class value is refused
      // rather than ignored; AIR's compiler rejects the same placement.
      if (m.kind !== 'Field') {
        throw new CodegenError(`[Embed] is only supported on a Class-typed class member, not on '${at}'`, m.line, m.col);
      }
      if (m.init !== null) {
        throw new CodegenError(
          `[Embed] field '${at}' must not also have an initializer — the embedded asset supplies its value`,
          m.line,
          m.col
        );
      }
      if (m.type !== 'Class') {
        throw new CodegenError(
          `[Embed] field '${at}' must be typed Class (the embedded asset is reached through a generated class)`,
          m.line,
          m.col
        );
      }
      const source = md.named?.['source'] ?? md.args[0];
      if (source === undefined) {
        throw new CodegenError(`[Embed] on '${at}' has no source`, m.line, m.col);
      }
      const kind = resolveKind(md, source, at, m.line, m.col);
      const resolved = resolveEmbedSource(source, opts.fileDir, opts.sourceRoot);
      let encoded: Buffer;
      try {
        encoded = readFileSync(resolved);
      } catch {
        throw new CodegenError(
          `[Embed] source '${source}' on '${at}' not found: ${resolved} (a relative source resolves ` +
            `against the declaring file's directory, a leading '/' against the source root ${opts.sourceRoot})`,
          m.line,
          m.col
        );
      }

      // One generated class per embedded ASSET -- (resolved file, kind) -- named
      // after the declaring class and field so it is unique and readable in the
      // emitted C. Two fields embedding the same file with the same mimeType share
      // ONE class object, which is what AIR does: measured on adl 51.4.1
      // (temp/embedprobe7), `[Embed(source="px.png")]` declared twice yields
      // `picA === picB` true and the same getQualifiedClassName. A different
      // mimeType is a different asset (a different class) even for the same file.
      const assetKey = `${resolved}\u0000${kind}`;
      const shared = assets.get(assetKey);
      if (shared !== undefined) {
        fieldInits.set(embedFieldKey(stmt.name, stmt.packageName, m.name), shared);
        continue;
      }
      const className = `Embed_${qualifiedName(stmt.name, stmt.packageName)}_${m.name}`;
      const cname = qualifiedName(className, null);
      const previous = claimed.get(cname);
      if (previous !== undefined) {
        throw new CodegenError(
          `[Embed] '${at}' generates the class '${className}', which '${previous}' already declares`,
          m.line,
          m.col
        );
      }
      claimed.set(cname, at);
      assets.set(assetKey, className);
      decls.push(embedClassDecl(className, kind));
      resources.push({
        className,
        cname,
        kind,
        bytesSymbol: `as_embed_bytes_${cname}`,
        encoded,
        declaredAt: at,
        source,
        resolved,
      });
      fieldInits.set(embedFieldKey(stmt.name, stmt.packageName, m.name), className);
    }
  }

  return { decls, resources, fieldInits };
}