// Stage 41 (window): verifies fullScreenWidth/fullScreenHeight (queried through
// SDL) and the displayState=FULL_SCREEN path. This one opens a real window so it
// is NOT part of the automated regression — run it manually with the window
// manifest.
//
//   node src/index.ts examples/stage41_window.as \
//     --manifest examples/window.build.example.json \
//     -o examples/stage41_window --run

var stage:Stage = new Stage();

// Display size is queried lazily (SDL is initialized just long enough to read
// the primary display mode), so this works before showWindow too.
trace("fullScreenWidth", stage.fullScreenWidth, "fullScreenHeight", stage.fullScreenHeight);

stage.color = 0x224466;
stage.displayState = StageDisplayState.FULL_SCREEN;
trace("displayState", stage.displayState);

stage.showWindow(720, 480, "Stage 41 Fullscreen");
trace("window closed");
