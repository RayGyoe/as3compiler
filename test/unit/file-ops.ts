// Unit checks: the File deletion / move / path contract (阶段二百九十八, batch A).
//
// The behavioural half lives in examples/file-ops.as, which asserts the measured
// adl 51.4.1 results one by one. What an example cannot catch is the SHAPE of the
// fix -- and this batch is exactly the kind that regresses quietly:
//
//   * the sync and async members must keep sharing ONE implementation
//     (as_file_delete_err), because the failure that started this was
//     deleteDirectoryAsync dispatching COMPLETE for a delete that never happened;
//   * the existence probe for a DELETE must be lstat, not stat, or a symlink to a
//     directory becomes deletable-by-following (AIR deletes the link, never the
//     target);
//   * moveTo must not grow a third parameter again (AIR declares two) and must not
//     rewrite nativePath (measured twice); a "convenient" restore of either would
//     still pass the example if the example were ever loosened.
//
// Probes and outputs: temp/fileaudit/adl/{Fp,Av,Av2,Av3}.as and out.txt / av.txt /
// av2.txt / av3.txt.
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup } from '../harness.ts';

// The smallest program that drags in every member pinned below.
const PROG = `
import flash.filesystem.File;
var f:File = new File("/tmp/x");
f.deleteFile();
f.deleteDirectory(true);
f.deleteFileAsync();
f.deleteDirectoryAsync(true);
f.moveTo(new File("/tmp/y"), true);
var n:Number = f.size;
f.nativePath = "/tmp/z";
var r:File = f.resolvePath("a/../b");
trace("" + n + r.nativePath);
`;

