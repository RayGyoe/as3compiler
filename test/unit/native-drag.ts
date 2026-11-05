import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { root } from '../harness.ts';

const dir=join(root,'temp','native-drag-tests');mkdirSync(dir,{recursive:true});
function run(source:string) {
  let c=generateC(parse(source)).c;
  assert(c.includes('return 1234567;'));
  c=c.replace('return 1234567;', `
    ASCWin* w=ASC_w(0); w->stage=s;w->cx=2;w->cy=2;w->ox=10;w->oy=20;
    const char* paths[]={"/tmp/中文 # %.txt","/tmp/second.txt"};
    sk_drag_data data={2,paths,"hello 中文","https://example.org/",0};
    if(p==10) return as_disp_depth;
    if(p==7) { as_nd_mouse_depth=1;as_nd_mouse_window=0;return 0; }
    if(p==8) { return as_native_drag_callback(0,6,as_nd_source_serial,x,y,mask,0,NULL); }
    return as_native_drag_callback(0,p,42,x,y,mask,15,&data);`);
  // Injectable synchronous native ABI: the source is completed explicitly by the test.
  c=c.replace('int main(void) {', `
void sk_drag_init(sk_drag_callback cb) { (void)cb; }
int sk_drag_supported(void) { return 1; }
int sk_drag_begin(int w,uint64_t serial,const sk_drag_data* d,int a,const unsigned char* rgba,int width,int height,double dw,double dh,double ox,double oy) {
 (void)w;(void)serial;(void)a;(void)rgba;(void)width;(void)height;(void)dw;(void)dh;(void)ox;(void)oy;
 return d && d->text && !strcmp(d->text,"outgoing");
}
int main(void) {`);
  const file=join(dir,'state.c'),exe=join(dir,'state');writeFileSync(file,c);
  const build=spawnSync('cc',[file,'-DASC_USE_NATIVE_DRAG=1','-O2','-lm','-lz',...(process.platform==='darwin'?['-liconv','-framework','CoreFoundation']:[]),'-o',exe],{encoding:'utf8',timeout:60000});
  assert.equal(build.status,0,build.stderr);assert(!/warning:/.test(build.stderr),build.stderr);
  const out=spawnSync(exe,[],{encoding:'utf8',timeout:30000});assert.equal(out.status,0,out.stdout+out.stderr);return out;
}
test('unit: desktop/native drag acceptance, coordinates, clipboard, lifetime and source',()=> {
  const out=run(`
function check(v:Boolean,m:String):void {if(!v)throw new Error(m);}
function inject(s:Stage,p:int,x:Number,y:Number,mask:int=1):int {return 1234567;}
var root:Stage=new Stage();var target:Sprite=new Sprite();target.x=20;target.y=10;
target.graphics.beginFill(0);target.graphics.drawRect(0,0,100,100);target.graphics.endFill();root.addChild(target);
var chosen:String='copy';var enters:int=0,overs:int=0,drops:int=0,exits:int=0;var accept:Boolean=false;var cancelOver:Boolean=false;var remove:Boolean=false;var boom:Boolean=false;
var clip:Clipboard;var metadata:Boolean=false;
target.addEventListener(NativeDragEvent.NATIVE_DRAG_ENTER,function(e:NativeDragEvent):void {
 enters++;check(e.bubbles && !e.cancelable && e.clipboard.hasFormat(ClipboardFormats.FILE_LIST_FORMAT),'enter contract');
 check(e.localX==5 && e.localY==5 && e.stageX==25 && e.stageY==15,'local coordinates');
 check(e.controlKey && e.commandKey && e.shiftKey && e.altKey,'modifiers');
 clip=e.clipboard;try {clip.getData('fileList');}catch(err:SecurityError){metadata=true;}
 if(accept)NativeDragManager.acceptDragDrop(target);
});
target.addEventListener(NativeDragEvent.NATIVE_DRAG_OVER,function(e:NativeDragEvent):void {
 overs++;if(boom)throw new Error('listener failure');
 if(accept)NativeDragManager.acceptDragDrop(target);
 NativeDragManager.dropAction=chosen;if(cancelOver)e.preventDefault();
 if(remove && target.parent!=null)root.removeChild(target);System.gc();
});
target.addEventListener(NativeDragEvent.NATIVE_DRAG_EXIT,function(e:NativeDragEvent):void {exits++;});
target.addEventListener(NativeDragEvent.NATIVE_DRAG_DROP,function(e:NativeDragEvent):void {
 drops++;check(e.cancelable && NativeDragManager.dragInitiator==null,'external source');
 var files:Array=e.clipboard.getData('fileList') as Array;
 check(files.length==2 && files[0] is File && File(files[0]).nativePath=='/tmp/中文 # %.txt','unicode file list');
 check(e.clipboard.getData('text')=='hello 中文','text');
 check(e.clipboard.getData('url')=='https://example.org/','url');
});
check(NativeDragManager.isSupported,'backend capability');
check(inject(root,1,60,50)==0 && enters==1 && metadata,'unaccepted drag');
check(inject(root,4,60,50)==0 && drops==0,'unaccepted no drop');
check(inject(root,4,60,50)==0 && enters==1,'late drop cannot revive session');
accept=true;check(inject(root,1,60,50)==1,'accepted copy');
check(inject(root,4,60,50)==1 && drops==1,'accepted drop');
var expired:Boolean=false;try{clip.formats;}catch(err:SecurityError){expired=true;}check(expired,'expired clipboard');
check(inject(root,1,60,50,2)==0,'disallowed copy');inject(root,3,60,50);
chosen='move';check(inject(root,1,60,50,2)==2,'move negotiated');inject(root,3,60,50);
chosen='link';check(inject(root,1,60,50,4)==4,'link negotiated');inject(root,3,60,50);chosen='copy';
cancelOver=true;check(inject(root,1,60,50)==0,'cancel over');inject(root,3,60,50);cancelOver=false;
remove=true;check(inject(root,1,60,50)==0,'removed target');inject(root,3,60,50);remove=false;root.addChild(target);
boom=true;check(inject(root,1,60,50)==0 && !NativeDragManager.isDragging,'exception rejected and cleaned');boom=false;
check(inject(root,1,60,50)==1,'recovered after exception');check(inject(root,2,900,900)==0,'leave accepting subtree');inject(root,3,900,900);
var outgoing:Clipboard=new Clipboard();outgoing.setData('text','outgoing');var starts:int=0,ends:int=0;
target.addEventListener(NativeDragEvent.NATIVE_DRAG_START,function(e:NativeDragEvent):void {starts++;check(e.clipboard.getData('text')=='outgoing','local read');});
target.addEventListener(NativeDragEvent.NATIVE_DRAG_COMPLETE,function(e:NativeDragEvent):void {ends++;check(e.dropAction=='copy','completion action');});
inject(root,7,0,0);NativeDragManager.doDrag(target,outgoing);
check(starts==1 && NativeDragManager.isDragging && NativeDragManager.dragInitiator===target,'source start');System.gc();
inject(root,8,0,0);check(ends==1 && !NativeDragManager.isDragging && NativeDragManager.dragInitiator==null,'source cleanup');
var invalid:Clipboard=new Clipboard();invalid.setData('fileList',[5]);var rejected:Boolean=false;
try{NativeDragManager.doDrag(target,invalid);}catch(err:TypeError){rejected=true;}
check(rejected && !NativeDragManager.isDragging,'bad source payload cleaned');
check(invalid.hasFormat('fileList'),'validation failure preserves regular clipboard');
var second:Clipboard=new Clipboard();second.setData('text','outgoing');
target.addEventListener(NativeDragEvent.NATIVE_DRAG_COMPLETE,function(e:NativeDragEvent):void {throw new Error('complete failed');});
NativeDragManager.doDrag(target,second);inject(root,8,0,0);
check(!NativeDragManager.isDragging && NativeDragManager.dragInitiator==null,'complete exception cleaned');
var third:Clipboard=new Clipboard();third.setData('text','outgoing');
target.addEventListener(NativeDragEvent.NATIVE_DRAG_START,function(e:NativeDragEvent):void {throw new Error('start failed');});
var startFailed:Boolean=false;try{NativeDragManager.doDrag(target,third);}catch(err:Error){startFailed=true;}
check(startFailed && !NativeDragManager.isDragging && inject(root,10,0,0)==0,'start exception cleans dispatch state');
trace('native-drag: OK');
`);
  assert.match(out.stdout,/native-drag: OK/);
});
