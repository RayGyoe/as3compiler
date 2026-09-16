// Stage 41: desktop AIR stage properties (size/quality/color/align/scaleMode/
// frameRate/displayState) and the four constant classes. This example is
// offscreen (render writes a PNG and returns) so it runs in the regression
// suite without opening a window.
var stage:Stage = new Stage();

// --- defaults (AIR: white, HIGH, TOP_LEFT, SHOW_ALL, NORMAL) ---
trace("defaults", stage.stageWidth, stage.stageHeight, stage.color, stage.quality, stage.align, stage.scaleMode, stage.displayState);

// --- constant classes (pure static String constants) ---
trace("const", StageAlign.TOP, StageAlign.BOTTOM_RIGHT, StageScaleMode.EXACT_FIT, StageScaleMode.NO_SCALE, StageQuality.BEST, StageDisplayState.FULL_SCREEN);

// --- setters + read-back ---
stage.quality = StageQuality.HIGH;
stage.color = 0x112233;
stage.align = StageAlign.TOP_LEFT;
stage.scaleMode = StageScaleMode.NO_SCALE;
stage.displayState = StageDisplayState.NORMAL;
trace("set", stage.quality, stage.color, stage.align, stage.scaleMode, stage.displayState);

// --- boolean switches ---
trace("bool", stage.stageFocusRect, stage.showDefaultContextMenu, stage.tabChildren, stage.allowsFullScreen, stage.allowsFullScreenInteractive, stage.contentsScaleFactor);
stage.stageFocusRect = true;
stage.showDefaultContextMenu = false;
stage.tabChildren = false;
trace("bool-set", stage.stageFocusRect, stage.showDefaultContextMenu, stage.tabChildren);

// --- frameRate ---
stage.frameRate = 30;
trace("frameRate", stage.frameRate);

// --- render writes stageWidth/Height and uses stage.color as background ---
stage.render(320, 240, "stage41.png");
trace("size", stage.stageWidth, stage.stageHeight);

// --- display size (0 without a window backend; populated under ASC_USE_WINDOW) ---
trace("display", stage.fullScreenWidth, stage.fullScreenHeight);
