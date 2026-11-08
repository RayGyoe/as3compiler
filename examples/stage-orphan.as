// stage-orphan.as — DisplayObject.stage must be null for any object whose parent
// chain does NOT reach a Stage (measured on adl 51.4.1, temp/leaves/stage):
//   * an orphan (`new Sprite()`) — null
//   * a subtree attached only to a detached parent — null
//   * an on-stage descendant — the Stage
//   * a removed child — null again
// The old code fell back to the root Stage for EVERY unattached object, so an
// orphan wrongly reported a non-null stage. The fallback now applies only to the
// --air-app document class's own instance (its constructor-time `this.stage`),
// which is a separate, document-root-only path not exercised by this plain build.
//
// Compile: as-aot examples/stage-orphan.as --run

import flash.display.Sprite;
import flash.display.Stage;

function check(cond:Boolean, label:String):void {
  if (!cond) throw new Error("FAIL " + label);
}

var stage:Stage = new Stage();

// Orphan: never attached anywhere.
var orphan:Sprite = new Sprite();
check(orphan.stage == null, "orphan.stage is null");

// A child whose only parent is itself detached still has no Stage.
var parent:Sprite = new Sprite();
var child:Sprite = new Sprite();
parent.addChild(child);
check(child.stage == null, "off-tree child.stage is null");
check(parent.stage == null, "detached parent.stage is null");

// Attach the subtree to the Stage: the descendant now reaches it.
stage.addChild(parent);
check(child.stage != null, "on-tree child.stage is non-null");
check(child.stage == stage, "on-tree child.stage is the Stage");
check(parent.stage == stage, "on-tree parent.stage is the Stage");

// Removing the child detaches it again.
parent.removeChild(child);
check(child.stage == null, "removed child.stage is null");

trace("stage-orphan: all ok");
