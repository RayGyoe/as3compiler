#import <Cocoa/Cocoa.h>
#import <objc/runtime.h>
#include "native_drag.h"
#include <cassert>
#include <cstring>
#include <cstdio>
static int calls=0;
static int receive(int w,int phase,uint64_t serial,double x,double y,int mask,int mod,const sk_drag_data* d){
 (void)mod;if(phase==3&&serial==0)return 0;
 assert(w==0&&serial==99&&x==50&&y==40&&mask==7);
 assert(d&&d->file_count==2&&!strcmp(d->files[0],"/tmp/中文 # %.txt")&&!strcmp(d->files[1],"/tmp/second.txt"));
 assert(!strcmp(d->text,"hello 中文")&&!strcmp(d->url,"https://example.org/"));
 calls++;return phase==3?0:1;
}
@interface ProbeDrag:NSObject { @public NSPasteboard* pasteboard; }
@end
@implementation ProbeDrag
-(NSPasteboard*)draggingPasteboard{return pasteboard;}
-(NSPoint)draggingLocation{return NSMakePoint(50,160);}
-(NSInteger)draggingSequenceNumber{return 99;}
-(NSDragOperation)draggingSourceOperationMask{return NSDragOperationCopy|NSDragOperationMove|NSDragOperationLink;}
-(id)draggingSource{return nil;}
@end
int main(){@autoreleasepool {
 [NSApplication sharedApplication];
 NSWindow* window=[[[NSWindow alloc] initWithContentRect:NSMakeRect(0,0,300,200) styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO] autorelease];
 NSView* view=window.contentView;Class before=object_getClass(view);
 sk_drag_init(receive);assert(sk_drag_attach(0,window));assert(sk_drag_attach(0,window));assert(object_getClass(view)!=before);
 NSPasteboard* pb=[NSPasteboard pasteboardWithUniqueName];
 NSPasteboardItem* a=[[[NSPasteboardItem alloc] init] autorelease];
 [a setString:[NSURL fileURLWithPath:@"/tmp/中文 # %.txt"].absoluteString forType:NSPasteboardTypeFileURL];
 [a setString:@"hello 中文" forType:NSPasteboardTypeString];[a setString:@"https://example.org/" forType:NSPasteboardTypeURL];
 NSPasteboardItem* b=[[[NSPasteboardItem alloc] init] autorelease];[b setString:[NSURL fileURLWithPath:@"/tmp/second.txt"].absoluteString forType:NSPasteboardTypeFileURL];[pb writeObjects:@[a,b]];
 ProbeDrag* info=[[[ProbeDrag alloc] init] autorelease];info->pasteboard=pb;
 assert([view draggingEntered:(id<NSDraggingInfo>)info]==NSDragOperationCopy);
 assert([view draggingUpdated:(id<NSDraggingInfo>)info]==NSDragOperationCopy);
 assert([view prepareForDragOperation:(id<NSDraggingInfo>)info]);assert([view performDragOperation:(id<NSDraggingInfo>)info]);
 [view draggingExited:(id<NSDraggingInfo>)info];assert(calls==5);
 sk_drag_detach(0);assert(object_getClass(view)==before);[pb releaseGlobally];puts("Cocoa drag bridge: OK");
}}
