// Authored AIR API -> native Cocoa panels. Completion handlers only stage native
// results; AS3 events are dispatched later by the runtime's normal async pump.
#import <Cocoa/Cocoa.h>
#include "file_dialog.h"
#include <string>
#include <vector>

static NSSavePanel* asc_panel = nil;
static uint64_t asc_serial = 0;
static bool asc_ready = false;
static int asc_status = 0;
static std::vector<std::string> asc_paths;
static std::string asc_error;

@interface ASCFilePanelDelegate : NSObject <NSOpenSavePanelDelegate>
@property(nonatomic, retain) NSPopUpButton* choices;
@property(nonatomic, retain) NSArray* filterGroups;
- (void)changeFilter:(id)sender;
@end
@implementation ASCFilePanelDelegate
- (void)changeFilter:(id)sender {
  (void)sender;
  NSInteger index = self.choices.indexOfSelectedItem;
  NSArray* types = [self.filterGroups objectAtIndex:(NSUInteger)index];
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
  asc_panel.allowedFileTypes = types.count ? types : nil;
#pragma clang diagnostic pop
  asc_panel.allowsOtherFileTypes = types.count == 0;
}
- (void)dealloc { [_choices release]; [_filterGroups release]; [super dealloc]; }
@end
static ASCFilePanelDelegate* asc_delegate = nil;
static NSString* asc_string(const char* value) {
  return value ? [NSString stringWithUTF8String:value] : @"";
}
static void asc_complete(uint64_t serial, NSModalResponse response) {
  if (serial != asc_serial || asc_panel == nil) return;
  asc_paths.clear();
  asc_status = response == NSModalResponseOK ? 1 : 0;
  if (asc_status == 1) {
    NSArray* urls = [asc_panel isKindOfClass:[NSOpenPanel class]]
        ? [(NSOpenPanel*)asc_panel URLs] : (asc_panel.URL ? @[asc_panel.URL] : @[]);
    for (NSURL* url in urls) {
      const char* p = url.fileSystemRepresentation;
      if (!url.isFileURL || p == nullptr) {
        asc_paths.clear(); asc_error = "File panel returned a non-file URL"; asc_status = -1; break;
      }
      asc_paths.emplace_back(p);
    }
    if (asc_paths.empty() && asc_status == 1) { asc_status = -1; asc_error = "File panel returned no path"; }
  }
  asc_ready = true;
}
extern "C" int sk_file_dialog_begin(uint64_t serial, int mode, const char* title,
    const char* initial, const char* suggested, int filters,
    const char* const* descriptions, const char* const* extensions) {
  if (![NSThread isMainThread] || asc_panel != nil || mode < 1 || mode > 4) return 0;
  @autoreleasepool {
    [NSApplication sharedApplication];
    asc_serial = serial; asc_ready = false; asc_paths.clear(); asc_error.clear();
    asc_panel = [(mode == 4 ? [NSSavePanel savePanel] : [NSOpenPanel openPanel]) retain];
    asc_panel.title = asc_string(title);
    asc_panel.canCreateDirectories = YES;
    if (mode != 4) {
      NSOpenPanel* p = (NSOpenPanel*)asc_panel;
      p.canChooseDirectories = mode == 3; p.canChooseFiles = mode != 3;
      p.allowsMultipleSelection = mode == 2;
      p.resolvesAliases = YES;
    }
    if (initial && *initial) {
      NSString* path = asc_string(initial);
      BOOL directory = NO;
      BOOL exists = [[NSFileManager defaultManager] fileExistsAtPath:path isDirectory:&directory];
      if (exists && directory) asc_panel.directoryURL = [NSURL fileURLWithPath:path isDirectory:YES];
      else {
        asc_panel.directoryURL = [NSURL fileURLWithPath:[path stringByDeletingLastPathComponent] isDirectory:YES];
        if (mode == 4) asc_panel.nameFieldStringValue = path.lastPathComponent;
      }
    }
    if (suggested && *suggested) asc_panel.nameFieldStringValue = asc_string(suggested);
    if (filters > 0 && mode != 3) {
      asc_delegate = [[ASCFilePanelDelegate alloc] init];
      NSMutableArray* groups = [NSMutableArray array];
      NSPopUpButton* popup = [[[NSPopUpButton alloc] initWithFrame:NSMakeRect(0, 0, 280, 26) pullsDown:NO] autorelease];
      for (int i = 0; i < filters; i++) {
        NSMutableArray* types = [NSMutableArray array];
        BOOL all = NO;
        for (NSString* item in [asc_string(extensions[i]) componentsSeparatedByString:@";"]) {
          NSString* part = [item stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
          if ([part isEqualToString:@"*"] || [part isEqualToString:@"*.*"]) { all = YES; break; }
          if ([part hasPrefix:@"*."]) part = [part substringFromIndex:2];
          if (part.length) [types addObject:part];
        }
        [groups addObject:all ? @[] : types];
        // AppKit deduplicates equal popup titles; make them distinct by index.
        [popup addItemWithTitle:[NSString stringWithFormat:@"%d. %@", i + 1, asc_string(descriptions[i])]];
      }
      asc_delegate.choices = popup; asc_delegate.filterGroups = groups;
      popup.target = asc_delegate; popup.action = @selector(changeFilter:);
      asc_panel.accessoryView = popup; asc_panel.delegate = asc_delegate;
      [asc_delegate changeFilter:popup];
    }
    NSWindow* owner = NSApp.keyWindow ?: NSApp.mainWindow;
    void (^done)(NSModalResponse) = ^(NSModalResponse response) { asc_complete(serial, response); };
    if (owner && owner.visible && owner != asc_panel) [asc_panel beginSheetModalForWindow:owner completionHandler:done];
    else [asc_panel beginWithCompletionHandler:done];
    return 1;
  }
}
extern "C" void sk_file_dialog_cancel(uint64_t serial) {
  if (asc_panel && serial == asc_serial && !asc_ready) [asc_panel cancel:nil];
}
extern "C" int sk_file_dialog_poll(uint64_t* serial, int* status, int* count) {
  if (!asc_ready) return 0;
  *serial = asc_serial; *status = asc_status; *count = (int)asc_paths.size(); return 1;
}
extern "C" const char* sk_file_dialog_path(int i) {
  return i >= 0 && (size_t)i < asc_paths.size() ? asc_paths[(size_t)i].c_str() : nullptr;
}
extern "C" const char* sk_file_dialog_error(void) { return asc_error.c_str(); }
extern "C" void sk_file_dialog_release(void) {
  asc_panel.delegate = nil; asc_panel.accessoryView = nil;
  [asc_panel release]; asc_panel = nil;
  [asc_delegate release]; asc_delegate = nil;
  asc_ready = false; asc_serial = 0; asc_paths.clear(); asc_error.clear();
}
