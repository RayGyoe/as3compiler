// flash.system.IME / IMEConversionMode / flash.events.IMEEvent (TODO 遗留 L8148, L8149).
//
// AIR's class reference fixes the shape; the measured behavior is recorded on the
// classMap entries in src/symbols.ts (macOS 51.4.1 baseline in one column, the
// Windows 51.3.2 probe temp/imeprobe in the other). What this example pins:
//   * IMEConversionMode exposes exactly the 8 documented mode strings;
//   * IME.isSupported is true, IME.enabled is a writable bool, IME.conversionMode
//     starts at "UNKNOWN";
//   * the conversionMode setter takes the settable modes, rejects null with #2007 and
//     anything outside the vocabulary (incl. "UNKNOWN") with #2063;
//   * the operating methods need a FOCUSED EDITABLE field: without one they throw
//     #2063 (the macOS baseline), with one they drive our marked-text preview —
//     setCompositionString previews, doConversion commits it as the textInput
//     payload, compositionSelectionChanged re-selects inside it, and
//     compositionAbandoned drops it without throwing;
//   * `new IME()` is Error #2012;
//   * IMEEvent is a TextEvent subclass with the two type constants, an empty-string
//     `text` default and an `imeClient` slot.
import flash.display.Sprite;
import flash.display.Stage;
import flash.text.TextField;
import flash.text.TextFieldType;
import flash.events.TextEvent;
import flash.events.IMEEvent;
import flash.system.IME;
import flash.system.IMEConversionMode;

var stage3:Stage = new Stage();
var tf:TextField = new TextField();
tf.type = TextFieldType.INPUT;
tf.multiline = true;
tf.width = 200;
tf.height = 60;
stage3.addChild(tf);

var fails:int = 0;
function check(label:String, cond:Boolean):void {
  if (cond) { trace("PASS  " + label); } else { trace("FAIL  " + label); fails++; }
}

// ---- the constant table -----------------------------------------------------
check("IMEConversionMode.ALPHANUMERIC_FULL", "ALPHANUMERIC_FULL" == IMEConversionMode.ALPHANUMERIC_FULL);
check("IMEConversionMode.ALPHANUMERIC_HALF", "ALPHANUMERIC_HALF" == IMEConversionMode.ALPHANUMERIC_HALF);
check("IMEConversionMode.CHINESE", "CHINESE" == IMEConversionMode.CHINESE);
check("IMEConversionMode.JAPANESE_HIRAGANA", "JAPANESE_HIRAGANA" == IMEConversionMode.JAPANESE_HIRAGANA);
check("IMEConversionMode.JAPANESE_KATAKANA_FULL", "JAPANESE_KATAKANA_FULL" == IMEConversionMode.JAPANESE_KATAKANA_FULL);
check("IMEConversionMode.JAPANESE_KATAKANA_HALF", "JAPANESE_KATAKANA_HALF" == IMEConversionMode.JAPANESE_KATAKANA_HALF);
check("IMEConversionMode.KOREAN", "KOREAN" == IMEConversionMode.KOREAN);
check("IMEConversionMode.UNKNOWN", "UNKNOWN" == IMEConversionMode.UNKNOWN);

// ---- the static properties --------------------------------------------------
check("isSupported is true on a desktop target", true == IME.isSupported);
check("enabled starts true", true == IME.enabled);
check("conversionMode starts UNKNOWN", "UNKNOWN" == IME.conversionMode);
IME.enabled = false;
check("enabled is writable", false == IME.enabled);
IME.enabled = true;

// ---- the conversionMode setter ---------------------------------------------
var vName:String = "CHINESE";
IME.conversionMode = vName;
check("a settable mode is stored", "CHINESE" == IME.conversionMode);
var idNull:int = 0;
var idUnknown:int = 0;
try { IME.conversionMode = null; } catch (e:Error) { idNull = e.errorID; }
try { IME.conversionMode = "UNKNOWN"; } catch (e:Error) { idUnknown = e.errorID; }
try { IME.conversionMode = "NOT_A_MODE"; } catch (e:Error) { idUnknown = idUnknown + 0; }
check("null mode is #2007", 2007 == idNull);
check("UNKNOWN (read-only) is #2063", 2063 == idUnknown);
check("a rejected mode leaves the stored one alone", "CHINESE" == IME.conversionMode);

