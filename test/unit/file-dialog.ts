import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { defaultBuildConfig, buildCompileSteps, effectiveDefines, objectDir, withNativeDesktopBackends } from '../../src/build.ts';
import { root } from '../harness.ts';

const dir = join(root, 'temp', 'file-dialog-tests');
mkdirSync(dir, { recursive: true });
const pathA = join(dir, '中文 # fixture.txt'), pathB = join(dir, 'other.txt');
const savedText = join(dir, 'saved-text.txt'), savedBytes = join(dir, 'saved-bytes.bin');
writeFileSync(pathA, 'hello 中文\n'); writeFileSync(pathB, 'second');
function run(name: string, source: string, native: boolean) {
  const c = join(dir, `${name}.c`), exe = join(dir, name);
  writeFileSync(c, generateC(parse(source)).c);
  const backend = join(dir, 'backend.c');
  if (native) writeFileSync(backend, `
#include <stdint.h>
#include <string.h>
#include <stdlib.h>
static uint64_t identity;
static int ready, status, count, active;
static const char* paths[2];
int sk_file_dialog_begin(uint64_t serial, int mode, const char* title, const char* initial, const char* name, int filters, const char* const* descriptions, const char* const* extensions) {
  (void)initial;
  if (active) abort();
  active=1;identity=serial;ready=1;status=1;count=1;paths[0]=${JSON.stringify(pathA)};
  if (filters && (!descriptions[0] || strcmp(extensions[0],"*.txt;*.md"))) abort();
  if (mode==2) {count=2;paths[1]=${JSON.stringify(pathB)};}
  if (mode==3) paths[0]=${JSON.stringify(dir)};
  if (mode==4) paths[0]=(name && !strcmp(name,"bytes.bin")) ? ${JSON.stringify(savedBytes)} : ${JSON.stringify(savedText)};
  if (title && !strcmp(title,"cancel")) {status=0;count=0;}
  if (title && !strcmp(title,"error")) {status=-1;count=0;}
  return 1;
}
void sk_file_dialog_cancel(uint64_t serial) { if(serial==identity) {status=0;count=0;} }
int sk_file_dialog_poll(uint64_t* serial,int* result,int* n) {if(!ready)return 0;*serial=identity;*result=status;*n=count;return 1;}
const char* sk_file_dialog_path(int i) {return paths[i];}
const char* sk_file_dialog_error(void) {return "injected native failure";}
void sk_file_dialog_release(void) {ready=0;active=0;}
`);
  const args = [c, '-O2', '-lm', '-lz', ...(process.platform === 'darwin' ? ['-liconv', '-framework', 'CoreFoundation'] : []), ...(native ? ['-DASC_USE_FILE_DIALOG=1', backend] : []), '-o', exe];
  const build = spawnSync('cc', args, { encoding: 'utf8', timeout: 60000 });
  assert.equal(build.status, 0, build.stderr);
  assert(!/warning:/.test(build.stderr), build.stderr);
  const out = spawnSync(exe, [], { encoding: 'utf8', timeout: 30000 });
  assert.equal(out.status, 0, out.stdout + out.stderr);
  return out;
}

test('unit: desktop/NativeDrag AIR type and constructor contract', () => {
  const out = run('drag-contract', `
function check(v:Boolean,m:String):void { if(!v) throw new Error(m); }
var options:NativeDragOptions=new NativeDragOptions();
check(options.allowCopy && options.allowMove && options.allowLink,"actions default true");
var e:NativeDragEvent=new NativeDragEvent("probe");
check(e is MouseEvent && e is Event,"event inheritance");
check(e.cancelable && !e.bubbles && isNaN(e.localX) && isNaN(e.localY) && isNaN(e.stageX),"defaults");
var clip:Clipboard=new Clipboard();var obj:Sprite=new Sprite();
e=new NativeDragEvent("probe",true,false,12,34,obj,clip,options,NativeDragActions.COPY,true,true,true,true);
var copy:NativeDragEvent=e.clone() as NativeDragEvent;
check(copy!=null && copy!=e && copy.localX==12 && copy.localY==34 && copy.clipboard===clip && copy.allowedActions===options,"clone fields");
check(copy.dropAction=="copy" && copy.relatedObject===obj && copy.commandKey && copy.controlKey && copy.shiftKey && copy.altKey,"clone modifiers");
check(NativeDragEvent.NATIVE_DRAG_OVER=="nativeDragOver" && NativeDragActions.NONE=="none","native constants");
check(!NativeDragManager.isSupported,"no drag backend advertised yet");
trace("drag-contract: OK");
`, false);
  assert.match(out.stdout, /drag-contract: OK/);
});

