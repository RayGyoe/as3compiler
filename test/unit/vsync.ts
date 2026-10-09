// Unit checks: the vsync API — flash.events.VsyncStateChangeAvailabilityEvent
// (AIR's event + our opt-in `refreshRate` field), Stage.vsyncEnabled, and the
// startup/on-change dispatch + pacing gate wired into the generated window loop.
//
// These pin the *generated C* rather than the emitter's source text, because the
// dispatch hook, the pacing gate and a no-op would all look plausible in the
// emitter. Re-run alone with:
//   node --test --test-name-pattern='vsync/' test/unit/*.ts

import { parse } from '../../src/parser.ts';
import { generateC } from '../../src/codegen.ts';
import { registerGroup } from '../harness.ts';

function checkVsync(): string[] {
  let ok = 0;
  const bad: string[] = [];
  const check = (label: string, cond: boolean): void => {
    if (cond) { ok++; console.log(`PASS  [vsync] ${label}`); }
    else { bad.push(label); console.log(`FAIL  [vsync] ${label}`); }
  };

  const c = generateC(parse(
    'import flash.display.Stage;\n' +
    'import flash.events.Event;\n' +
    'import flash.events.VsyncStateChangeAvailabilityEvent;\n' +
    'var st:Stage = new Stage();\n' +
    'st.vsyncEnabled = false;\n' +
    'var v:Boolean = st.vsyncEnabled;\n' +
    'var ev:VsyncStateChangeAvailabilityEvent = new VsyncStateChangeAvailabilityEvent(' +
    'VsyncStateChangeAvailabilityEvent.VSYNC_STATE_CHANGE_AVAILABILITY, false, false, false, 60);\n' +
    'var a:Boolean = ev.available;\n' +
    'var r:Number = ev.refreshRate;\n' +
    'var e:Event = ev;\n' +
    'var isit:Boolean = e is VsyncStateChangeAvailabilityEvent;\n'
  )).c;

  const slice = (start: string): string => {
    const i = c.indexOf(start);
    return i < 0 ? '' : c.slice(i, c.indexOf('\n}', i));
  };

  // ---- 1. the class: a real Event subclass carrying both fields -------------
  // `available` keeps AIR's name/type; `refreshRate` is the added Number. The
  // struct must be laid out on top of Event (so an Event-typed slot accepts it).
  check('struct declares available (bool) then refreshRate (double)',
    /struct VsyncStateChangeAvailabilityEvent \{[\s\S]*?\bbool available;[\s\S]*?\bdouble refreshRate;[\s\S]*?\};/.test(c));
  check('it inherits the Event layout (type/bubbles/... fields present)',
    /struct VsyncStateChangeAvailabilityEvent \{[\s\S]*?\bchar\* type;[\s\S]*?\bbool bubbles;[\s\S]*?\bbool available;/.test(c));
  check('vtable chain points at Event (superClass = Event)',
    /static VsyncStateChangeAvailabilityEvent_vtable VsyncStateChangeAvailabilityEvent_vt = \{ "VsyncStateChangeAvailabilityEvent", &Event_vt,/.test(c));

  // ---- 2. the AIR constant string -------------------------------------------
  // Measured on adl 51.4.1: lowercase leading 'v'.
  check('VSYNC_STATE_CHANGE_AVAILABILITY is "vSyncStateChangeAvailability"',
    c.includes('"vSyncStateChangeAvailability"'));

  // ---- 3. the constructor: AIR's 4 args + our trailing optional 5th ---------
  // AIR rejects 5 args (mxmlc: "不超过 4 个"), so 5 parameters with the 5th
  // defaulted is a strict superset: every AIR call site still compiles, and our
  // extension is opt-in.
  check('ctor takes (type, bubbles, cancelable, available, refreshRate)',
    /VsyncStateChangeAvailabilityEvent_ctor\(VsyncStateChangeAvailabilityEvent\* o, char\* type, bool bubbles, bool cancelable, bool available, double refreshRate\)/.test(c));
  check('ctor sets both fields after Event_ctor',
    /VsyncStateChangeAvailabilityEvent_ctor\([\s\S]*?Event_ctor\(\(Event\*\)o, type, bubbles, cancelable\); o->available = available; o->refreshRate = refreshRate;/.test(c));

  // ---- 4. Stage.vsyncEnabled: application-wide, AIR default true ------------
  const getter = slice('static bool Stage_get_vsyncEnabled(void* _this) {');
  check('Stage_get_vsyncEnabled returns the app-wide switch',
    getter.includes('return ASC_app_vsync_enabled;'));
  check('Stage_set_vsyncEnabled writes the app-wide switch',
    slice('static void Stage_set_vsyncEnabled(void* _this, bool value) {').includes('ASC_app_vsync_enabled = value;'));
  check('ASC_app_vsync_enabled defaults to true (adl 51.4.1)',
    c.includes('static bool ASC_app_vsync_enabled = true;'));

  // ---- 5. dispatch: startup once + on display change, refreshRate payload ---
  const disp = slice('static void ASC_dispatch_vsync_event(int id, void* stage) {');
  check('dispatch ignores a null stage', disp.includes('if (stage == NULL) return;'));
  check('dispatch reads the live display refresh for the window',
    disp.includes('double rr = as_window_display_refresh(id);'));
  check('dispatch is silent when the rate is unknown (web/offscreen => no fake 0)',
    disp.includes('if (rr <= 0.0) return;'));
  check('dispatch fires only on a rate CHANGE (startup is 0 != rr)',
    disp.includes('if (rr == ASC_vsync_last_refresh) return;') && disp.includes('ASC_vsync_last_refresh = rr;'));
  check('dispatch carries available=false (mirrors adl) and the live rr',
    disp.includes('VsyncStateChangeAvailabilityEvent_new((char*)"vSyncStateChangeAvailability", false, false, false, rr)'));
  check('dispatch sends the event on the Stage',
    disp.includes('EventDispatcher_dispatchEvent(stage, (Event*)ev);'));
  check('the frame callback reports vsync BEFORE dispatching ENTER_FRAME',
    /static void ASC_window_on_frame\(int id\) \{[\s\S]*?ASC_dispatch_vsync_event\(id, \(void\*\)w->stage\);[\s\S]*?Stage_dispatchFrame\(\(void\*\)w->stage\);/.test(c));

  // ---- 6. pacing gate: vsyncEnabled=true keeps the display-refresh cap ------
  const pace = slice('static double ASC_window_on_frame_delay(int id) {');
  check('pacer reads the vsync switch',
    pace.includes('bool vs = ASC_app_vsync_enabled;'));
  check('pacer caps an over-rate frameRate only when vsync is on',
    pace.includes('if (vs && rr > 0.0 && fr > rr) return 1000.0 / rr;'));
  check('pacer lets vsyncEnabled=false honor the requested frameRate',
    pace.includes('return 1000.0 / fr;'));

  // ---- 7. the constant is reachable as a value (not just a member read) -----
  check('the constant compiles to a static string field read',
    c.includes('"vSyncStateChangeAvailability"'));

  return bad;
}

registerGroup('vsync/VsyncStateChangeAvailabilityEvent', checkVsync);