// ---- the operating methods, with nothing focused ----------------------------
var idComp:int = 0;
var idConv:int = 0;
var idSel:int = 0;
var abandonedThrew:Boolean = false;
try { IME.setCompositionString("nihao"); } catch (e:Error) { idComp = e.errorID; }
try { IME.doConversion(); } catch (e:Error) { idConv = e.errorID; }
try { IME.compositionSelectionChanged(1, 3); } catch (e:Error) { idSel = e.errorID; }
try { IME.compositionAbandoned(); } catch (e:Error) { abandonedThrew = true; }
check("setCompositionString with no focused field is #2063", 2063 == idComp);
check("doConversion with no composition is #2063", 2063 == idConv);
check("compositionSelectionChanged with no composition is #2063", 2063 == idSel);
check("compositionAbandoned never throws", !abandonedThrew);

// ---- the same methods with a focused editable field -------------------------
stage3.focus = tf;
var textInputs:int = 0;
var lastPayload:String = "";
tf.addEventListener(TextEvent.TEXT_INPUT, function (ev:TextEvent):void {
  textInputs++;
  lastPayload = ev.text;
});
IME.setCompositionString("nihao");
check("setCompositionString composes nothing into .text", "" == tf.text);
IME.compositionSelectionChanged(2, 4);
IME.compositionAbandoned();
check("compositionAbandoned leaves .text alone too", "" == tf.text);
IME.setCompositionString("nihao");
IME.doConversion();
check("doConversion commits the composition as the textInput payload", "nihao" == lastPayload);
check("and the committed text lands in .text", "nihao" == tf.text);
check("...exactly once", 1 == textInputs);
var idBack:int = 0;
try { IME.doConversion(); } catch (e:Error) { idBack = e.errorID; }
check("a second doConversion has no composition and is #2063", 2063 == idBack);
check("the failed commit inserted nothing", "nihao" == tf.text);

// ---- the shape of the class -------------------------------------------------
var idNew:int = 0;
try { new IME(); } catch (e:Error) { idNew = e.errorID; }
check("new IME() is #2012", 2012 == idNew);

// ---- IMEEvent ---------------------------------------------------------------
check("IMEEvent.IME_COMPOSITION", "imeComposition" == IMEEvent.IME_COMPOSITION);
check("IMEEvent.IME_START_COMPOSITION", "imeStartComposition" == IMEEvent.IME_START_COMPOSITION);
check("IMEEvent inherits TextEvent's constants", "textInput" == TextEvent.TEXT_INPUT);
var ie:IMEEvent = new IMEEvent(IMEEvent.IME_COMPOSITION);
check("a fresh IMEEvent carries an empty text", "" == ie.text);
check("...and defaults to non-bubbling, non-cancelable", false == ie.bubbles && false == ie.cancelable);
var client:Object = {};
ie.imeClient = client;
check("imeClient round-trips", client == ie.imeClient);
var copy:IMEEvent = new IMEEvent(IMEEvent.IME_COMPOSITION, true, true, "ni", client);
check("the 5-arg constructor stores text + imeClient", "ni" == copy.text && client == copy.imeClient);
var got:Boolean = false;
tf.addEventListener(IMEEvent.IME_COMPOSITION, function (ev:IMEEvent):void { got = true; });
tf.dispatchEvent(new IMEEvent(IMEEvent.IME_COMPOSITION, false, false, "ni"));
check("an IMEEvent can be dispatched and listened for", got);

trace(fails == 0 ? "ALL OK" : ("FAILURES " + fails));