test('unit: desktop/file dialog state, events, GC roots, cancellation and IO', () => {
  const out = run('dialog-state', `
function check(v:Boolean,m:String):void { if(!v) throw new Error(m); }
var selects:int=0,cancels:int=0,completes:int=0,errors:int=0,multiples:int=0;
var f:File=new File(${JSON.stringify(pathB)});
f.addEventListener(Event.SELECT,function(e:Event):void {selects++;});
f.addEventListener(Event.CANCEL,function(e:Event):void {cancels++;});
f.addEventListener(IOErrorEvent.IO_ERROR,function(e:IOErrorEvent):void {errors++;});
f.addEventListener(FileListEvent.SELECT_MULTIPLE,function(e:FileListEvent):void {
  multiples++;check(e.files.length==2 && e.files[0] is File,"File list types");
  check(e.files[1].nativePath==${JSON.stringify(pathB)},"File list paths");
});
var invalid:Boolean=false;try{f.browseForOpen("invalid",[null]);}catch(filterError:ArgumentError){invalid=filterError.errorID==2097;}check(invalid,"AIR invalid filter error");
f.browseForOpen("open",[new FileFilter("Text","*.txt;*.md")]);
check(selects==0,"selection is asynchronous"); System.gc();tickTimers();
check(selects==1 && f.nativePath==${JSON.stringify(pathA)},"single selection updates File");
f.browseForOpenMultiple("multi");tickTimers();check(multiples==1 && f.nativePath==${JSON.stringify(pathA)},"multiple does not mutate receiver");
f.browseForDirectory("directory");tickTimers();check(f.nativePath==${JSON.stringify(dir)},"directory");
f.browseForOpen("cancel");tickTimers();check(cancels==1 && f.nativePath==${JSON.stringify(dir)},"user cancellation preserves previous state");
f.browseForOpen("error");tickTimers();check(errors==1 && cancels==1,"backend error is not cancellation");
f.browseForOpen("open");var busy:Boolean=false;
try {f.browseForOpen("second");}catch(err:Error){busy=true;}
check(busy,"concurrent panel rejected");f.cancel();busy=false;try{f.browseForOpen("still busy");}catch(err3:Error){busy=err3.errorID==2041;}check(busy,"cancel does not dismiss AIR browse panel");tickTimers();check(selects==3 && cancels==1,"panel selection still arrives after cancel");
f.browseForOpen("retry");tickTimers();check(selects==4,"completed request releases native panel");
var fr:FileReference=new FileReference();var events:String="";
var choose:Boolean=true;
fr.addEventListener(Event.SELECT,function(e:Event):void {events+="select;";if(choose)fr.load();});
fr.addEventListener(Event.OPEN,function(e:Event):void {events+="open;";check(fr.data==null,"data not published before complete");});
fr.addEventListener(ProgressEvent.PROGRESS,function(e:ProgressEvent):void {events+="progress;";check(e.bytesLoaded==e.bytesTotal,"progress counts");});
fr.addEventListener(Event.COMPLETE,function(e:Event):void {events+="complete;";completes++;});
check(fr.browse(),"FR browse returns true once submitted"); System.gc();tickTimers();
check(events=="select;open;progress;complete;" && completes==1,"load event order");
check(fr.name=="中文 # fixture.txt" && fr.data.readUTFBytes(fr.data.length)=="hello 中文\\n","selected metadata and UTF-8 bytes");
var list:FileReferenceList=new FileReferenceList();var listEvents:int=0;
list.addEventListener(Event.SELECT,function(e:Event):void {listEvents++;});
check(list.fileList==null && list.browse(),"initial list and browse");tickTimers();
check(listEvents==1 && list.fileList.length==2 && list.fileList[0] is FileReference && !(list.fileList[0] is File),"FR list types");
choose=false;events="";
fr.save("snapshot 中文","text.txt");System.gc();tickTimers();
check(events=="select;open;progress;complete;","save event order");
var data:ByteArray=new ByteArray();data.writeUTFBytes("ABC");
fr.save(data,"bytes.bin");data.clear();System.gc();tickTimers();check(completes==3,"save retains payload snapshot");
var saved:File=new File(${JSON.stringify(savedBytes)});var stream:FileStream=new FileStream();stream.open(saved,FileMode.READ);check(stream.readUTFBytes(stream.bytesAvailable)=="ABC","saved bytes ignore caller mutation");stream.close();
// Completion listener can start another request without losing either GC root.
var chain:File=new File();var chained:int=0;
chain.addEventListener(Event.SELECT,function(e:Event):void {chained++;if(chained==1){chain.browseForOpen("again");System.gc();tickTimers();}});
chain.browseForOpen("start");tickTimers();tickTimers();check(chained==2,"completion reentrancy");
// A throwing listener must release its request so later panels still work.
var bad:File=new File();bad.addEventListener(Event.SELECT,function(e:Event):void {throw new Error("listener failed");});bad.browseForOpen("throw");
var caught:Boolean=false;try{tickTimers();}catch(err2:Error){caught=true;}check(caught,"listener exception preserved");
f.browseForOpen("after throw");tickTimers();check(selects==5,"exception cleanup allows another dialog");
trace("dialog-state: OK");
`, true);
  assert.match(out.stdout, /dialog-state: OK/);
  assert.equal(readFileSync(savedText, 'utf8'), 'snapshot 中文');
  assert.equal(readFileSync(savedBytes, 'utf8'), 'ABC');
});

