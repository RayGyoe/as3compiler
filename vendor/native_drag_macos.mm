// SDL retains ownership of its view/delegate. Only drag selectors are overridden
// on a per-instance subclass; input, IME, rendering and resize keep SDL's methods.
#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#include "native_drag.h"
#include <string>
#include <vector>
#include <cstring>

static sk_drag_callback callback;
struct Slot { NSWindow* window; NSView* view; Class original; Class patched; NSEvent* gesture; };
static Slot slots[16];
static int effects(NSDragOperation o) { return ((o & NSDragOperationCopy)?1:0)|((o & NSDragOperationMove)?2:0)|((o & NSDragOperationLink)?4:0); }
static NSDragOperation operation(int o) { return (NSDragOperation)(((o&1)?NSDragOperationCopy:0)|((o&2)?NSDragOperationMove:0)|((o&4)?NSDragOperationLink:0)); }
static int modifiers(void) { NSUInteger m=NSEvent.modifierFlags;return ((m&NSEventModifierFlagControl)?1:0)|((m&NSEventModifierFlagOption)?2:0)|((m&NSEventModifierFlagShift)?4:0)|((m&NSEventModifierFlagCommand)?8:0); }
static int findView(id view) { for(int i=0;i<16;i++) if(slots[i].view==view)return i;return -1; }
static NSPoint point(NSView* view, NSPoint windowPoint) { NSPoint p=[view convertPoint:windowPoint fromView:nil];if(!view.isFlipped)p.y=view.bounds.size.height-p.y;return p; }
@interface ASCDragSource : NSObject<NSDraggingSource> {
@public int window; uint64_t serial; int allowed;
}
@end
static ASCDragSource* source;
static int destination(id view, id<NSDraggingInfo> info, int phase) {
  int w=findView(view);if(w<0||!callback)return 0;
  @autoreleasepool {
    NSPasteboard* pb=info.draggingPasteboard;
    NSArray* urls=[pb readObjectsForClasses:@[NSURL.class] options:@{NSPasteboardURLReadingFileURLsOnlyKey:@YES}];
    std::vector<std::string> paths;for(NSURL* u in urls) if(u.fileURL && u.path)paths.emplace_back(u.path.fileSystemRepresentation);
    std::vector<const char*> pointers;for(auto& p:paths)pointers.push_back(p.c_str());
    NSString* text=[pb stringForType:NSPasteboardTypeString];NSString* url=[pb stringForType:NSPasteboardTypeURL];
    sk_drag_data d={(int)pointers.size(),pointers.data(),text.UTF8String,url.UTF8String,source && info.draggingSource==source};
    NSPoint p=point(view,info.draggingLocation);
    return callback(w,phase,(uint64_t)info.draggingSequenceNumber,p.x,p.y,effects(info.draggingSourceOperationMask),modifiers(),&d);
  }
}
static void mouseGesture(id view,SEL sel,NSEvent* event) {
  int w=findView(view);if(w<0)return;
  [event retain];[slots[w].gesture release];slots[w].gesture=event;
  IMP original=class_getMethodImplementation(slots[w].original,sel);
  ((void(*)(id,SEL,NSEvent*))original)(view,sel,event);
}
static NSDragOperation entered(id view,SEL sel,id<NSDraggingInfo> info) { (void)sel;return operation(destination(view,info,1)); }
static NSDragOperation updated(id view,SEL sel,id<NSDraggingInfo> info) { (void)sel;return operation(destination(view,info,2)); }
static void exited(id view,SEL sel,id<NSDraggingInfo> info) { (void)sel;destination(view,info,3); }
static BOOL prepare(id view,SEL sel,id<NSDraggingInfo> info) { (void)sel;return destination(view,info,2)!=0; }
static BOOL perform(id view,SEL sel,id<NSDraggingInfo> info) { (void)sel;return destination(view,info,4)!=0; }
static void conclude(id view,SEL sel,id<NSDraggingInfo> info) { (void)view;(void)sel;(void)info; }
static BOOL periodic(id view,SEL sel) { (void)view;(void)sel;return YES; }
@implementation ASCDragSource
-(NSDragOperation)draggingSession:(NSDraggingSession*)session sourceOperationMaskForDraggingContext:(NSDraggingContext)context { (void)session;(void)context;return operation(allowed); }
-(void)draggingSession:(NSDraggingSession*)session movedToPoint:(NSPoint)screen {
  (void)session;if(window<0||window>=16||!slots[window].view||!callback)return;
  NSPoint p=point(slots[window].view,[slots[window].window convertPointFromScreen:screen]);
  callback(window,5,serial,p.x,p.y,allowed,modifiers(),NULL);
}
-(void)draggingSession:(NSDraggingSession*)session endedAtPoint:(NSPoint)screen operation:(NSDragOperation)op {
  (void)session;NSPoint p=screen;
  if(window>=0&&window<16&&slots[window].view) p=point(slots[window].view,[slots[window].window convertPointFromScreen:screen]);
  if(callback)callback(window,6,serial,p.x,p.y,effects(op),modifiers(),NULL);
  source=nil;[self release];
}
@end
extern "C" void sk_drag_init(sk_drag_callback cb) { callback=cb; }
extern "C" int sk_drag_supported(void) { return 1; }
extern "C" int sk_drag_attach(int w,void* handle) {
  if(w<0||w>=16||!handle||!NSThread.isMainThread)return 0;
  NSWindow* window=(NSWindow*)handle;NSView* view=window.contentView;
  if(!view)return 0;if(slots[w].view==view)return 1;
  sk_drag_detach(w);
  Class original=object_getClass(view);std::string name=std::string("ASCNativeDrag_")+class_getName(original);
  Class patched=objc_getClass(name.c_str());
  if(!patched) {
    patched=objc_allocateClassPair(original,name.c_str(),0);
    class_addMethod(patched,@selector(draggingEntered:),(IMP)entered,"Q@:@");
    class_addMethod(patched,@selector(draggingUpdated:),(IMP)updated,"Q@:@");
    class_addMethod(patched,@selector(draggingExited:),(IMP)exited,"v@:@");
    class_addMethod(patched,@selector(prepareForDragOperation:),(IMP)prepare,"B@:@");
    class_addMethod(patched,@selector(performDragOperation:),(IMP)perform,"B@:@");
    class_addMethod(patched,@selector(concludeDragOperation:),(IMP)conclude,"v@:@");
    class_addMethod(patched,@selector(wantsPeriodicDraggingUpdates),(IMP)periodic,"B@:");
    class_addMethod(patched,@selector(mouseDown:),(IMP)mouseGesture,"v@:@");
    class_addMethod(patched,@selector(mouseDragged:),(IMP)mouseGesture,"v@:@");
    objc_registerClassPair(patched);
  }
  slots[w]={window,view,original,patched,nil};object_setClass(view,patched);
  [view registerForDraggedTypes:@[NSPasteboardTypeFileURL,NSPasteboardTypeString,NSPasteboardTypeURL]];
  return 1;
}
extern "C" void sk_drag_detach(int w) {
  if(w<0||w>=16||!slots[w].view)return;
  // Revoke acceptance while the AS3 window and its Stage still exist.
  if(callback)callback(w,3,0,0,0,0,0,NULL);
  if(source && source->window==w) { if(callback)callback(w,6,source->serial,0,0,0,0,NULL);source->window=-1; }
  NSView* view=slots[w].view;
  [view unregisterDraggedTypes];if(object_getClass(view)==slots[w].patched)object_setClass(view,slots[w].original);
  [slots[w].gesture release];slots[w]={};
}
extern "C" int sk_drag_begin(int w,uint64_t serial,const sk_drag_data* d,int allowed,const unsigned char* rgba,int width,int height,double dw,double dh,double ox,double oy) {
  if(!NSThread.isMainThread||w<0||w>=16||!slots[w].view||!d||source)return 0;
  NSEvent* event=slots[w].gesture;
  if(!event || (event.type!=NSEventTypeLeftMouseDown && event.type!=NSEventTypeLeftMouseDragged))return 0;
  @autoreleasepool {
    NSMutableArray* items=[NSMutableArray array];
    int n=d->file_count>0?d->file_count:1;
    NSImage* image=nil;
    if(rgba&&width>0&&height>0) {
      NSBitmapImageRep* rep=[[[NSBitmapImageRep alloc] initWithBitmapDataPlanes:NULL pixelsWide:width pixelsHigh:height bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO colorSpaceName:NSDeviceRGBColorSpace bitmapFormat:NSBitmapFormatAlphaNonpremultiplied bytesPerRow:width*4 bitsPerPixel:32] autorelease];
      if(!rep)return 0;memcpy(rep.bitmapData,rgba,(size_t)width*height*4);
      image=[[[NSImage alloc] initWithSize:NSMakeSize(dw,dh)] autorelease];[image addRepresentation:rep];
    } else { image=[[[NSImage alloc] initWithSize:NSMakeSize(1,1)] autorelease];dw=dh=1; }
    NSPoint at=[slots[w].view convertPoint:event.locationInWindow fromView:nil];
    for(int i=0;i<n;i++) {
      NSPasteboardItem* pb=[[[NSPasteboardItem alloc] init] autorelease];
      if(d->file_count) {
        NSString* path=[[NSFileManager defaultManager] stringWithFileSystemRepresentation:d->files[i] length:strlen(d->files[i])];
        if(!path)return 0;[pb setString:[NSURL fileURLWithPath:path].absoluteString forType:NSPasteboardTypeFileURL];
      }
      if(i==0&&d->text)[pb setString:[NSString stringWithUTF8String:d->text] forType:NSPasteboardTypeString];
      if(i==0&&d->url)[pb setString:[NSString stringWithUTF8String:d->url] forType:NSPasteboardTypeURL];
      NSDraggingItem* item=[[[NSDraggingItem alloc] initWithPasteboardWriter:pb] autorelease];
      [item setDraggingFrame:NSMakeRect(at.x+ox,slots[w].view.isFlipped?at.y+oy:at.y-oy-dh,dw,dh) contents:image];
      [items addObject:item];
    }
    source=[[ASCDragSource alloc] init];source->window=w;source->serial=serial;source->allowed=allowed;
    NSDraggingSession* session=[slots[w].view beginDraggingSessionWithItems:items event:event source:source];
    if(!session){[source release];source=nil;return 0;}session.animatesToStartingPositionsOnCancelOrFail=YES;
    return 1;
  }
}
