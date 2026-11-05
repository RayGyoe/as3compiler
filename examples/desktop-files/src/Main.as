package {
import flash.display.*;
import flash.desktop.*;
import flash.events.*;
import flash.filesystem.*;
import flash.net.*;
import flash.text.*;
public class Main extends Sprite {
  private var logField:TextField = new TextField();
  private var file:File = File.documentsDirectory;
  private var reference:FileReference = new FileReference();
  private var list:FileReferenceList = new FileReferenceList();
  private var dropZone:Sprite = new Sprite();
  private var dragged:File;
  private var loadAfterSelect:Boolean = false;
  public function Main() {
    makeButton('Open', 15, openOne); makeButton('Multiple', 130, openMany);
    makeButton('Directory', 245, directory); makeButton('Save path', 360, savePath);
    makeButton('Read file', 15, readFile, 65); makeButton('Save text', 130, saveText, 65);
    makeButton('FR list', 245, referenceList, 65); makeButton('Cancel', 360, cancel, 65);
    logField.x=15;logField.y=200;logField.width=500;logField.height=270;logField.multiline=true;logField.wordWrap=true;
    logField.defaultTextFormat=new TextFormat('_sans',14,0x222222);addChild(logField);
    file.addEventListener(IOErrorEvent.IO_ERROR, failed);list.addEventListener(IOErrorEvent.IO_ERROR, failed);
    file.addEventListener(Event.SELECT, selected);file.addEventListener(Event.CANCEL, cancelled);
    file.addEventListener(FileListEvent.SELECT_MULTIPLE, selectedMany);
    reference.addEventListener(Event.SELECT, referenceSelected);reference.addEventListener(Event.CANCEL, cancelled);
    reference.addEventListener(Event.OPEN, opened);reference.addEventListener(ProgressEvent.PROGRESS, progress);
    reference.addEventListener(Event.COMPLETE, completed);reference.addEventListener(IOErrorEvent.IO_ERROR, failed);
    list.addEventListener(Event.SELECT, listSelected);list.addEventListener(Event.CANCEL, cancelled);
    dropZone.x=15;dropZone.y=115;paintDrop(0xe8eef9);addChild(dropZone);
    var hint:TextField=new TextField();hint.defaultTextFormat=new TextFormat('_sans',14,0x222222);hint.text='Drop files / text here. Drag the last file out.';hint.width=480;hint.height=50;hint.mouseEnabled=false;dropZone.addChild(hint);
    dropZone.addEventListener(NativeDragEvent.NATIVE_DRAG_ENTER,dragEnter);
    dropZone.addEventListener(NativeDragEvent.NATIVE_DRAG_OVER,dragEnter);
    dropZone.addEventListener(NativeDragEvent.NATIVE_DRAG_EXIT,dragExit);
    dropZone.addEventListener(NativeDragEvent.NATIVE_DRAG_DROP,dragDrop);
    dropZone.addEventListener(MouseEvent.MOUSE_DOWN,dragOut);
    dropZone.addEventListener(NativeDragEvent.NATIVE_DRAG_COMPLETE,dragComplete);
    write('Native dialogs and drag-and-drop supported='+NativeDragManager.isSupported);
  }
  private function paintDrop(color:uint):void {dropZone.graphics.clear();dropZone.graphics.beginFill(color);dropZone.graphics.drawRoundRect(0,0,450,65,8);dropZone.graphics.endFill();}
  private function dragEnter(e:NativeDragEvent):void {
    if(e.clipboard.hasFormat(ClipboardFormats.FILE_LIST_FORMAT)||e.clipboard.hasFormat(ClipboardFormats.TEXT_FORMAT)||e.clipboard.hasFormat(ClipboardFormats.URL_FORMAT)) {
      NativeDragManager.acceptDragDrop(dropZone);NativeDragManager.dropAction=NativeDragActions.COPY;paintDrop(0xa8d8b8);
    }
  }
  private function dragExit(e:NativeDragEvent):void {paintDrop(0xe8eef9);}
  private function dragDrop(e:NativeDragEvent):void {
    paintDrop(0xe8eef9);
    if(e.clipboard.hasFormat(ClipboardFormats.FILE_LIST_FORMAT)) {
      var files:Array=e.clipboard.getData(ClipboardFormats.FILE_LIST_FORMAT) as Array;
      for each(var f:File in files){dragged=f;write('drop '+f.nativePath);}
    } else if(e.clipboard.hasFormat(ClipboardFormats.TEXT_FORMAT))write('drop text '+e.clipboard.getData(ClipboardFormats.TEXT_FORMAT));
    else write('drop URL '+e.clipboard.getData(ClipboardFormats.URL_FORMAT));
  }
  private function dragOut(e:MouseEvent):void {
    var clip:Clipboard=new Clipboard();if(dragged!=null)clip.setData(ClipboardFormats.FILE_LIST_FORMAT,[dragged]);else clip.setData(ClipboardFormats.TEXT_FORMAT,'Hello from AS3 native drag');
    var actions:NativeDragOptions=new NativeDragOptions();actions.allowMove=false;actions.allowLink=false;
    write('drag start');NativeDragManager.doDrag(dropZone,clip,null,null,actions);
  }
  private function dragComplete(e:NativeDragEvent):void {write('drag complete '+e.dropAction);}
  private function makeButton(label:String,x:Number,fn:Function,y:Number=15):void {
    var b:Sprite=new Sprite();b.x=x;b.y=y;b.graphics.beginFill(0x2867c7);b.graphics.drawRoundRect(0,0,105,36,6);b.graphics.endFill();
    var t:TextField=new TextField();t.defaultTextFormat=new TextFormat('_sans',14,0xffffff);t.text=label;t.width=105;t.height=30;t.y=6;t.mouseEnabled=false;b.addChild(t);
    b.addEventListener(MouseEvent.CLICK,fn);addChild(b);
  }
  private function write(s:String):void { trace(s);logField.appendText(s+'\n');logField.scrollV=logField.maxScrollV; }
  private function openOne(e:Event):void {file.browseForOpen('Open a file',[new FileFilter('Text','*.txt;*.md'),new FileFilter('All files','*.*')]);write('browse returned');}
  private function openMany(e:Event):void {file.browseForOpenMultiple('Open multiple files');}
  private function directory(e:Event):void {file.browseForDirectory('Choose a directory');}
  private function savePath(e:Event):void {file.browseForSave('Choose save path (does not write)');}
  private function readFile(e:Event):void {loadAfterSelect=true;write('browse='+reference.browse());}
  private function saveText(e:Event):void {loadAfterSelect=false;reference.save('Hello from AS3 AOT — 中文\n','aot-example.txt');}
  private function referenceList(e:Event):void {write('list browse='+list.browse());}
  private function cancel(e:Event):void {file.cancel();reference.cancel();}
  private function selected(e:Event):void {write('select '+file.nativePath);}
  private function selectedMany(e:FileListEvent):void {for each(var f:File in e.files)write('multiple '+f.nativePath);}
  private function referenceSelected(e:Event):void {write('select '+reference.name+' size='+reference.size);if(loadAfterSelect)reference.load();}
  private function listSelected(e:Event):void {for each(var f:FileReference in list.fileList)write('reference '+f.name+' size='+f.size);}
  private function cancelled(e:Event):void {write('cancel');}
  private function opened(e:Event):void {write('open');}
  private function progress(e:ProgressEvent):void {write('progress '+e.bytesLoaded+'/'+e.bytesTotal);}
  private function completed(e:Event):void {write('complete '+reference.name);if(loadAfterSelect&&reference.data!=null)write(reference.data.readUTFBytes(Math.min(reference.data.length,300)));}
  private function failed(e:IOErrorEvent):void {write('ioError '+e.text);}
}}
