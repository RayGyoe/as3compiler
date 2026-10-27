// Unit checks: the FileStream IDataInput/IDataOutput surface and the File members
// that shipped with it (阶段二百九十九, batches B and C).
//
// The behavioural half lives in examples/file-audit.as, which asserts the measured
// adl 51.4.1 answers one by one (probes temp/fileaudit2/AF.as, AG.as, AH.as and
// their .txt outputs). What an example cannot catch is the SHAPE of the wiring,
// and every item below is a shape that would still pass the example if it slipped:
//
//   * FileStream must really declare the two interfaces, or a function taking an
//     IDataInput accepts a ByteArray but not a FileStream -- a compile error AIR
//     does not have;
//   * the byte order helpers must build the file bytes EXACTLY once. The first
//     version flipped them twice (once in as_fs_w32, once in as_fs_write_bits) and
//     the only symptom was readInt coming back byte-swapped;
//   * StorageVolume's six constructor arguments are not in the SDK's field order
//     (name is second, drive is last), which is a mistake that reads perfectly
//     plausibly and only shows up by reading the getters back;
//   * File must NOT declare an instance permissionStatus (AIR only has the static
//     one, and an instance read is a compile error there);
//   * FileFilter must not grow back the invented winType/name/clone members.
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { RUNTIME_PREAMBLE } from '../../src/runtime.ts';
import { registerGroup } from '../harness.ts';

// The smallest program that drags in every member pinned below.
const PROG = `
import flash.filesystem.File;
import flash.filesystem.FileStream;
import flash.filesystem.FileMode;
import flash.filesystem.StorageVolume;
import flash.net.FileReference;
import flash.net.FileReferenceList;
import flash.net.FileFilter;
import flash.events.StorageVolumeChangeEvent;
import flash.events.FileListEvent;
import flash.utils.IDataInput;

var fs:FileStream = new FileStream();
fs.open(new File("/tmp/x"), FileMode.READ);
var n:int = fs.readInt();
fs.writeInt(n);
fs.endian = "littleEndian";
fs.objectEncoding = 0;
fs.readAhead = 4;
fs.position = 0;
var avail:uint = fs.bytesAvailable;
fs.close();

// The interface is what makes this line legal in AIR.
var input:IDataInput = fs;
var b:int = input.readByte();

var f:File = new File("/tmp/y");
var c:File = f.clone();
var rel:String = f.getRelativePath(new File("/tmp"), true);
var days:Date = f.creationDate;
var pkg:Boolean = f.isPackage;
f.url = "file:///tmp/z.txt";
var t:File = File.createTempFile();
var roots:Array = File.getRootDirectories();
var ps:String = File.permissionStatus;
var ic:Object = f.icon;
var cw:File = File.workingDirectory;
var cd:File = File.cacheDirectory;
f.copyTo(new File("/tmp/z"), true);
var par:File = f.parent;

var vol:StorageVolume = new StorageVolume(f, "n", true, false, "apfs", "/");
var ev:StorageVolumeChangeEvent = new StorageVolumeChangeEvent(StorageVolumeChangeEvent.STORAGE_VOLUME_MOUNT, false, false, f, vol);

var fr:FileReference = new FileReference();
var frl:FileReferenceList = new FileReferenceList();
var list:Array = frl.fileList;
var ff:FileFilter = new FileFilter("Text", "*.txt", "TEXT");
var isin:Boolean = fs is IDataInput;
var keys:Array = f.creationDate == null ? [] : [];
trace("" + n + b + avail + rel + days + pkg + t + roots + ev + fr + frl + list + ff + isin + keys);
`;