test('unit: desktop/no backend never pretends user cancellation', () => {
  const out = run('no-dialog', `
var fr:FileReference=new FileReference();var events:int=0;fr.addEventListener(Event.CANCEL,function(e:Event):void{events++;});
if(fr.browse())throw new Error("unsupported browse succeeded");tickTimers();if(events)throw new Error("fake cancellation");
var caught:Boolean=false;try{fr.load();}catch(e:Error){caught=e.errorID==2037;}if(!caught)throw new Error("load without selection");
trace("no-dialog: OK");`, false);
  assert.match(out.stdout, /no-dialog: OK/);
  assert.match(out.stderr, /no platform backend/);
});

test('unit: desktop/dialog build keeps ICU and compile configuration identical', { skip: process.platform !== 'darwin' }, () => {
  const cfg = { ...defaultBuildConfig(), sources: [join(root, 'vendor', 'window_glue.cc')], defines: ['ASC_USE_WINDOW=1'] };
  const before = objectDir(cfg);
  assert(effectiveDefines(cfg).includes('ASC_USE_FILE_DIALOG=1'));
  const steps = buildCompileSteps(cfg, 'main.c', 'main');
  assert(steps.some(step => step.includes(join(root, 'vendor', 'file_dialog_macos.mm'))));
  assert.equal(objectDir(cfg), before);
  for (const step of steps.filter(s => s.includes('-c'))) assert(step.includes('ASC_USE_FILE_DIALOG=1'));
  assert.equal(cfg.sources.length, 1, 'build enrichment must not mutate its input');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    assert(!effectiveDefines(cfg).some(d => /^ASC_USE_(FILE_DIALOG|NATIVE_DRAG)=/.test(d)), 'Windows must stay disabled until the ACP/UTF-8 boundary is migrated');
    assert.deepEqual(withNativeDesktopBackends(cfg).sources, cfg.sources);
    const explicit = withNativeDesktopBackends({ ...cfg, defines: [...cfg.defines, 'ASC_USE_FILE_DIALOG=1', 'ASC_USE_NATIVE_DRAG=1'] });
    assert(explicit.sources.includes(join(root, 'vendor', 'file_dialog_win.cc')));
    assert(explicit.sources.includes(join(root, 'vendor', 'native_drag_win.cc')));
    assert(explicit.linkLibs.includes('ole32') && explicit.linkLibs.includes('shell32'));
  } finally { Object.defineProperty(process, 'platform', platform); }
});