function checkContract(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [fileops] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [fileops] ${label}`); }
  };

  const c = generateC(parse(PROG)).c;

  // ---- AIR's declared shapes -------------------------------------------------
  // moveTo has TWO parameters. AIR's mxmlc rejects a third ("参数的数量不正确。
  // 要求不超过 2 个"), and the old third one (`force`) was ours, not AIR's.
  // (Pinned on the DEFINITION, not the prototype: the prototype spells the
  // parameters with AIR's own names -- `newFile`, `deleteDirectory` -- so it
  // cannot tell the arity apart from the spelling.)
  // Two parameters, and the first is typed FileReference -- which is what AIR
  // declares, and what makes `f.moveTo(otherFile)` accept any FileReference.
  check('File_moveTo is defined with exactly two parameters',
    c.includes('static void File_moveTo(void* _this, FileReference* newFile, bool overwrite) {'));
  // deleteDirectory gained its one parameter (the recursive flag).
  check('File_deleteDirectory takes the recursive flag',
    c.includes('static void File_deleteDirectory(void* _this, bool recursive) { int err ='));
  check('File_deleteFileAsync takes no flag',
    c.includes('static void File_deleteFileAsync(void* _this);'));

  // ---- one implementation, two report styles --------------------------------
  check('the sync deletes share as_file_delete_err',
    c.includes('void File_deleteFile(void* _this) { int err = as_file_delete_err((File*)_this, 0, 0);')
    && c.includes('void File_deleteDirectory(void* _this, bool recursive) { int err = as_file_delete_err((File*)_this, 1, recursive ? 1 : 0);'));
  check('the async deletes route through File__deleteDispatch',
    c.includes('File__deleteDispatch((File*)_this, as_file_delete_err((File*)_this, 0, 0));')
    && c.includes('File__deleteDispatch((File*)_this, as_file_delete_err((File*)_this, 1, recursive ? 1 : 0));'));
  // The bug this batch fixed: COMPLETE must be conditional on err == 0.
  check('COMPLETE is only dispatched when the delete succeeded',
    c.includes('if (err == 0) { EventDispatcher_dispatchEvent((void*)o, Event_new((char*)"complete", false, false)); return; }'));
  check('#2037 still THROWS from the async members (measured)',
    c.includes('if (err == 2037) { as_throw(Error_new((char*)as_file_err_text(err), err)); return; }'));

  // ---- the measured error table ---------------------------------------------
  for (const [id, sentence] of [
    ['2037', 'Functions called in incorrect sequence, or earlier call was unsuccessful.'],
    ['3001', 'File or directory access denied.'],
    ['3003', 'File or directory does not exist.'],
    ['3006', 'Not a file.'],
    ['3007', 'Not a directory.'],
    ['3010', 'Directory is not empty.'],
    ['3012', 'Cannot delete file or directory.'],
  ] as const) {
    check(`#${id} carries AIR's sentence verbatim`,
      c.includes(`case ${id}: return "Error #${id}: ${sentence}";`));
  }
  // 2038 is the fall-through: every unclassified refusal (EACCES on an rmdir, a
  // dangling rename, ...) ends up as "File I/O Error." without a case of its own.
  check("#2038 carries AIR's sentence verbatim",
    c.includes('Error #2038: File I/O Error.";') && !c.includes('case 2038:'));

  // ---- links: lstat for existence, stat for the directory gate --------------
  check('delete existence is lstat-based',
    c.includes('static bool as_path_exists_l(const char* p) {')
    && c.includes('return lstat(p, &st) == 0;'));
  check('deleteFile exempts a SYMLINK from the "not a file" gate',
    c.includes('if (as_path_is_dir(p) && !as_path_is_symlink(p)) return 3006;'));
  check('the recursive walker tests the link itself, not its target',
    c.includes('if (lstat(p, &st) != 0) return 3003;')
    && c.includes('if (!S_ISDIR(st.st_mode)) return (remove(p) == 0) ? 0 : 2038;'));
  check('the non-recursive form reports #3010 only for a non-empty directory',
    c.includes('return (errno == ENOTEMPTY || errno == EEXIST) ? 3010 : 2038;')
    && c.includes('return (GetLastError() == ERROR_DIR_NOT_EMPTY) ? 3010 : 2038;'));

  // ---- moveTo --------------------------------------------------------------
  // 阶段二百九十九 folded moveTo onto the SAME transfer validator copyToAsync and
  // moveToAsync use (as_file_transfer_err), so the rules below are pinned there --
  // one implementation, three entry points, exactly like the delete pair above.
  check('moveTo validates a null destination as AIR does (#2007 TypeError)',
    c.includes('as_file_null_dest();')
    && c.includes('as_throw(TypeError_new((char*)"Error #2007: Parameter destination must be non-null.", 2007));'));
  check('the shared transfer validator refuses an existing target without overwrite (#3012)',
    c.includes('if (!overwrite) return 3012;'));
  check('the shared transfer validator creates the destination parent directories',
    c.includes('if (parent != NULL && parent[0] != 0 && !as_path_is_dir(parent)) as_mkdirs(parent);'));
  // AIR declares moveTo(newFile:FileReference, overwrite:Boolean = false) -- the
  // parameter is typed FileReference, because a File IS one.
  const moveBody = /void File_moveTo\(void\* _this, FileReference\* newFile, bool overwrite\) \{([\s\S]*?)\n\}/.exec(c);
  // `nativePath =` alone would also match the `nativePath == NULL` guards, so the
  // pin has to name the assignment the old code made.
  check('moveTo leaves the receiver on its OLD path (measured)',
    moveBody != null && !/o->nativePath\s*=\s*newFile/.test(moveBody[1]));
  check('a cross-volume move copies and then deletes instead of giving up',
    moveBody != null
    && /rename\(o->nativePath, as_file_path_of\(\(void\*\)newFile\)\)/.test(moveBody[1])
    && /err = as_file_copy_any\(o->nativePath, dst\);/.test(moveBody[1])
    && /if \(err == 0\) err = as_remove_any\(o->nativePath\);/.test(moveBody[1]));

  // ---- size ----------------------------------------------------------------
  check('size throws #3003 for a missing path (the old 0 was wrong)',
    /double File_get_size[\s\S]*?stat\(o->nativePath, &st\) != 0[\s\S]*?3003/.test(c));
  check('size answers 0 for anything that is not a regular file',
    c.includes('if (!S_ISREG(st.st_mode)) return 0.0;'));

  // ---- paths ---------------------------------------------------------------
  check('the constructor normalises what it stores',
    c.includes('o->nativePath = (path != NULL) ? as_path_norm(path) : NULL;'));
  check('nativePath has a real setter (not just the field)',
    c.includes('void File_set_nativePath(void* _this, char* path) {')
    && c.includes('->vtable->set_nativePath('));
  check('the setter rejects a relative path with #2004',
    c.includes('if (path[0] == \'\\0\' || !as_path_is_abs(path)) { as_throw(ArgumentError_new((char*)"Error #2004: One of the parameters is invalid.", 2004)); return; }'));
  check('resolvePath refuses an empty File (#2037) and a null argument (#2007)',
    /File\* File_resolvePath[\s\S]*?2037[\s\S]*?2007/.test(c));

  if (ok > 0) console.log(`[fileops] ${ok} emit checks passed`);
  return bad;
}

registerGroup('unit: file-ops/contract', checkContract);