function checkSurface(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [filestream] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [filestream] ${label}`); }
  };

  const c = generateC(parse(PROG)).c;

  // ---- FileStream really is an IDataInput / IDataOutput ---------------------
  // The vtable slots are the proof: a class that only declares the interfaces in
  // symbols.ts but never assigns the slots links a NULL call.
  for (const slot of [
    'readBoolean', 'readByte', 'readBytes', 'readDouble', 'readFloat', 'readInt',
    'readMultiByte', 'readObject', 'readShort', 'readUnsignedByte',
    'readUnsignedInt', 'readUnsignedShort', 'readUTF', 'readUTFBytes',
    'writeBoolean', 'writeByte', 'writeBytes', 'writeDouble', 'writeFloat',
    'writeInt', 'writeMultiByte', 'writeObject', 'writeShort', 'writeUnsignedInt',
    'writeUTF', 'writeUTFBytes',
  ]) {
    check(`${slot} is wired into the FileStream vtable`,
      c.includes(`FileStream_${slot})`) || c.includes(`FileStream_${slot},`) || c.includes(`${slot} = FileStream_${slot}`));
  }

  // ---- byte order is applied exactly once ----------------------------------
  // as_fs_w16/as_fs_w32 CHOOSE the byte order themselves, so the low-level write
  // must not touch the bytes again; float/double arrive in host order and go
  // through the host-bits variant. (The bug: as_fs_write_bits reordered on top of
  // as_fs_w32 and every multi-byte read came back swapped.)
  check('the scalar writers decompose into host order themselves',
    c.includes('static void as_fs_w32(FileStream* o, unsigned v) {'));
  check('as_fs_write_raw does not reorder (the caller already did)',
    /static void as_fs_write_raw\(FileStream\* o, const unsigned char\* buf, size_t n\) \{\n  if \(!as_fs_writable\(o\)\) \{ as_fs_no_stream\(\); return; \}\n  if \(n > 0\) fwrite\(buf, 1, n, \(FILE\*\)o->_handle\);/.test(c));
  check('float/double go through the host-order variant',
    c.includes('as_fs_write_host_bits((FileStream*)_this, b, 4);')
    && c.includes('as_fs_write_host_bits((FileStream*)_this, b, 8);'));
  check('the host-order variant flips only on a real disagreement with the stream',
    c.includes('if ((as_fs_le(o) != 0) != (as_host_little() != 0)) {'));

  // ---- #2029 is the "no stream / wrong side" gate ---------------------------
  check('#2029 carries AIR\'s sentence verbatim',
    c.includes('case 2029: return "Error #2029: This URLStream object does not have a stream opened.";')
    // AIR says "URLStream" here even on FileStream -- measured, and copied verbatim.
    || c.includes('(char*)"Error #2029: This URLStream object does not have a stream opened."'));
  check('#2030 is the EOF gate',
    c.includes('as_throw_eof()') && c.includes('Error #2030: End of file was encountered.'));
  check('every read and write guards through the same two helpers',
    c.includes('static int as_fs_readable(FileStream* o)')
    && c.includes('static int as_fs_writable(FileStream* o)'));

  // ---- StorageVolume's measured argument order ------------------------------
  // (rootDirectory, name, isWritable, isRemovable, fileSystemType, drive) -- the
  // getters were read back on adl 51.4.1 to establish it.
  check('StorageVolume_ctor takes AIR\'s order, not the field order',
    c.includes('void StorageVolume_ctor(StorageVolume* o, File* rootDirectory, char* name, bool isWritable, bool isRemovable, char* fileSystemType, char* drive) {'));
  check('the ctor puts each argument in its own field',
    c.includes('o->_drive = drive;') && c.includes('o->_name = name;')
    && c.includes('o->_writable = isWritable;') && c.includes('o->_removable = isRemovable;'));

  // ---- File: only the STATIC permissionStatus ------------------------------
  check('File declares no instance permissionStatus getter',
    !c.includes('File_get_permissionStatus(void* _this)'));
  check('the static permissionStatus answers AIR\'s measured "granted"',
    c.includes('(char*)"granted"'));
  check('File.icon reports itself as unsupported rather than inventing artwork',
    c.includes('flash.filesystem.File.icon (no icon extraction in this build)'));
  check('File.workingDirectory reads the process CWD',
    c.includes('File_new(as_file_working_dir())'));

  // ---- preventBackup keeps no state (measured: reads back false) -----------
  check('File_set_preventBackup stores nothing',
    c.includes('void File_set_preventBackup(void* _this, bool value) { (void)_this; (void)value; }'));

  // ---- canonicalize resolves only what exists -------------------------------
  check('as_path_realpath gates realpath on the path existing',
    /static char\* as_path_realpath\(const char\* p\) \{[\s\S]*?if \(!as_path_exists_l\(norm\)\) return norm;[\s\S]*?realpath\(norm, NULL\)/.test(c));

  // ---- FileFilter must not grow invented members ---------------------------
  check('FileFilter has exactly the three measured members',
    c.includes('char* description;') && c.includes('char* extension;') && c.includes('char* macType;'));
  check('FileFilter has no clone() (AIR 51.4.1 rejects it)',
    !c.includes('FileFilter_clone('));
  check('FileFilter has no invented winType/name',
    !c.includes('_winType') && !c.includes('FileFilter_get_name('));

  // ---- FileReferenceList ---------------------------------------------------
  check('FileReferenceList_new allocates its own vtable',
    c.includes('FileReferenceList* FileReferenceList_new(void) {')
    && c.includes('o->vtable = &FileReferenceList_vt;'));
  check('a fresh FileReferenceList keeps fileList NULL (measured, not an empty Array)',
    c.includes('o->_fileList = NULL;') && c.includes('as_array* FileReferenceList_get_fileList(void* _this)'));
  check('fileList is read-only (no setter is emitted)',
    !c.includes('FileReferenceList_set_fileList'));
  check('browse() reports itself instead of pretending a cancelled dialog',
    c.includes('flash.net.FileReferenceList.browse (no native file dialog in this build)'));

  // ---- FileListEvent's measured 4-argument constructor ---------------------
  check('FileListEvent_new takes (type, bubbles, cancelable, files)',
    /FileListEvent\* FileListEvent_new\(char\* type, bool bubbles, bool cancelable, as_array\* files\)/.test(c));

  if (ok > 0) console.log(`[filestream] ${ok} emit checks passed`);
  return bad;
}

// The Windows half of the same batch. Stages 298/299 were measured on adl/macOS
// only, and every pin below is a place where the POSIX answer had been hard-coded
// while the Windows answer differs -- measured on adl 51.4.1 / Windows 10
// (temp/winfile/adl-win*.txt). They are source pins rather than example assertions
// because the Windows arm of each #ifdef must hold even where the suite runs
// (macOS, i.e. CI), and no example can reach a Windows-only branch from there.
function checkWindows(): string[] {
  const bad: string[] = [];
  let ok = 0;
  const count = (n: string): number => c0.split(n).length - 1;
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [filestream-win] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [filestream-win] ${label}`); }
  };
  const c0 = generateC(parse(PROG)).c;

  // ---- cacheDirectory is the TEMP directory, not a Caches folder ------------
  check('the Windows cacheDirectory is the OS temp directory',
    c0.includes('char* t = as_file_temp_dir();') && c0.includes('return (t != NULL) ? as_path_norm(t) : as_home_dir();'));
  check('the Windows cacheDirectory no longer invents a Caches folder',
    !c0.includes('as_path_join(e, "Caches")') && !c0.includes('AppData/Local/Caches'));
  check('as_file_temp_dir asks the OS instead of reading three env vars',
    c0.includes('DWORD tlen = GetTempPathA((DWORD)sizeof(tmpdir), tmpdir);'));
  check('...and refuses a buffer that is too small rather than truncating',
    c0.includes('if (tlen == 0 || tlen >= (DWORD)sizeof(tmpdir)) return NULL;'));

  // ---- drive-relative paths: kept verbatim, ONE separator appended ----------
  check('a drive-relative path with no separator is not parsed as components',
    c0.includes('int j = 2;') && c0.includes('else drive_rel = 1;'));
  check('...it is copied verbatim and closed with a separator',
    c0.includes('memcpy(out + o, src + 2, (size_t)(n - 2));'));
  check('a drive-relative first component takes no separator of its own',
    c0.includes('!(drive_rel && o == 2)'));
  check('".." cannot pop the drive of a drive-relative path',
    c0.includes('} else if (o == root_len || (o >= 2 && out[o - 1] == ' + "'" + '.' + "'"));

  // ---- parent(): the root keeps its separator ------------------------------
  check('parent of a drive-root child is the drive root itself',
    c0.includes("if (cut == 2 && s[1] == ':') { char* d = as_str_alloc(4); d[0] = s[0];"));
  check('a root-relative path keeps its leading separator in parent()',
    c0.includes('if (cut == 0) { char* d = as_str_alloc(2); d[0] = s[0];'));
  check('the separator scan reaches index 0 (a trailing separator no longer hides the root)',
    c0.includes('for (int i = n - 1; i >= 0; i--) if (s[i] =='));

  // ---- getRelativePath: separator-aware, forward slashes, root-gated --------
  check('getRelativePath splits on BOTH separators',
    c0.includes('while (*pa ==' + " '" + '/' + "'" + ' || *pa =='));
  check('...and answers null across two different roots',
    c0.includes('roa = as_path_root_len(a);')
    && c0.includes('if (roa != rob || strncmp(a, b, roa) != 0) return NULL;')
    && c0.includes('pb = b + rob;'));
  check('...and joins the answer with forward slashes on every host',
    c0.includes("? '/' : rest[i];"));

  // ---- a case-only difference is the SAME file ----------------------------
  check('copyTo/moveTo judge sameness through as_path_under (case-insensitive on Windows)',
    count('as_path_under(dst, src)') === 2 && count('return 3014;') === 2 && !c0.includes('strcmp(dst, src) == 0'));

  // ---- FileStream: 64-bit offsets and APPEND at EOF ------------------------
  check('stream offsets go through one 64-bit pair',
    c0.includes('static long long as_fs_tell(FILE* f) {')
    && c0.includes('static int as_fs_seek(FILE* f, long long pos, int whence) {'));
  check('the Windows arm is the UCRT 64-bit form',
    c0.includes('return (long long)_ftelli64(f);') && c0.includes('return _fseeki64(f, pos, whence);'));
  check('no 32-bit ftell is left in the position/truncate family',
    !c0.includes('p = ftell((FILE*)o->_handle);') && !c0.includes('pos = ftell((FILE*)o->_handle);'));
  check('bytesAvailable is a 64-bit subtraction',
    c0.includes('static long long as_fs_avail(FileStream* o) {') && c0.includes('  long long cur, end;'));
  check('APPEND opens at EOF, not at 0',
    c0.includes('if (mc == 3) as_fs_seek(f, 0, SEEK_END);'));

  // ---- the async opener has the same two rules ----------------------------
  check('openAsync also starts APPEND at EOF',
    RUNTIME_PREAMBLE.includes("if (mode[0] == 'a') fseek((FILE*)h, 0, SEEK_END);"));
  check('openAsync measures the size with the 64-bit form on Windows',
    RUNTIME_PREAMBLE.includes('__int64 cur = _ftelli64((FILE*)h);'));

  if (ok > 0) console.log(`[filestream-win] ${ok} emit checks passed`);
  return bad;
}

registerGroup('unit: file-stream/contract', checkSurface);
registerGroup('unit: file-stream/windows', checkWindows);